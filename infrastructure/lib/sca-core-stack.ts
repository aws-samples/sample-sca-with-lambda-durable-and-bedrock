import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import * as path from 'path';

/**
 * ScaCoreStack - Core infrastructure for the Serverless Conversational Analytics solution
 * 
 * CRITICAL DESIGN PRINCIPLE: NO CLOUDFORMATION EXPORTS
 * - This stack exposes resources via public readonly properties (vpc, alb, etc.)
 * - Resources are passed directly to dependent stacks via constructor props
 * - CloudFormation outputs do NOT use 'exportName' to avoid cross-stack dependencies
 * - Logical IDs are locked with overrideLogicalId() to prevent breaking changes
 * 
 * See infrastructure/bin/sca-app.ts for how resources are passed between stacks.
 */
export class ScaCoreStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly transcriptionsTable: dynamodb.Table;
  public readonly analyticsTable: dynamodb.Table;
  public readonly transcriptionStream: kinesis.Stream;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly cognitoUserPool: cognito.UserPool;
  public readonly ecsCluster: ecs.Cluster;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Import ECR repository from ScaEcrStack
    // This repository must exist before deploying this stack
    const ecrRepository = ecr.Repository.fromRepositoryName(
      this,
      'ImportedEcrRepository',
      'sca-web-app'
    );

    // VPC with only private subnets (public subnets added by CloudFront access stack if needed)
    this.vpc = new ec2.Vpc(this, 'ScaVpc', {
      maxAzs: 2,
      natGateways: 0, // No NAT Gateway needed without public subnets
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    
    // Override logical ID to ensure stable CloudFormation exports
    // This prevents breaking changes when code is reorganized
    (this.vpc.node.defaultChild as ec2.CfnVPC).overrideLogicalId('ScaVpcF197898D');

    // Kinesis Stream for transcription ingestion (using L2 construct with on-demand mode)
    this.transcriptionStream = new kinesis.Stream(this, 'TranscriptionStream', {
      streamName: 'sca-transcription-stream',
      streamMode: kinesis.StreamMode.ON_DEMAND,
      retentionPeriod: cdk.Duration.days(7),
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
    // Dependencies are installed locally in the function directory
    const transcriptionProcessorFunction = new lambda.Function(this, 'TranscriptionProcessor', {
      functionName: 'sca-transcription-processor',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/transcription-processor')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
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
    const userPoolClient = this.cognitoUserPool.addClient('WebAppClient', {
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

    // Cognito User Group for analysts
    const analystGroup = new cognito.CfnUserPoolGroup(this, 'AnalystGroup', {
      userPoolId: this.cognitoUserPool.userPoolId,
      groupName: 'Analysts',
      description: 'Contact center analysts who can view and analyze conversations',
      precedence: 1,
    });

    // Cognito User Group for administrators
    const adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.cognitoUserPool.userPoolId,
      groupName: 'Administrators',
      description: 'System administrators with full access',
      precedence: 0,
    });

    // Users can be created via the setup-test-user.sh script
    // Usage: ./scripts/setup-test-user.sh <email> [group-name]

    // ========================================
    // AppSync Events API Setup - REMOVED
    // ========================================
    // AppSync Events cannot be accessed privately without VPC endpoint support
    // Switched to polling-based approach for real-time updates
    
    // ========================================
    // Analytics Processor Lambda Function
    // ========================================
    // Triggered by DynamoDB Streams from Transcriptions table
    const analyticsProcessorFunction = new lambda.Function(this, 'AnalyticsProcessor', {
      functionName: 'sca-analytics-processor',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/analytics-processor')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024, // Higher memory for Bedrock API calls
      environment: {
        TRANSCRIPTIONS_TABLE: this.transcriptionsTable.tableName,
        ANALYTICS_TABLE: this.analyticsTable.tableName,
        POWERTOOLS_SERVICE_NAME: 'analytics-processor',
        POWERTOOLS_METRICS_NAMESPACE: 'SCA',
        LOG_LEVEL: 'INFO',
      },
      tracing: lambda.Tracing.ACTIVE,
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
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
        ],
      })
    );

    // Add DynamoDB Streams event source to Analytics Processor Lambda
    analyticsProcessorFunction.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.transcriptionsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 3,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        filters: [
          // Only process INSERT and MODIFY events
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('INSERT'),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual('MODIFY'),
          }),
        ],
      })
    );

    // ========================================
    // Data Retrieval Lambda Function
    // ========================================
    // Provides REST API for querying transcriptions and analytics
    const dataRetrievalFunction = new lambda.Function(this, 'DataRetrieval', {
      functionName: 'sca-data-retrieval',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../backend/data-retrieval')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
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

    // ========================================
    // VPC Endpoints for Private Connectivity
    // ========================================
    
    // S3 Gateway Endpoint (for ECR image layers - no hourly charge)
    this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // ECR API Endpoint (for ECS to authenticate and get image manifests)
    new ec2.InterfaceVpcEndpoint(this, 'EcrApiVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ECR Docker Endpoint (for ECS to pull Docker images)
    new ec2.InterfaceVpcEndpoint(this, 'EcrDkrVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // CloudWatch Logs Endpoint (for ECS container logging)
    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ========================================
    // Private API Gateway for Data Retrieval
    // ========================================
    // Create VPC Endpoint for API Gateway (required for private API)
    const apiGatewayVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGatewayVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // Create private REST API
    const dataRetrievalApi = new apigateway.RestApi(this, 'DataRetrievalApi', {
      restApiName: 'sca-data-retrieval-api',
      description: 'Private API for querying contact transcriptions and analytics',
      endpointConfiguration: {
        types: [apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [apiGatewayVpcEndpoint],
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
                'aws:SourceVpce': apiGatewayVpcEndpoint.vpcEndpointId,
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
    dataRetrievalApi.root.addMethod('ANY', dataRetrievalIntegration);
    dataRetrievalApi.root.addProxy({
      defaultIntegration: dataRetrievalIntegration,
      anyMethod: true,
    });

    // ECS Cluster in private subnets
    this.ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
      clusterName: 'sca-cluster',
      vpc: this.vpc,
      containerInsights: true,
    });

    // Security group for ALB
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for SCA Application Load Balancer',
      allowAllOutbound: true,
    });

    // Optional: Allow inbound traffic from specific CIDR blocks (only if explicitly configured)
    const allowedCidrBlocks = this.node.tryGetContext('allowedCidrBlocks');
    if (allowedCidrBlocks && Array.isArray(allowedCidrBlocks)) {
      allowedCidrBlocks.forEach((cidr: string) => {
        albSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(80),
          `Allow HTTP from ${cidr}`
        );
        albSecurityGroup.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(443),
          `Allow HTTPS from ${cidr}`
        );
      });
    }

    // Private Application Load Balancer (in isolated subnets)
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'PrivateAlb', {
      vpc: this.vpc,
      internetFacing: false,
      securityGroup: albSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });
    
    // Override logical ID to ensure stable CloudFormation exports
    // This prevents breaking changes when code is reorganized
    (this.alb.node.defaultChild as elbv2.CfnLoadBalancer).overrideLogicalId('PrivateAlbF07A94D5');

    // Security group for ECS tasks
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: this.vpc,
      description: 'Security group for SCA ECS tasks',
      allowAllOutbound: true,
    });

    // Allow ALB to communicate with ECS tasks
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      'Allow ALB to reach ECS tasks'
    );

    // ========================================
    // ECS Task Definition and Service
    // ========================================
    
    // IAM role for ECS task execution (pull images, write logs)
    const taskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Grant ECR pull permissions
    ecrRepository.grantPull(taskExecutionRole);

    // IAM role for ECS task (application permissions)
    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // ECS Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'WebAppTaskDefinition', {
      family: 'sca-web-app',
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: taskExecutionRole,
      taskRole: taskRole,
    });

    // Add container to task definition
    const container = taskDefinition.addContainer('WebAppContainer', {
      containerName: 'sca-web-app',
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'sca-web-app',
        logRetention: 7, // 7 days retention
      }),
      environment: {
        // React build-time environment variables (embedded in JS bundle)
        REACT_APP_USER_POOL_ID: this.cognitoUserPool.userPoolId,
        REACT_APP_USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        REACT_APP_API_ENDPOINT: dataRetrievalApi.url, // Keep for backwards compatibility
        REACT_APP_AWS_REGION: this.region,
        // Nginx runtime environment variable for API proxy - MUST use VPC endpoint format
        API_ENDPOINT: `https://${dataRetrievalApi.restApiId}-${apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com/prod/`,
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
    });

    // Add port mapping
    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
    });

    // ECS Service
    const ecsService = new ecs.FargateService(this, 'WebAppService', {
      serviceName: 'sca-web-app-service',
      cluster: this.ecsCluster,
      taskDefinition: taskDefinition,
      desiredCount: 2, // Run 2 tasks for high availability
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      securityGroups: [ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      enableExecuteCommand: true, // Enable ECS Exec for debugging
      circuitBreaker: {
        rollback: true, // Automatic rollback on deployment failure
      },
    });

    // ALB Target Group for ECS Service
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WebAppTargetGroup', {
      vpc: this.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // Register ECS service with target group
    ecsService.attachToApplicationTargetGroup(targetGroup);

    // ALB Listener (HTTP on port 80)
    // Note: open: false prevents CDK from automatically adding 0.0.0.0/0 ingress rule
    const listener = this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      open: false, // Don't automatically add 0.0.0.0/0 ingress rule
    });

    // Auto-scaling configuration
    const scaling = ecsService.autoScaleTaskCount({
      minCapacity: 2,
      maxCapacity: 10,
    });

    // Scale based on CPU utilization
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Scale based on memory utilization
    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 80,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // ========================================
    // CloudFormation Outputs
    // ========================================
    // CRITICAL: DO NOT add 'exportName' to any outputs!
    // Exports create cross-stack dependencies that prevent stack updates.
    // Resources should be passed directly via stack props instead.
    // See: infrastructure/bin/sca-app.ts for how resources are passed between stacks
    
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID for the SCA solution',
    });

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

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: ecrRepository.repositoryUri,
      description: 'ECR repository URI for web application images (imported from ScaEcrStack)',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.cognitoUserPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'Private ALB DNS name',
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS Cluster name',
    });

    new cdk.CfnOutput(this, 'TranscriptionProcessorFunctionName', {
      value: transcriptionProcessorFunction.functionName,
      description: 'Transcription Processor Lambda function name',
    });

    new cdk.CfnOutput(this, 'TranscriptionProcessorFunctionArn', {
      value: transcriptionProcessorFunction.functionArn,
      description: 'Transcription Processor Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'AnalyticsProcessorFunctionName', {
      value: analyticsProcessorFunction.functionName,
      description: 'Analytics Processor Lambda function name',
    });

    new cdk.CfnOutput(this, 'AnalyticsProcessorFunctionArn', {
      value: analyticsProcessorFunction.functionArn,
      description: 'Analytics Processor Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'DataRetrievalFunctionName', {
      value: dataRetrievalFunction.functionName,
      description: 'Data Retrieval Lambda function name',
    });

    new cdk.CfnOutput(this, 'DataRetrievalFunctionArn', {
      value: dataRetrievalFunction.functionArn,
      description: 'Data Retrieval Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'DataRetrievalApiId', {
      value: dataRetrievalApi.restApiId,
      description: 'Private API Gateway ID for data retrieval',
    });

    new cdk.CfnOutput(this, 'DataRetrievalApiEndpoint', {
      value: dataRetrievalApi.url,
      description: 'Private API Gateway endpoint for data retrieval (standard format)',
    });

    new cdk.CfnOutput(this, 'DataRetrievalApiVpcEndpoint', {
      value: `https://${dataRetrievalApi.restApiId}-${apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com/prod/`,
      description: 'Private API Gateway endpoint with VPC endpoint ID (use this for nginx proxy)',
    });

    new cdk.CfnOutput(this, 'ApiGatewayVpcEndpointId', {
      value: apiGatewayVpcEndpoint.vpcEndpointId,
      description: 'VPC Endpoint ID for API Gateway',
    });

    new cdk.CfnOutput(this, 'AnalystGroupName', {
      value: analystGroup.groupName!,
      description: 'Cognito User Group for analysts',
    });

    new cdk.CfnOutput(this, 'AdminGroupName', {
      value: adminGroup.groupName!,
      description: 'Cognito User Group for administrators',
    });

    new cdk.CfnOutput(this, 'CreateUserCommand', {
      value: `./scripts/setup-test-user.sh <email> Analysts`,
      description: 'Command to create a new Cognito user with temporary password sent via email',
    });
  }
}