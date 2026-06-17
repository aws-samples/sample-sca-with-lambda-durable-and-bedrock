import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import * as path from 'path';
import * as fs from 'fs';

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

export interface ScaBackendStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  apiGatewayVpcEndpoint: ec2.IInterfaceVpcEndpoint;
}

/**
 * ScaBackendStack - Backend services for the SCA solution
 * 
 * This stack contains:
 * - Kinesis Stream for transcription ingestion
 * - DynamoDB tables for transcriptions and analytics
 * - Lambda functions for processing
 * - Private API Gateway for data retrieval
 * - Cognito User Pool for authentication
 * - SQS Dead Letter Queue
 * 
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
export class ScaBackendStack extends cdk.Stack {
  public readonly transcriptionsTable: dynamodb.Table;
  public readonly analyticsTable: dynamodb.Table;
  public readonly transcriptionStream: kinesis.Stream;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly cognitoUserPool: cognito.UserPool;
  public readonly cognitoUserPoolClient: cognito.UserPoolClient;
  public readonly dataRetrievalApi: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ScaBackendStackProps) {
    super(scope, id, props);

    // Create CloudWatch Logs role for API Gateway (account-level setting)
    const apiGatewayCloudWatchRole = new iam.Role(this, 'ApiGatewayCloudWatchRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
      ],
    });

    new apigateway.CfnAccount(this, 'ApiGatewayAccount', {
      cloudWatchRoleArn: apiGatewayCloudWatchRole.roleArn,
    });

    // Kinesis Stream for transcription ingestion
    this.transcriptionStream = new kinesis.Stream(this, 'TranscriptionStream', {
      streamName: 'sca-transcription-stream',
      streamMode: kinesis.StreamMode.ON_DEMAND,
      retentionPeriod: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
    });

    // Dead Letter Queue for error handling
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: 'sca-dead-letter-queue',
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.minutes(5),
    });

    // DynamoDB table for transcriptions with streams enabled
    this.transcriptionsTable = new dynamodb.Table(this, 'TranscriptionsTable', {
      tableName: 'sca-transcriptions',
      partitionKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'SK',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
    });

    // Global Secondary Index for additional query patterns
    this.transcriptionsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: {
        name: 'GSI1PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'GSI1SK',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // DynamoDB table for analytics and summaries
    this.analyticsTable = new dynamodb.Table(this, 'AnalyticsTable', {
      tableName: 'sca-analytics',
      partitionKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'SK',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
    });

    // Transcription Processor Lambda Function
    const transcriptionProcessorFunction = new lambda.Function(this, 'TranscriptionProcessor', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/transcription-processor')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          'PowertoolsLayer',
          `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-${config.powertoolsLayer.pythonVersion}-x86_64:${config.powertoolsLayer.version}`
        ),
      ],
      environment: {
        TRANSCRIPTIONS_TABLE: this.transcriptionsTable.tableName,
        DLQ_URL: this.deadLetterQueue.queueUrl,
        POWERTOOLS_SERVICE_NAME: 'transcription-processor',
        POWERTOOLS_METRICS_NAMESPACE: 'SCA',
        LOG_LEVEL: 'INFO',
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant permissions to the Lambda function
    this.transcriptionsTable.grantReadWriteData(transcriptionProcessorFunction);
    this.deadLetterQueue.grantSendMessages(transcriptionProcessorFunction);

    // Add Kinesis event source to Lambda
    transcriptionProcessorFunction.addEventSource(
      new lambdaEventSources.KinesisEventSource(this.transcriptionStream, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(10),
        retryAttempts: 3,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
      })
    );

    // Cognito User Pool for authentication
    this.cognitoUserPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'sca-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
    });

    // Cognito User Pool Client
    this.cognitoUserPoolClient = this.cognitoUserPool.addClient('WebAppClient', {
      userPoolClientName: 'sca-web-app-client',
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      },
    });

    // Cognito User Groups
    new cognito.CfnUserPoolGroup(this, 'AnalystGroup', {
      userPoolId: this.cognitoUserPool.userPoolId,
      groupName: 'Analysts',
      description: 'Contact center analysts who can view and analyze conversations',
      precedence: 1,
    });

    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.cognitoUserPool.userPoolId,
      groupName: 'Administrators',
      description: 'System administrators with full access',
      precedence: 0,
    });

    // Analytics Processor Lambda Function with Durable Execution
    const analyticsProcessorFunction = new lambda.Function(this, 'AnalyticsProcessor', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/analytics-processor')),
      timeout: cdk.Duration.minutes(15),  // Max timeout for Lambda with event source mappings
      memorySize: 1024,
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          'PowertoolsLayerAnalytics',
          `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-${config.powertoolsLayer.pythonVersion}-x86_64:${config.powertoolsLayer.version}`
        ),
      ],
      environment: {
        TRANSCRIPTIONS_TABLE: this.transcriptionsTable.tableName,
        ANALYTICS_TABLE: this.analyticsTable.tableName,
        BEDROCK_MODEL_ID: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        POWERTOOLS_SERVICE_NAME: 'analytics-processor',
        POWERTOOLS_METRICS_NAMESPACE: 'SCA',
        LOG_LEVEL: 'INFO',
      },
      tracing: lambda.Tracing.ACTIVE,
      // Enable durable execution for resilient multi-step Bedrock processing
      // executionTimeout must be ≤15 minutes for event source mappings
      durableConfig: {
        executionTimeout: cdk.Duration.minutes(15),  // Match Lambda timeout for event source compatibility
        retentionPeriod: cdk.Duration.days(7),       // Keep execution history for 7 days
      },
    });

    // Grant permissions to the Analytics Processor Lambda
    this.transcriptionsTable.grantReadData(analyticsProcessorFunction);
    this.analyticsTable.grantReadWriteData(analyticsProcessorFunction);
    
    // Grant Bedrock permissions for AI analytics
    analyticsProcessorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        resources: ['*'],
      })
    );

    // Grant AWS Marketplace permissions for Bedrock model subscriptions
    analyticsProcessorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'aws-marketplace:ViewSubscriptions',
          'aws-marketplace:Subscribe',
        ],
        resources: ['*'],
      })
    );

    // Create alias for durable function - required for event source mappings
    const analyticsProcessorAlias = new lambda.Alias(this, 'AnalyticsProcessorAlias', {
      aliasName: 'live',
      version: analyticsProcessorFunction.latestVersion,
    });

    // Add DynamoDB Streams event source to the alias (durable functions require qualified ARN)
    analyticsProcessorAlias.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.transcriptionsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 3,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('INSERT'),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('MODIFY'),
          }),
        ],
      })
    );

    // Data Retrieval Lambda Function
    const dataRetrievalFunction = new lambda.Function(this, 'DataRetrieval', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/data-retrieval')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          'PowertoolsLayerDataRetrieval',
          `arn:aws:lambda:${this.region}:017000801446:layer:AWSLambdaPowertoolsPythonV3-${config.powertoolsLayer.pythonVersion}-x86_64:${config.powertoolsLayer.version}`
        ),
      ],
      environment: {
        TRANSCRIPTIONS_TABLE: this.transcriptionsTable.tableName,
        ANALYTICS_TABLE: this.analyticsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'data-retrieval',
        POWERTOOLS_METRICS_NAMESPACE: 'SCA',
        LOG_LEVEL: 'INFO',
      },
      tracing: lambda.Tracing.ACTIVE,
    });

    // Grant read permissions to the Data Retrieval Lambda
    this.transcriptionsTable.grantReadData(dataRetrievalFunction);
    this.analyticsTable.grantReadData(dataRetrievalFunction);

    // Create private REST API
    this.dataRetrievalApi = new apigateway.RestApi(this, 'DataRetrievalApi', {
      restApiName: 'sca-data-retrieval-api',
      description: 'Private API for querying contact transcriptions and analytics',
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [props.apiGatewayVpcEndpoint],
      },
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              StringEquals: {
                'aws:SourceVpce': props.apiGatewayVpcEndpoint.vpcEndpointId,
              },
            },
          }),
        ],
      }),
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
        metricsEnabled: true,
      },
    });

    // Add Lambda integration
    const dataRetrievalIntegration = new apigateway.LambdaIntegration(dataRetrievalFunction, {
      proxy: true,
    });

    // Add API Gateway routes
    this.dataRetrievalApi.root.addMethod('ANY', dataRetrievalIntegration);
    this.dataRetrievalApi.root.addProxy({
      defaultIntegration: dataRetrievalIntegration,
      anyMethod: true,
    });

    // ========================================
    // CloudFormation Outputs (NO EXPORTS)
    // ========================================
    
    new cdk.CfnOutput(this, 'TranscriptionStreamName', {
      value: this.transcriptionStream.streamName,
      description: 'Kinesis Stream name for transcription ingestion',
    });

    new cdk.CfnOutput(this, 'TranscriptionStreamArn', {
      value: this.transcriptionStream.streamArn,
      description: 'Kinesis Stream ARN for transcription ingestion',
    });

    new cdk.CfnOutput(this, 'TranscriptionsTableName', {
      value: this.transcriptionsTable.tableName,
      description: 'DynamoDB table name for transcriptions',
    });

    new cdk.CfnOutput(this, 'AnalyticsTableName', {
      value: this.analyticsTable.tableName,
      description: 'DynamoDB table name for analytics',
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'SQS Dead Letter Queue URL',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.cognitoUserPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.cognitoUserPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'DataRetrievalApiId', {
      value: this.dataRetrievalApi.restApiId,
      description: 'Private API Gateway ID for data retrieval',
    });

    new cdk.CfnOutput(this, 'DataRetrievalApiEndpoint', {
      value: this.dataRetrievalApi.url,
      description: 'Private API Gateway endpoint for data retrieval',
    });

    new cdk.CfnOutput(this, 'DataRetrievalApiVpcEndpoint', {
      value: `https://${this.dataRetrievalApi.restApiId}-${props.apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com/prod/`,
      description: 'Private API Gateway endpoint with VPC endpoint ID (use this for nginx proxy)',
    });

    new cdk.CfnOutput(this, 'CreateUserCommand', {
      value: `./scripts/setup-test-user.sh <email> Analysts`,
      description: 'Command to create a new Cognito user',
    });

    // ========================================
    // CDK Nag Suppressions
    // ========================================

    // Suppress wildcard permissions for Lambda CloudWatch Logs
    // Lambda functions require wildcard permissions to create log groups and streams
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/ScaBackendStack/TranscriptionProcessor/ServiceRole/DefaultPolicy/Resource',
        '/ScaBackendStack/AnalyticsProcessor/ServiceRole/DefaultPolicy/Resource',
        '/ScaBackendStack/DataRetrieval/ServiceRole/DefaultPolicy/Resource',
      ],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Lambda functions require wildcard permissions for CloudWatch Logs. ' +
                  'The logs:CreateLogGroup, logs:CreateLogStream, and logs:PutLogEvents actions ' +
                  'require Resource: "*" as log group names are generated at runtime. ' +
                  'See: https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs.html',
          appliesTo: ['Resource::*'],
        },
      ]
    );

    // Suppress wildcard permissions for DynamoDB GSI access
    // DynamoDB table policies require wildcard for GSI access patterns
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/ScaBackendStack/TranscriptionProcessor/ServiceRole/DefaultPolicy/Resource',
        '/ScaBackendStack/AnalyticsProcessor/ServiceRole/DefaultPolicy/Resource',
        '/ScaBackendStack/DataRetrieval/ServiceRole/DefaultPolicy/Resource',
      ],
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'DynamoDB table access requires wildcard for Global Secondary Index (GSI) operations. ' +
                  'The pattern <TableArn>/index/* is required to access all GSIs on the table. ' +
                  'See: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/iam-policy-specific-table-indexes.html',
          appliesTo: [
            'Resource::<TranscriptionsTableE617CB71.Arn>/index/*',
            'Resource::<AnalyticsTable0B3C8B0C.Arn>/index/*',
          ],
        },
      ]
    );

    // Suppress AWS managed policy usage for Lambda execution roles
    // These are standard AWS managed policies designed for Lambda functions
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/ScaBackendStack/TranscriptionProcessor/ServiceRole/Resource',
        '/ScaBackendStack/DataRetrieval/ServiceRole/Resource',
      ],
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the AWS recommended managed policy for Lambda functions. ' +
                  'It provides minimal permissions for CloudWatch Logs access. ' +
                  'See: https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
        },
      ]
    );

    // Suppress AWS managed policy for Lambda Durable Execution
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/AnalyticsProcessor/ServiceRole/Resource',
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicDurableExecutionRolePolicy is required for Lambda Durable Execution. ' +
                  'This AWS managed policy provides necessary permissions for durable state management. ' +
                  'See: https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicDurableExecutionRolePolicy'],
        },
      ]
    );

    // Suppress Lambda runtime version check - Python 3.13 is the latest
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/ScaBackendStack/TranscriptionProcessor/Resource',
        '/ScaBackendStack/AnalyticsProcessor/Resource',
        '/ScaBackendStack/DataRetrieval/Resource',
      ],
      [
        {
          id: 'AwsSolutions-L1',
          reason: 'Lambda functions are using Python 3.13, which is the latest available runtime version. ' +
                  'See: https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html',
        },
      ]
    );

    // Suppress API Gateway managed policy
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/ApiGatewayCloudWatchRole/Resource',
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AmazonAPIGatewayPushToCloudWatchLogs is the AWS recommended managed policy for API Gateway logging. ' +
                  'See: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-logging.html',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs'],
        },
      ]
    );

    // Suppress DLQ not having a DLQ - this IS the DLQ
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/DeadLetterQueue/Resource',
      [
        {
          id: 'AwsSolutions-SQS3',
          reason: 'This queue IS the Dead Letter Queue for Lambda functions. ' +
                  'DLQs themselves do not require a DLQ as they are the final destination for failed messages.',
        },
      ]
    );

    // Suppress Kinesis KMS key warning
    // Using AWS managed key (aws/kinesis) is cost-effective for this use case
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/TranscriptionStream/Resource',
      [
        {
          id: 'AwsSolutions-KDS3',
          reason: 'Using AWS managed key (aws/kinesis) for server-side encryption to optimize costs. ' +
                  'Customer Managed Keys incur additional costs that scale with consumers/producers. ' +
                  'For compliance requirements, consider using CMK.',
        },
      ]
    );

    // Suppress SQS SSL requirement
    // Adding SSL-only policy to DLQ
    const dlqPolicy = new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['sqs:*'],
      resources: [this.deadLetterQueue.queueArn],
      conditions: {
        Bool: {
          'aws:SecureTransport': 'false',
        },
      },
    });
    this.deadLetterQueue.addToResourcePolicy(dlqPolicy);

    // Suppress Cognito MFA warning
    // MFA is optional for this solution to simplify user experience
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/UserPool/Resource',
      [
        {
          id: 'AwsSolutions-COG2',
          reason: 'MFA is not required for this solution to simplify user experience. ' +
                  'For production deployments with sensitive data, enable MFA for additional security.',
        },
      ]
    );

    // Suppress Cognito Advanced Security Mode
    // Advanced security features require additional configuration and cost
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/UserPool/Resource',
      [
        {
          id: 'AwsSolutions-COG3',
          reason: 'Advanced Security Mode is not enabled to reduce costs for this solution. ' +
                  'For production deployments, enable ENFORCED mode for malicious sign-in detection.',
        },
      ]
    );

    // Suppress Cognito Plus tier requirement
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/UserPool/Resource',
      [
        {
          id: 'AwsSolutions-COG8',
          reason: 'Plus tier is not required for this solution. ' +
                  'For production deployments with sensitive data, consider enabling Plus tier for advanced security features.',
        },
      ]
    );

    // Suppress API Gateway request validation
    // Request validation is handled by Lambda function
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/DataRetrievalApi/Resource',
      [
        {
          id: 'AwsSolutions-APIG2',
          reason: 'Request validation is performed by the Lambda function backend. ' +
                  'The Lambda function validates all inputs before processing.',
        },
      ]
    );

    // Suppress API Gateway access logging
    // Access logging adds operational overhead for private API
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/DataRetrievalApi/DeploymentStage.prod/Resource',
      [
        {
          id: 'AwsSolutions-APIG1',
          reason: 'Access logging is not enabled for this private API to reduce operational overhead. ' +
                  'For production deployments, enable access logs for audit and troubleshooting.',
        },
      ]
    );

    // Suppress API Gateway WAF requirement
    // WAF is not needed for private API that is only accessible from VPC
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaBackendStack/DataRetrievalApi/DeploymentStage.prod/Resource',
      [
        {
          id: 'AwsSolutions-APIG3',
          reason: 'AWS WAF is not required for this private API. ' +
                  'The API is only accessible from within the VPC via VPC endpoint, not from the internet. ' +
                  'Network-level security is enforced through security groups and VPC endpoint policies.',
        },
      ]
    );

    // Suppress API Gateway authorization warnings
    // This is a private API with VPC endpoint policy enforcement
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/ScaBackendStack/DataRetrievalApi/Default/ANY/Resource',
        '/ScaBackendStack/DataRetrievalApi/Default/{proxy+}/ANY/Resource',
      ],
      [
        {
          id: 'AwsSolutions-APIG4',
          reason: 'This is a private API accessible only from within the VPC via VPC endpoint. ' +
                  'Access is controlled by VPC endpoint policy that restricts to specific VPC endpoint. ' +
                  'Additional authorization can be added using Cognito or IAM if needed.',
        },
        {
          id: 'AwsSolutions-COG4',
          reason: 'This is a private API accessible only from within the VPC via VPC endpoint. ' +
                  'Access is controlled by VPC endpoint policy. ' +
                  'Cognito authorization is handled at the web application layer.',
        },
      ]
    );
  }
}
