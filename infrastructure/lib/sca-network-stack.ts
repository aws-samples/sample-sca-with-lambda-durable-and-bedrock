import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

/**
 * ScaNetworkStack - Network infrastructure for the SCA solution
 * 
 * This stack contains:
 * - VPC with private isolated subnets
 * - VPC endpoints for AWS services (S3, ECR, CloudWatch Logs, API Gateway)
 * 
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
export class ScaNetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly apiGatewayVpcEndpoint: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with only private subnets (no NAT Gateway, no public subnets)
    this.vpc = new ec2.Vpc(this, 'ScaVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    
    // Lock logical ID to prevent breaking changes
    (this.vpc.node.defaultChild as ec2.CfnVPC).overrideLogicalId('ScaVpcF197898D');

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

    // API Gateway VPC Endpoint (for private API access)
    this.apiGatewayVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGatewayVpcEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ========================================
    // CloudFormation Outputs (NO EXPORTS)
    // ========================================
    
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID for the SCA solution',
    });

    new cdk.CfnOutput(this, 'ApiGatewayVpcEndpointId', {
      value: this.apiGatewayVpcEndpoint.vpcEndpointId,
      description: 'VPC Endpoint ID for API Gateway',
    });

    // ========================================
    // CDK Nag Suppressions
    // ========================================

    // Suppress VPC Flow Logs requirement
    // Flow logs add operational overhead and cost for a development/demo solution
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaNetworkStack/ScaVpc/Resource',
      [
        {
          id: 'AwsSolutions-VPC7',
          reason: 'VPC Flow Logs are not enabled to reduce operational overhead and costs for this solution. ' +
                  'For production deployments, enable Flow Logs for network troubleshooting and security analysis.',
        },
      ]
    );

    // Suppress VPC Endpoint security group validation failures
    // These are technical limitations with CDK Nag when using intrinsic functions
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      [
        '/ScaNetworkStack/EcrApiVpcEndpoint/SecurityGroup/Resource',
        '/ScaNetworkStack/EcrDkrVpcEndpoint/SecurityGroup/Resource',
        '/ScaNetworkStack/CloudWatchLogsVpcEndpoint/SecurityGroup/Resource',
        '/ScaNetworkStack/ApiGatewayVpcEndpoint/SecurityGroup/Resource',
      ],
      [
        {
          id: 'CdkNagValidationFailure',
          reason: 'Security group rules reference VPC CIDR block using Fn::GetAtt intrinsic function. ' +
                  'CDK Nag cannot validate rules with intrinsic functions at synthesis time. ' +
                  'The security groups correctly restrict access to VPC CIDR range.',
        },
      ]
    );
  }
}
