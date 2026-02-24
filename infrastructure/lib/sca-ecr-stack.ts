import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/**
 * ScaEcrStack - ECR repository for the SCA web application
 * 
 * This stack contains:
 * - ECR repository for container images
 * 
 * This stack is deployed first, before the web app stack, so that
 * we can build and push the Docker image before deploying ECS.
 * 
 * Resources are exposed via public readonly properties for use by other stacks.
 * NO CloudFormation exports are used to avoid cross-stack dependencies.
 */
export class ScaEcrStack extends cdk.Stack {
  public readonly ecrRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ECR Repository for web application images
    this.ecrRepository = new ecr.Repository(this, 'WebAppRepository', {
      repositoryName: 'sca-web-app',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development
      emptyOnDelete: true, // Automatically delete images when repository is deleted
      imageScanOnPush: true, // Scan images for vulnerabilities
    });

    // ========================================
    // CloudFormation Outputs (NO EXPORTS)
    // ========================================
    
    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: 'ECR repository URI for web application images',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryName', {
      value: this.ecrRepository.repositoryName,
      description: 'ECR repository name',
    });

    new cdk.CfnOutput(this, 'BuildAndPushCommand', {
      value: `./scripts/deploy-container.sh`,
      description: 'Command to build and push Docker image to ECR',
    });
  }
}
