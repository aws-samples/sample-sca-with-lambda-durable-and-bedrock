#!/bin/bash
# Script to build and deploy React application container to ECR

set -e

# Default values
REGION="${1:-us-east-1}"
IMAGE_TAG="${2:-latest}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m' # No Color

echo -e "${CYAN}========================================"
echo -e "SCA Container Deployment Script"
echo -e "========================================${NC}"
echo ""

# Get AWS account ID
echo -e "${YELLOW}Getting AWS account ID...${NC}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to get AWS account ID. Make sure AWS CLI is configured.${NC}"
    exit 1
fi
echo -e "${GREEN}Account ID: $ACCOUNT_ID${NC}"

# Get ECR repository URI from CDK outputs
echo ""
echo -e "${YELLOW}Getting ECR repository URI from CDK stack...${NC}"
ECR_URI=$(aws cloudformation describe-stacks \
    --stack-name ScaEcrStack \
    --query "Stacks[0].Outputs[?OutputKey=='EcrRepositoryUri'].OutputValue" \
    --output text \
    --region "$REGION")

if [ $? -ne 0 ] || [ -z "$ECR_URI" ]; then
    echo -e "${RED}Error: Failed to get ECR repository URI. Make sure the ScaEcrStack is deployed.${NC}"
    exit 1
fi
echo -e "${GREEN}ECR Repository: $ECR_URI${NC}"

# Login to ECR
echo ""
echo -e "${YELLOW}Logging in to Amazon ECR...${NC}"
aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to login to ECR.${NC}"
    exit 1
fi
echo -e "${GREEN}Successfully logged in to ECR${NC}"

# Build Docker image
echo ""
echo -e "${YELLOW}Building Docker image...${NC}"
echo -e "${GRAY}This may take a few minutes...${NC}"

# Get Cognito configuration from ScaBackendStack
echo -e "${YELLOW}Fetching Cognito configuration...${NC}"
USER_POOL_ID=$(aws cloudformation describe-stacks \
    --stack-name ScaBackendStack \
    --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
    --output text \
    --region "$REGION" 2>/dev/null)

USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks \
    --stack-name ScaBackendStack \
    --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
    --output text \
    --region "$REGION" 2>/dev/null)

API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name ScaBackendStack \
    --query "Stacks[0].Outputs[?OutputKey=='DataRetrievalApiEndpoint'].OutputValue" \
    --output text \
    --region "$REGION" 2>/dev/null)

if [ -n "$USER_POOL_ID" ] && [ -n "$USER_POOL_CLIENT_ID" ]; then
    echo -e "${GREEN}Building with Cognito configuration${NC}"
    cd frontend
    docker build \
        --build-arg REACT_APP_USER_POOL_ID="$USER_POOL_ID" \
        --build-arg REACT_APP_USER_POOL_CLIENT_ID="$USER_POOL_CLIENT_ID" \
        --build-arg REACT_APP_API_ENDPOINT="$API_ENDPOINT" \
        --build-arg REACT_APP_AWS_REGION="$REGION" \
        -t "sca-web-app:$IMAGE_TAG" .
else
    echo -e "${YELLOW}Warning: Cognito configuration not found, building without it${NC}"
    cd frontend
    docker build -t "sca-web-app:$IMAGE_TAG" .
fi

if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to build Docker image.${NC}"
    cd ..
    exit 1
fi
cd ..
echo -e "${GREEN}Successfully built Docker image${NC}"

# Tag image for ECR
echo ""
echo -e "${YELLOW}Tagging image for ECR...${NC}"
docker tag "sca-web-app:$IMAGE_TAG" "$ECR_URI:$IMAGE_TAG"
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to tag Docker image.${NC}"
    exit 1
fi
echo -e "${GREEN}Successfully tagged image${NC}"

# Push image to ECR
echo ""
echo -e "${YELLOW}Pushing image to ECR...${NC}"
echo -e "${GRAY}This may take a few minutes...${NC}"
docker push "$ECR_URI:$IMAGE_TAG"
if [ $? -ne 0 ]; then
    echo -e "${RED}Error: Failed to push Docker image.${NC}"
    exit 1
fi
echo -e "${GREEN}Successfully pushed image to ECR${NC}"

# Force ECS service update to pull new image (if ScaCoreStack exists)
echo ""
echo -e "${YELLOW}Checking for ECS service...${NC}"
CLUSTER_NAME=$(aws cloudformation describe-stacks \
    --stack-name ScaCoreStack \
    --query "Stacks[0].Outputs[?OutputKey=='EcsClusterName'].OutputValue" \
    --output text \
    --region "$REGION" 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$CLUSTER_NAME" ]; then
    echo -e "${YELLOW}Updating ECS service to use new image...${NC}"
    aws ecs update-service \
        --cluster "$CLUSTER_NAME" \
        --service sca-web-app-service \
        --force-new-deployment \
        --region "$REGION" > /dev/null 2>&1
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Successfully triggered ECS service update${NC}"
    else
        echo -e "${YELLOW}Note: Could not update ECS service automatically${NC}"
    fi
    
    # Get ALB DNS name
    ALB_DNS=$(aws cloudformation describe-stacks \
        --stack-name ScaCoreStack \
        --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" \
        --output text \
        --region "$REGION" 2>/dev/null)
    
    if [ -n "$ALB_DNS" ]; then
        echo -e "${GREEN}ALB DNS: http://$ALB_DNS${NC}"
    fi
else
    echo -e "${GRAY}ScaCoreStack not yet deployed - skipping ECS service update${NC}"
fi

echo ""
echo -e "${CYAN}========================================"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""
echo "Image: $ECR_URI:$IMAGE_TAG"
if [ -n "$CLUSTER_NAME" ]; then
    echo "ECS Cluster: $CLUSTER_NAME"
    echo "Service: sca-web-app-service"
    if [ -n "$ALB_DNS" ]; then
        echo "Application URL: http://$ALB_DNS"
    fi
    echo ""
    echo -e "${GRAY}Note: It may take a few minutes for the ECS service to update and become healthy."
    echo "You can monitor the deployment status in the AWS Console.${NC}"
else
    echo -e "${GRAY}Next step: Deploy ScaCoreStack to run the application${NC}"
fi
echo ""
