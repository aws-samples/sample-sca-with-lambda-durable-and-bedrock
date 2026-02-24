#!/bin/bash

# Script to trigger Cognito temporary password email for test user
# Usage: ./scripts/setup-test-user.sh <email>

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Cognito Test User Setup ===${NC}"
echo ""

# Check if email is provided
if [ -z "$1" ]; then
  echo -e "${RED}Error: Email address is required${NC}"
  echo "Usage: ./scripts/setup-test-user.sh <email>"
  exit 1
fi

EMAIL="$1"

# Validate email format
if ! echo "$EMAIL" | grep -qE '^[^@]+@[^@]+\.[^@]+$'; then
  echo -e "${RED}Error: Invalid email format${NC}"
  exit 1
fi

# Get the stack name (default to ScaBackendStack)
STACK_NAME="${STACK_NAME:-ScaBackendStack}"

# Get User Pool ID from CloudFormation outputs
echo -e "${YELLOW}Fetching User Pool ID from CloudFormation...${NC}"
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text)

if [ -z "$USER_POOL_ID" ]; then
  echo -e "${RED}Error: Could not find User Pool ID in stack outputs${NC}"
  echo "Make sure the stack '$STACK_NAME' is deployed"
  exit 1
fi

echo -e "${GREEN}User Pool ID: $USER_POOL_ID${NC}"

# Use email as username
TEST_USERNAME="$EMAIL"

echo -e "${GREEN}Username: $TEST_USERNAME${NC}"
echo ""

# Create user and send temporary password via email
echo -e "${YELLOW}Creating user and sending temporary password to $EMAIL...${NC}"
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "$TEST_USERNAME" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL

if [ $? -eq 0 ]; then
  echo ""
  echo -e "${GREEN}✓ User created and temporary password sent successfully!${NC}"
  echo ""
  
  # Add user to Analysts group
  echo -e "${YELLOW}Adding user to Analysts group...${NC}"
  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$USER_POOL_ID" \
    --username "$TEST_USERNAME" \
    --group-name "Analysts"
  
  echo ""
  echo -e "${GREEN}Test user credentials:${NC}"
  echo -e "  Email: $EMAIL"
  echo -e "  Username: $TEST_USERNAME"
  echo -e "  Group: Analysts"
  echo -e "  Password: Check email for temporary password"
  echo ""
  echo -e "${YELLOW}You will be prompted to change the password on first login.${NC}"
else
  echo -e "${RED}Error: Failed to create user or send temporary password${NC}"
  exit 1
fi
