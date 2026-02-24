import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface ScaConnectStackProps extends cdk.StackProps {
  /**
   * Optional: Name of the Kinesis Stream for transcription ingestion
   * Defaults to 'sca-transcription-stream'
   */
  transcriptionStreamName?: string;
  
  /**
   * Optional: KMS key for Kinesis Stream encryption
   */
  kinesisKmsKey?: kms.IKey;
  
  /**
   * Optional: Customer queue message to play while waiting
   * Defaults to 'Thank you for calling. An agent will be with you shortly.'
   */
  customerQueueMessage?: string;
}

export class ScaConnectStack extends cdk.Stack {
  public readonly connectInstance: connect.CfnInstance;
  public readonly phoneNumber: connect.CfnPhoneNumber;
  public readonly contactFlow: connect.CfnContactFlow;
  public readonly adminCredentials: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props?: ScaConnectStackProps) {
    super(scope, id, props);

    // Use the stream name from props or default to 'sca-transcription-stream'
    const streamName = props?.transcriptionStreamName ?? 'sca-transcription-stream';
    
    // Use the customer queue message from props or default
    const queueMessage = props?.customerQueueMessage ?? 'Thank you for calling. An agent will be with you shortly.';
    
    // Import the Kinesis Stream using the stream name
    const transcriptionStream = kinesis.Stream.fromStreamAttributes(
      this,
      'ImportedTranscriptionStream',
      {
        streamArn: `arn:aws:kinesis:${this.region}:${this.account}:stream/${streamName}`,
      }
    );

    // 1. Create Connect Instance with Contact Lens enabled
    this.connectInstance = new connect.CfnInstance(this, 'ConnectInstance', {
      identityManagementType: 'CONNECT_MANAGED',
      attributes: {
        inboundCalls: true,
        outboundCalls: true,
        contactLens: true,
        autoResolveBestVoices: true,
        contactflowLogs: true,
      },
      instanceAlias: `sca-connect-${cdk.Stack.of(this).account}`,
    });

    // 2. Look up hours of operation
    const hoursOfOperationLookup = new cr.AwsCustomResource(this, 'HoursOfOperationLookup', {
      onCreate: {
        service: 'Connect',
        action: 'listHoursOfOperations',
        parameters: {
          InstanceId: this.connectInstance.attrId,
        },
        physicalResourceId: cr.PhysicalResourceId.of('HoursOfOperationLookup'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.connectInstance.attrArn],
      }),
    });

    const hoursOfOperationArn = hoursOfOperationLookup.getResponseField('HoursOfOperationSummaryList.0.Arn');

    // 3. Create queue for routing calls to agents
    const queue = new connect.CfnQueue(this, 'AgentQueue', {
      instanceArn: this.connectInstance.attrArn,
      name: 'SCA-Agent-Queue',
      description: 'Queue for routing calls to agents',
      hoursOfOperationArn: hoursOfOperationArn,
    });

    // 4. Create routing profile
    const agentRoutingProfile = new connect.CfnRoutingProfile(this, 'AgentRoutingProfile', {
      instanceArn: this.connectInstance.attrArn,
      name: 'SCA-Agent-Routing-Profile',
      description: 'Routing profile for agents to receive calls from SCA-Agent-Queue',
      defaultOutboundQueueArn: queue.attrQueueArn,
      mediaConcurrencies: [
        {
          channel: 'VOICE',
          concurrency: 1,
        },
      ],
      queueConfigs: [
        {
          queueReference: {
            channel: 'VOICE',
            queueArn: queue.attrQueueArn,
          },
          priority: 1,
          delay: 0,
        },
      ],
    });

    agentRoutingProfile.addDependency(queue);

    // 5. Create main contact flow with queue transfer
    const updateContactFlowFunction = new lambda.Function(this, 'UpdateContactFlowFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      environment: {
        QUEUE_MESSAGE: queueMessage,
        CODE_VERSION: 'v2',
      },
      code: lambda.Code.fromInline(`
import json
import boto3

connect = boto3.client('connect')

def update_main_contact_flow(instance_id, contact_flow_id, queue_id):
    """Update the main inbound contact flow with queue routing"""
    flow_content = {
        "Version": "2019-10-30",
        "StartAction": "SetRecordingAndAnalytics",
        "Actions": [
            {
                "Identifier": "SetRecordingAndAnalytics",
                "Type": "UpdateContactRecordingBehavior",
                "Parameters": {
                    "RecordingBehavior": {
                        "RecordedParticipants": ["Agent", "Customer"]
                    },
                    "AnalyticsBehavior": {
                        "Enabled": "True",
                        "AnalyticsLanguage": "en-US",
                        "ChannelConfiguration": {
                            "Voice": {
                                "AnalyticsModes": ["RealTime"]
                            }
                        }
                    }
                },
                "Transitions": {
                    "NextAction": "WelcomeMessage",
                    "Errors": [],
                    "Conditions": []
                }
            },
            {
                "Identifier": "WelcomeMessage",
                "Type": "MessageParticipant",
                "Parameters": {
                    "Text": "Thank you for calling Acme Insurance. This call will be recorded and analyzed for quality purposes."
                },
                "Transitions": {
                    "NextAction": "SetWorkingQueue",
                    "Errors": [],
                    "Conditions": []
                }
            },
            {
                "Identifier": "SetWorkingQueue",
                "Type": "UpdateContactTargetQueue",
                "Parameters": {
                    "QueueId": queue_id
                },
                "Transitions": {
                    "NextAction": "TransferToQueue",
                    "Errors": [
                        {
                            "NextAction": "EndFlow",
                            "ErrorType": "NoMatchingError"
                        }
                    ],
                    "Conditions": []
                }
            },
            {
                "Identifier": "TransferToQueue",
                "Type": "TransferContactToQueue",
                "Transitions": {
                    "NextAction": "EndFlow",
                    "Errors": [
                        {
                            "NextAction": "EndFlow",
                            "ErrorType": "NoMatchingError"
                        },
                        {
                            "NextAction": "EndFlow",
                            "ErrorType": "QueueAtCapacity"
                        }
                    ],
                    "Conditions": []
                }
            },
            {
                "Identifier": "EndFlow",
                "Type": "DisconnectParticipant",
                "Parameters": {},
                "Transitions": {}
            }
        ]
    }
    
    print(f"Updating main contact flow: {contact_flow_id}")
    response = connect.update_contact_flow_content(
        InstanceId=instance_id,
        ContactFlowId=contact_flow_id,
        Content=json.dumps(flow_content)
    )
    print(f"Main contact flow updated: {response}")
    return response

def update_queue_flow(instance_id, queue_message):
    """Update the Default customer queue flow with custom message"""
    try:
        # Find the "Default customer queue" flow
        flows = connect.list_contact_flows(
            InstanceId=instance_id,
            ContactFlowTypes=['CUSTOMER_QUEUE']
        )
        
        queue_flow = None
        for flow in flows.get('ContactFlowSummaryList', []):
            if flow['Name'] == 'Default customer queue':
                queue_flow = flow
                break
        
        if not queue_flow:
            print("Warning: Default customer queue flow not found, skipping queue message update")
            return None
        
        flow_id = queue_flow['Id']
        print(f"Found Default customer queue flow: {flow_id}")
        
        # Get current flow content
        flow_details = connect.describe_contact_flow(
            InstanceId=instance_id,
            ContactFlowId=flow_id
        )
        
        flow_content = json.loads(flow_details['ContactFlow']['Content'])
        
        # Update the queue message in MessageParticipantIteratively action
        updated = False
        for action in flow_content.get('Actions', []):
            if action.get('Type') == 'MessageParticipantIteratively':
                action_id = action['Identifier']
                if 'Parameters' in action and 'Messages' in action['Parameters']:
                    if len(action['Parameters']['Messages']) > 0:
                        first_message = action['Parameters']['Messages'][0]
                        if 'Text' in first_message:
                            print(f"Updating queue message from '{first_message['Text']}' to '{queue_message}'")
                            action['Parameters']['Messages'][0]['Text'] = queue_message
                            updated = True
                            
                            # Also update metadata if it exists
                            if 'Metadata' in flow_content and 'ActionMetadata' in flow_content['Metadata']:
                                if action_id in flow_content['Metadata']['ActionMetadata']:
                                    action_meta = flow_content['Metadata']['ActionMetadata'][action_id]
                                    if 'audio' in action_meta and len(action_meta['audio']) > 0:
                                        first_audio = action_meta['audio'][0]
                                        if first_audio.get('type') == 'Text' and 'tts' in first_audio:
                                            flow_content['Metadata']['ActionMetadata'][action_id]['audio'][0]['tts'] = queue_message
                            break
        
        if not updated:
            print("Warning: Could not find MessageParticipantIteratively action to update")
            return None
        
        # Update the flow
        response = connect.update_contact_flow_content(
            InstanceId=instance_id,
            ContactFlowId=flow_id,
            Content=json.dumps(flow_content)
        )
        print(f"Queue flow updated: {response}")
        return response
        
    except Exception as e:
        print(f"Warning: Failed to update queue flow: {e}")
        # Don't fail the entire operation if queue flow update fails
        return None

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    request_type = event['RequestType']
    instance_id = event['ResourceProperties']['InstanceId']
    contact_flow_arn = event['ResourceProperties']['ContactFlowArn']
    queue_arn = event['ResourceProperties']['QueueArn']
    queue_message = event['ResourceProperties']['QueueMessage']
    
    contact_flow_id = contact_flow_arn.split('/')[-1]
    queue_id = queue_arn.split('/')[-1]
    
    if request_type == 'Delete':
        return {
            'PhysicalResourceId': f'update-flows-{contact_flow_id}',
            'Data': {'Status': 'Deleted'}
        }
    
    try:
        # Update main contact flow
        update_main_contact_flow(instance_id, contact_flow_id, queue_id)
        
        # Update queue flow message
        update_queue_flow(instance_id, queue_message)
        
        return {
            'PhysicalResourceId': f'update-flows-{contact_flow_id}',
            'Data': {
                'Status': 'Updated',
                'ContactFlowId': contact_flow_id
            }
        }
        
    except Exception as e:
        import traceback
        print(f"Error: {traceback.format_exc()}")
        raise
`),
    });

    // Create a minimal initial flow - the custom resource will update it with queue routing
    const contactFlowDefinition = {
      Version: '2019-10-30',
      StartAction: 'Placeholder',
      Actions: [
        {
          Identifier: 'Placeholder',
          Type: 'MessageParticipant',
          Parameters: {
            Text: 'Initializing...',
          },
          Transitions: {
            NextAction: 'EndFlow',
          },
        },
        {
          Identifier: 'EndFlow',
          Type: 'DisconnectParticipant',
          Parameters: {},
        },
      ],
    };

    this.contactFlow = new connect.CfnContactFlow(this, 'InboundContactFlow', {
      instanceArn: this.connectInstance.attrArn,
      type: 'CONTACT_FLOW',
      content: JSON.stringify(contactFlowDefinition),
      name: 'SCA-Inbound-Test-Flow',
      description: 'Inbound flow with recording, analytics, and agent routing',
    });

    this.contactFlow.addDependency(this.connectInstance);

    updateContactFlowFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'connect:UpdateContactFlowContent',
          'connect:DescribeContactFlow',
          'connect:ListContactFlows',
        ],
        resources: [
          this.contactFlow.attrContactFlowArn,
          // Allow access to all contact flows in the instance for queue flow updates
          `arn:aws:connect:${this.region}:${this.account}:instance/${this.connectInstance.attrId}/contact-flow/*`,
        ],
      })
    );

    const updateContactFlowResource = new cr.AwsCustomResource(this, 'UpdateContactFlowResource', {
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: updateContactFlowFunction.functionName,
          Payload: JSON.stringify({
            RequestType: 'Create',
            ResourceProperties: {
              InstanceId: this.connectInstance.attrId,
              ContactFlowArn: this.contactFlow.attrContactFlowArn,
              QueueArn: queue.attrQueueArn,
              QueueMessage: queueMessage,
            },
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`UpdateContactFlow-v10`),
      },
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: updateContactFlowFunction.functionName,
          Payload: JSON.stringify({
            RequestType: 'Update',
            ResourceProperties: {
              InstanceId: this.connectInstance.attrId,
              ContactFlowArn: this.contactFlow.attrContactFlowArn,
              QueueArn: queue.attrQueueArn,
              QueueMessage: queueMessage,
            },
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(`UpdateContactFlow-v10`),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [updateContactFlowFunction.functionArn],
        }),
      ]),
    });

    updateContactFlowResource.node.addDependency(this.contactFlow);
    updateContactFlowResource.node.addDependency(queue);

    // 7. Provision Phone Number
    this.phoneNumber = new connect.CfnPhoneNumber(this, 'InboundPhoneNumber', {
      targetArn: this.connectInstance.attrArn,
      countryCode: 'US',
      type: 'DID',
      description: 'Phone number for SCA testing',
    });

    this.phoneNumber.addDependency(this.connectInstance);

    // 8. Generate admin password
    const adminPassword = new secretsmanager.Secret(this, 'AdminPassword', {
      generateSecretString: {
        excludePunctuation: true,
        excludeUppercase: false,
        includeSpace: false,
        passwordLength: 16,
        requireEachIncludedType: true,
      },
      description: 'Amazon Connect admin user password',
    });

    // 9. Look up security profiles
    const lookupProfilesFunction = new lambda.Function(this, 'LookupProfilesFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(`
import json
import boto3

connect = boto3.client('connect')

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    request_type = event['RequestType']
    instance_id = event['ResourceProperties']['InstanceId']
    
    if request_type == 'Delete':
        return {
            'PhysicalResourceId': f'profiles-lookup-{instance_id}',
            'Data': {}
        }
    
    try:
        security_profiles = connect.list_security_profiles(InstanceId=instance_id, MaxResults=50)
        admin_profile_arn = next(
            p['Arn'] for p in security_profiles['SecurityProfileSummaryList'] 
            if p['Name'] == 'Admin'
        )
        agent_profile_arn = next(
            p['Arn'] for p in security_profiles['SecurityProfileSummaryList'] 
            if p['Name'] == 'Agent'
        )
        
        return {
            'PhysicalResourceId': f'profiles-lookup-{instance_id}',
            'Data': {
                'AdminSecurityProfileArn': admin_profile_arn,
                'AgentSecurityProfileArn': agent_profile_arn
            }
        }
            
    except Exception as e:
        print(f"Error: {str(e)}")
        raise
`),
    });

    lookupProfilesFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['connect:ListSecurityProfiles'],
      resources: [this.connectInstance.attrArn],
    }));

    const lookupProfilesProvider = new cr.Provider(this, 'LookupProfilesProvider', {
      onEventHandler: lookupProfilesFunction,
    });

    const profilesLookup = new cdk.CustomResource(this, 'ProfilesLookup', {
      serviceToken: lookupProfilesProvider.serviceToken,
      properties: {
        InstanceId: this.connectInstance.attrId,
        Version: '2',
      },
    });

    profilesLookup.node.addDependency(this.connectInstance);

    // 10. Create admin user
    const adminUser = new connect.CfnUser(this, 'ConnectAdminUser', {
      instanceArn: this.connectInstance.attrArn,
      username: 'admin',
      password: adminPassword.secretValue.unsafeUnwrap(),
      identityInfo: {
        firstName: 'SCA',
        lastName: 'Admin',
        email: 'admin@example.com',
      },
      phoneConfig: {
        phoneType: 'SOFT_PHONE',
        autoAccept: false,
        afterContactWorkTimeLimit: 0,
      },
      routingProfileArn: agentRoutingProfile.attrRoutingProfileArn,
      securityProfileArns: [
        profilesLookup.getAttString('AdminSecurityProfileArn'),
        profilesLookup.getAttString('AgentSecurityProfileArn'),
      ],
    });

    adminUser.addDependency(this.connectInstance);
    adminUser.node.addDependency(profilesLookup);
    adminUser.node.addDependency(agentRoutingProfile);

    this.adminCredentials = adminPassword;

    // 11. Configure Contact Lens streaming
    const configureContactLensFunction = new lambda.Function(this, 'ConfigureContactLensFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(`
import json
import boto3

connect = boto3.client('connect')

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    request_type = event['RequestType']
    instance_id = event['ResourceProperties']['InstanceId']
    stream_arn = event['ResourceProperties']['StreamArn']
    
    physical_id = f'contact-lens-config-{instance_id}'
    
    try:
        if request_type == 'Create' or request_type == 'Update':
            try:
                configs = connect.list_instance_storage_configs(
                    InstanceId=instance_id,
                    ResourceType='REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS'
                )
                
                if configs.get('StorageConfigs'):
                    print(f"Contact Lens already configured")
                    return {
                        'PhysicalResourceId': physical_id,
                        'Data': {'Status': 'AlreadyConfigured'}
                    }
            except Exception as e:
                print(f"No existing config: {e}")
            
            response = connect.associate_instance_storage_config(
                InstanceId=instance_id,
                ResourceType='REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS',
                StorageConfig={
                    'StorageType': 'KINESIS_STREAM',
                    'KinesisStreamConfig': {
                        'StreamArn': stream_arn
                    }
                }
            )
            
            print(f"Contact Lens configured: {response}")
            
            return {
                'PhysicalResourceId': physical_id,
                'Data': {
                    'Status': 'Configured',
                    'AssociationId': response.get('AssociationId', '')
                }
            }
            
        elif request_type == 'Delete':
            try:
                configs = connect.list_instance_storage_configs(
                    InstanceId=instance_id,
                    ResourceType='REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS'
                )
                
                for config in configs.get('StorageConfigs', []):
                    connect.disassociate_instance_storage_config(
                        InstanceId=instance_id,
                        AssociationId=config['AssociationId'],
                        ResourceType='REAL_TIME_CONTACT_ANALYSIS_VOICE_SEGMENTS'
                    )
            except Exception as e:
                print(f"Error during cleanup: {e}")
            
            return {
                'PhysicalResourceId': physical_id,
                'Data': {'Status': 'Deleted'}
            }
            
    except Exception as e:
        print(f"Error: {str(e)}")
        raise
`),
    });

    configureContactLensFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'connect:AssociateInstanceStorageConfig',
        'connect:DisassociateInstanceStorageConfig',
        'connect:ListInstanceStorageConfigs',
      ],
      resources: [this.connectInstance.attrArn],
    }));

    configureContactLensFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kinesis:DescribeStream'],
      resources: [transcriptionStream.streamArn],
    }));

    configureContactLensFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PutRolePolicy'],
      resources: ['arn:aws:iam::*:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect*'],
    }));

    const configureContactLensProvider = new cr.Provider(this, 'ConfigureContactLensProvider', {
      onEventHandler: configureContactLensFunction,
    });

    const contactLensConfig = new cdk.CustomResource(this, 'ContactLensConfig', {
      serviceToken: configureContactLensProvider.serviceToken,
      properties: {
        InstanceId: this.connectInstance.attrId,
        StreamArn: transcriptionStream.streamArn,
      },
    });

    contactLensConfig.node.addDependency(this.connectInstance);

    // 12. Associate phone number with contact flow
    const associatePhoneNumberFunction = new lambda.Function(this, 'AssociatePhoneNumberFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(`
import json
import boto3

connect = boto3.client('connect')

def handler(event, context):
    print(f"Event: {json.dumps(event)}")
    
    request_type = event['RequestType']
    instance_id = event['ResourceProperties']['InstanceId']
    phone_number_id = event['ResourceProperties']['PhoneNumberId']
    contact_flow_id = event['ResourceProperties']['ContactFlowId']
    
    physical_id = f'phone-flow-association-{phone_number_id}'
    
    try:
        if request_type == 'Create' or request_type == 'Update':
            response = connect.associate_phone_number_contact_flow(
                PhoneNumberId=phone_number_id,
                InstanceId=instance_id,
                ContactFlowId=contact_flow_id
            )
            
            print(f"Phone number associated: {response}")
            
            return {
                'PhysicalResourceId': physical_id,
                'Data': {'Status': 'Associated'}
            }
            
        elif request_type == 'Delete':
            try:
                response = connect.disassociate_phone_number_contact_flow(
                    PhoneNumberId=phone_number_id,
                    InstanceId=instance_id
                )
                print(f"Phone number disassociated: {response}")
            except Exception as e:
                print(f"Error during cleanup: {e}")
            
            return {
                'PhysicalResourceId': physical_id,
                'Data': {'Status': 'Disassociated'}
            }
            
    except Exception as e:
        print(f"Error: {str(e)}")
        raise
`),
    });

    associatePhoneNumberFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'connect:AssociatePhoneNumberContactFlow',
        'connect:DisassociatePhoneNumberContactFlow',
      ],
      resources: [
        this.phoneNumber.attrPhoneNumberArn,
        this.contactFlow.attrContactFlowArn,
      ],
    }));

    const associatePhoneNumberProvider = new cr.Provider(this, 'AssociatePhoneNumberProvider', {
      onEventHandler: associatePhoneNumberFunction,
    });

    const phoneNumberAssociation = new cdk.CustomResource(this, 'PhoneNumberAssociation', {
      serviceToken: associatePhoneNumberProvider.serviceToken,
      properties: {
        InstanceId: this.connectInstance.attrId,
        PhoneNumberId: this.phoneNumber.attrPhoneNumberArn.split('/').pop(),
        ContactFlowId: this.contactFlow.attrContactFlowArn.split('/').pop(),
      },
    });

    phoneNumberAssociation.node.addDependency(this.phoneNumber);
    phoneNumberAssociation.node.addDependency(this.contactFlow);

    // Outputs
    new cdk.CfnOutput(this, 'ConnectInstanceId', {
      value: this.connectInstance.attrId,
      description: 'Amazon Connect Instance ID',
    });

    new cdk.CfnOutput(this, 'ConnectInstanceArn', {
      value: this.connectInstance.attrArn,
      description: 'Amazon Connect Instance ARN',
    });

    new cdk.CfnOutput(this, 'QueueId', {
      value: queue.attrQueueArn.split('/').pop()!,
      description: 'Queue ID',
    });

    new cdk.CfnOutput(this, 'PhoneNumberE164', {
      value: this.phoneNumber.attrAddress,
      description: 'Phone Number (E.164 format)',
    });

    new cdk.CfnOutput(this, 'ConnectLoginUrl', {
      value: `https://${this.connectInstance.instanceAlias}.my.connect.aws/connect/login`,
      description: 'Amazon Connect login URL',
    });

    new cdk.CfnOutput(this, 'GetCredentialsCommand', {
      value: `aws secretsmanager get-secret-value --secret-id ${adminPassword.secretArn} --query SecretString --output text`,
      description: 'Command to retrieve admin credentials',
    });

    // ========================================
    // CDK Nag Suppressions
    // ========================================

    // Suppress AWS managed policies for all Lambda functions
    // These are CDK custom resource Lambdas that use the standard execution role
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWS managed policy AWSLambdaBasicExecutionRole is appropriate for Lambda functions. ' +
                'This includes CDK custom resource Lambdas that are managed by the CDK framework.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
    ]);

    // Suppress Lambda runtime warnings for CDK custom resources
    // CDK custom resources use nodejs18.x which is managed by CDK
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-L1',
        reason: 'CDK custom resource Lambdas use runtimes managed by the CDK framework. ' +
                'These are internal implementation details and will be updated when CDK updates.',
      },
    ]);

    // Suppress wildcard permissions for custom resource Lambdas
    // These are required for CDK custom resources to function
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permissions are required for CDK custom resource Lambdas to invoke target functions. ' +
                'These are internal CDK framework resources with appropriate scoping.',
        appliesTo: [
          `Resource::<LookupProfilesFunction${lookupProfilesFunction.node.addr}.Arn>:*`,
          `Resource::<ConfigureContactLensFunction${configureContactLensFunction.node.addr}.Arn>:*`,
          `Resource::<AssociatePhoneNumberFunction${associatePhoneNumberFunction.node.addr}.Arn>:*`,
          `Resource::arn:aws:connect:${this.region}:${this.account}:instance/<ConnectInstance.Id>/contact-flow/*`,
          'Resource::arn:aws:iam::*:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect*',
        ],
      },
    ]);

    // Suppress wildcard permissions for UpdateContactFlowFunction
    // Required to update contact flows within the Connect instance
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaConnectStack/UpdateContactFlowFunction/ServiceRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permission required to update contact flows within the Amazon Connect instance. ' +
                  'Scoped to specific instance and contact-flow resource type.',
          appliesTo: [
            `Resource::arn:aws:connect:${this.region}:${this.account}:instance/<ConnectInstance.Id>/contact-flow/*`,
          ],
        },
      ]
    );

    // Suppress wildcard permissions for custom resource provider framework functions
    // CDK Provider framework creates these automatically to invoke the handler functions
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaConnectStack/LookupProfilesProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permission required by CDK Provider framework to invoke the custom resource handler function with versioning support.',
          appliesTo: ['Resource::<LookupProfilesFunction41F7F870.Arn>:*'],
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaConnectStack/ConfigureContactLensProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permission required by CDK Provider framework to invoke the custom resource handler function with versioning support.',
          appliesTo: ['Resource::<ConfigureContactLensFunction7BDE4DF9.Arn>:*'],
        },
      ]
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaConnectStack/AssociatePhoneNumberProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource',
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Wildcard permission required by CDK Provider framework to invoke the custom resource handler function with versioning support.',
          appliesTo: ['Resource::<AssociatePhoneNumberFunctionA35F515B.Arn>:*'],
        },
      ]
    );

    // Suppress Secrets Manager rotation for admin password
    // This is a temporary admin password for initial setup, not a production credential
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      '/ScaConnectStack/AdminPassword/Resource',
      [
        {
          id: 'AwsSolutions-SMG4',
          reason: 'Admin password is a temporary credential for initial Amazon Connect setup. ' +
                  'It should be changed immediately after first login and is not used in production.',
        },
      ]
    );
  }
}
