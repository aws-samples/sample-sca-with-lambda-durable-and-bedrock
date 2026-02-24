"""
AppSync Events Publisher with IAM Authentication

This module provides utilities for publishing events to AWS AppSync Events API
using IAM Signature Version 4 authentication.
"""

import json
import os
from typing import Dict, Any, Optional
from datetime import datetime
from urllib.parse import urlparse

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger, Metrics
from aws_lambda_powertools.metrics import MetricUnit

# Initialize logger and metrics
logger = Logger()
metrics = Metrics()

# Environment variables
APPSYNC_API_ENDPOINT = os.environ.get('APPSYNC_API_ENDPOINT', '')
APPSYNC_CHANNEL_NAMESPACE = os.environ.get('APPSYNC_CHANNEL_NAMESPACE', 'sca-events')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')


class AppSyncEventsError(Exception):
    """Base exception for AppSync Events errors"""
    pass


class AppSyncEventsPublisher:
    """Handles publishing events to AppSync Events API with IAM authentication"""
    
    def __init__(
        self,
        api_endpoint: Optional[str] = None,
        channel_namespace: Optional[str] = None,
        region: Optional[str] = None
    ):
        """
        Initialize AppSync Events Publisher
        
        Args:
            api_endpoint: AppSync Events API endpoint URL
            channel_namespace: Channel namespace for organizing events
            region: AWS region
        """
        self.api_endpoint = api_endpoint or APPSYNC_API_ENDPOINT
        self.channel_namespace = channel_namespace or APPSYNC_CHANNEL_NAMESPACE
        self.region = region or AWS_REGION
        self.logger = logger
        self.metrics = metrics
        
        # Initialize boto3 session for credentials
        self.session = boto3.Session()
        self.credentials = self.session.get_credentials()
        
        if not self.api_endpoint:
            raise AppSyncEventsError("AppSync API endpoint not configured")
    
    def _sign_request(self, request: AWSRequest) -> AWSRequest:
        """
        Sign an AWS request with SigV4 authentication
        
        Args:
            request: AWS request to sign
            
        Returns:
            Signed AWS request
        """
        signer = SigV4Auth(self.credentials, 'appsync', self.region)
        signer.add_auth(request)
        return request
    
    def _build_event_url(self, channel: str) -> str:
        """
        Build the full event URL for a channel
        
        Args:
            channel: Event channel name
            
        Returns:
            Full event URL
        """
        # Remove trailing slash if present
        base_url = self.api_endpoint.rstrip('/')
        
        # Build channel path
        channel_path = f"/event/channels/{self.channel_namespace}/{channel}"
        
        return f"{base_url}{channel_path}"
    
    def publish_event(
        self,
        channel: str,
        event_data: Dict[str, Any],
        event_type: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Publish an event to AppSync Events API
        
        Args:
            channel: Event channel name (e.g., 'contact-updates', 'analytics-updates')
            event_data: Event payload data
            event_type: Optional event type identifier
            
        Returns:
            Response from AppSync Events API
            
        Raises:
            AppSyncEventsError: If publishing fails
        """
        try:
            # Build event URL
            url = self._build_event_url(channel)
            
            # Prepare event payload
            event_payload = {
                'data': event_data,
                'timestamp': datetime.utcnow().isoformat()
            }
            
            if event_type:
                event_payload['eventType'] = event_type
            
            # Create AWS request
            headers = {
                'Content-Type': 'application/json',
            }
            
            request = AWSRequest(
                method='POST',
                url=url,
                data=json.dumps(event_payload),
                headers=headers
            )
            
            # Sign request with IAM credentials
            signed_request = self._sign_request(request)
            
            # Make HTTP request
            import urllib.request
            req = urllib.request.Request(
                url,
                data=signed_request.body.encode('utf-8') if isinstance(signed_request.body, str) else signed_request.body,
                headers=dict(signed_request.headers)
            )
            
            with urllib.request.urlopen(req) as response:
                response_data = response.read().decode('utf-8')
                status_code = response.status
                
                self.logger.info(
                    "Event published successfully",
                    extra={
                        "channel": channel,
                        "eventType": event_type,
                        "statusCode": status_code
                    }
                )
                
                self.metrics.add_metric(
                    name="EventPublished",
                    unit=MetricUnit.Count,
                    value=1
                )
                
                return {
                    'statusCode': status_code,
                    'body': response_data,
                    'success': True
                }
                
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8') if e.fp else 'No error body'
            self.logger.error(
                f"Failed to publish event: HTTP {e.code}",
                extra={
                    "channel": channel,
                    "eventType": event_type,
                    "statusCode": e.code,
                    "error": error_body
                }
            )
            
            self.metrics.add_metric(
                name="EventPublishFailed",
                unit=MetricUnit.Count,
                value=1
            )
            
            raise AppSyncEventsError(f"HTTP {e.code}: {error_body}")
            
        except Exception as e:
            self.logger.error(
                f"Unexpected error publishing event: {str(e)}",
                extra={
                    "channel": channel,
                    "eventType": event_type,
                    "error": str(e)
                },
                exc_info=True
            )
            
            self.metrics.add_metric(
                name="EventPublishError",
                unit=MetricUnit.Count,
                value=1
            )
            
            raise AppSyncEventsError(f"Failed to publish event: {str(e)}")
    
    def publish_contact_update(
        self,
        contact_id: str,
        update_type: str,
        data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Publish a contact update event
        
        Args:
            contact_id: Contact ID
            update_type: Type of update (e.g., 'CREATED', 'UPDATED', 'COMPLETED')
            data: Update data
            
        Returns:
            Response from AppSync Events API
        """
        event_data = {
            'contactId': contact_id,
            'updateType': update_type,
            **data
        }
        
        return self.publish_event(
            channel='contact-updates',
            event_data=event_data,
            event_type='CONTACT_UPDATED'
        )
    
    def publish_analytics_update(
        self,
        contact_id: str,
        analytics_type: str,
        data: Dict[str, Any],
        is_streaming: bool = False,
        is_complete: bool = True
    ) -> Dict[str, Any]:
        """
        Publish an analytics update event
        
        Args:
            contact_id: Contact ID
            analytics_type: Type of analytics (e.g., 'SENTIMENT', 'TOPICS', 'SUMMARY')
            data: Analytics data
            is_streaming: Whether this is a streaming update
            is_complete: Whether the analytics is complete
            
        Returns:
            Response from AppSync Events API
        """
        event_data = {
            'contactId': contact_id,
            'analyticsType': analytics_type,
            'isStreaming': is_streaming,
            'isComplete': is_complete,
            **data
        }
        
        event_type = 'SUMMARY_STREAMING' if is_streaming else 'ANALYTICS_COMPLETED'
        
        return self.publish_event(
            channel='analytics-updates',
            event_data=event_data,
            event_type=event_type
        )
    
    def publish_streaming_chunk(
        self,
        contact_id: str,
        chunk: str,
        is_final: bool = False
    ) -> Dict[str, Any]:
        """
        Publish a streaming summary chunk
        
        Args:
            contact_id: Contact ID
            chunk: Text chunk from streaming response
            is_final: Whether this is the final chunk
            
        Returns:
            Response from AppSync Events API
        """
        return self.publish_analytics_update(
            contact_id=contact_id,
            analytics_type='SUMMARY',
            data={
                'summaryChunk': chunk,
                'isFinal': is_final
            },
            is_streaming=True,
            is_complete=is_final
        )
    
    def publish_error(
        self,
        contact_id: str,
        error_type: str,
        error_message: str
    ) -> Dict[str, Any]:
        """
        Publish an error event
        
        Args:
            contact_id: Contact ID
            error_type: Type of error
            error_message: Error message
            
        Returns:
            Response from AppSync Events API
        """
        event_data = {
            'contactId': contact_id,
            'errorType': error_type,
            'errorMessage': error_message
        }
        
        return self.publish_event(
            channel='contact-updates',
            event_data=event_data,
            event_type='ERROR'
        )


# Utility function to create publisher instance
def create_appsync_events_publisher(
    api_endpoint: Optional[str] = None,
    channel_namespace: Optional[str] = None,
    region: Optional[str] = None
) -> AppSyncEventsPublisher:
    """Create an AppSync Events Publisher instance"""
    return AppSyncEventsPublisher(
        api_endpoint=api_endpoint,
        channel_namespace=channel_namespace,
        region=region
    )
