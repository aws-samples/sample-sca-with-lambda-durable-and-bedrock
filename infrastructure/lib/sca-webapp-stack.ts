import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface ScaWebAppStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  cognitoUserPool: cognito.IUserPool;
  cognitoUserPoolClient: cognito.IUserPoolClient;
  dataRetrievalApi: apigateway.IRestApi;
  apiGatewayVpcEndpoint: ec2.IInterfaceVpcEndpoint;
  ecrRepository: ecr.IRepository;
}

/**
 * ScaWebAppStack - Web application infrastructure for the SCA solution
 * 
 * This stack contains:
 * - ECS cluster and Fargate service
 * - Application Load Balancer (private)
 * - Auto-scaling configuration
 * 
 * Prerequisites:
 * - ECR repository must exist (created by ScaEcrStack)
 * - Docker image must be pushed to ECR before deploying this stack
 * 
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
export class ScaWebAppStack extends cdk.Stack {
  public readonly ecsCluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ScaWebAppStackProps) {
    super(scope, id, props);

    // ECR Repository for web application images
    this.ecsCluster = new ecs.Cluster(this, 'EcsCluster', {
      clusterName: 'sca-cluster',
      vpc: props.vpc,
      containerInsights: true,
    });

    // Security group for ALB
    this.albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for SCA Application Load Balancer',
      allowAllOutbound: true,
    });

    // Private Application Load Balancer (in isolated subnets)
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'PrivateAlb', {
      vpc: props.vpc,
      internetFacing: false,
      securityGroup: this.albSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });
    
    // Lock logical ID to prevent breaking changes
    (this.alb.node.defaultChild as elbv2.CfnLoadBalancer).overrideLogicalId('PrivateAlbF07A94D5');

    // Security group for ECS tasks
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for SCA ECS tasks',
      allowAllOutbound: true,
    });

    // Allow ALB to communicate with ECS tasks
    ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcp(3000),
      'Allow ALB to reach ECS tasks'
    );

    // IAM role for ECS task execution (pull images, write logs)
    const taskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Grant ECR pull permissions
    props.ecrRepository.grantPull(taskExecutionRole);

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
      image: ecs.ContainerImage.fromEcrRepository(props.ecrRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'sca-web-app',
        logRetention: 7,
      }),
      environment: {
        // React build-time environment variables
        REACT_APP_USER_POOL_ID: props.cognitoUserPool.userPoolId,
        REACT_APP_USER_POOL_CLIENT_ID: props.cognitoUserPoolClient.userPoolClientId,
        REACT_APP_API_ENDPOINT: `https://${props.dataRetrievalApi.restApiId}.execute-api.${this.region}.amazonaws.com/prod/`,
        REACT_APP_AWS_REGION: this.region,
        // Nginx runtime environment variables for API proxy
        API_ENDPOINT: `https://${props.dataRetrievalApi.restApiId}-${props.apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com/prod/`,
        API_HOST: `${props.dataRetrievalApi.restApiId}-${props.apiGatewayVpcEndpoint.vpcEndpointId}.execute-api.${this.region}.amazonaws.com`,
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
      desiredCount: 2,
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      securityGroups: [ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      enableExecuteCommand: true,
      circuitBreaker: {
        rollback: true,
      },
    });

    // ALB Target Group for ECS Service
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WebAppTargetGroup', {
      vpc: props.vpc,
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
    this.alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
      open: false,
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
    // CloudFormation Outputs (NO EXPORTS)
    // ========================================
    
    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'Private ALB DNS name',
    });

    new cdk.CfnOutput(this, 'AlbSecurityGroupId', {
      value: this.albSecurityGroup.securityGroupId,
      description: 'ALB Security Group ID',
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS Cluster name',
    });

    // ========================================
    // CDK Nag Suppressions
    // ========================================

    // Suppress wildcard permissions for ECS Task Execution Role
    // ECS tasks require wildcard permissions for ECR and CloudWatch Logs
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaWebAppStack/EcsTaskExecutionRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'ECS Task Execution Role requires wildcard permissions for: ' +
                  '1) ECR image pull (ecr:GetAuthorizationToken requires Resource: "*") ' +
                  '2) CloudWatch Logs (logs:CreateLogStream and logs:PutLogEvents require wildcard for runtime log group creation) ' +
                  'See: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html',
          appliesTo: ['Resource::*'],
        },
      ]
    );

    // Suppress wildcard permissions for ECS Task Role
    // Task role needs wildcard for CloudWatch Logs and X-Ray tracing
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaWebAppStack/EcsTaskRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'ECS Task Role requires wildcard permissions for CloudWatch Logs and X-Ray tracing. ' +
                  'These services require Resource: "*" for runtime log group and trace segment creation.',
          appliesTo: ['Resource::*'],
        },
      ]
    );

    // Suppress AWS managed policy for ECS Task Execution
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaWebAppStack/EcsTaskExecutionRole/Resource',
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AmazonECSTaskExecutionRolePolicy is the AWS recommended managed policy for ECS task execution. ' +
                  'It provides necessary permissions for ECR image pull and CloudWatch Logs. ' +
                  'See: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy'],
        },
      ]
    );

    // Suppress ECS environment variables warning
    // The environment variables contain non-sensitive configuration (Cognito IDs, API endpoints)
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaWebAppStack/WebAppTaskDefinition/Resource',
      [
        {
          id: 'AwsSolutions-ECS2',
          reason: 'Environment variables contain non-sensitive configuration data: ' +
                  'Cognito User Pool ID, Client ID, AWS Region, and API endpoints. ' +
                  'These are public identifiers and do not require Secrets Manager. ' +
                  'Sensitive data like credentials are managed through IAM roles.',
        },
      ]
    );

    // Suppress ALB access logs requirement
    // Access logs add operational overhead and cost for private ALB
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaWebAppStack/PrivateAlb/Resource',
      [
        {
          id: 'AwsSolutions-ELB2',
          reason: 'ALB access logs are not enabled to reduce operational overhead and costs. ' +
                  'This is a private ALB not exposed to the internet. ' +
                  'For production deployments, enable access logs for traffic analysis and troubleshooting.',
        },
      ]
    );
  }
}
