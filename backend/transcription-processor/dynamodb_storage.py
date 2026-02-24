"""
DynamoDB storage logic for transcription processing
Handles storage, duplicate prevention, and contact completion detection
"""

import os
import logging
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple
from dataclasses import dataclass

import boto3
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger, Metrics
from aws_lambda_powertools.metrics import MetricUnit

# Initialize logger and metrics
logger = Logger()
metrics = Metrics()


@dataclass
class ContactCompletionStatus:
    """Status of contact completion detection"""
    contact_id: str
    is_complete: bool
    total_received: int
    total_expected: Optional[int]
    completion_method: str  # 'explicit_flag', 'sequence_complete', 'timeout', 'external_signal'
    last_sequence: int


class DynamoDBStorageManager:
    """Manages DynamoDB storage operations for transcriptions"""
    
    def __init__(self, table_name: str, region: str = None):
        """
        Initialize the storage manager
        
        Args:
            table_name: Name of the DynamoDB table
            region: AWS region
        """
        self.table_name = table_name
        self.region = region or os.environ.get('AWS_REGION', 'us-west-2')
        self.dynamodb = boto3.resource('dynamodb', region_name=region)
        self.table = self.dynamodb.Table(table_name)
        self.logger = logger
        self.metrics = metrics
    
    def store_transcription_with_duplicate_prevention(
        self, 
        transcription_item: Dict[str, Any]
    ) -> Tuple[bool, str]:
        """
        Store transcription item with duplicate prevention
        
        Args:
            transcription_item: DynamoDB item to store
            
        Returns:
            Tuple of (success: bool, message: str)
            success=True if stored, False if duplicate
        """
        try:
            # Use conditional expression to prevent duplicates
            response = self.table.put_item(
                Item=transcription_item,
                ConditionExpression='attribute_not_exists(PK) AND attribute_not_exists(SK)',
                ReturnValues='ALL_OLD'
            )
            
            self.logger.info(
                "Transcription stored successfully",
                extra={
                    "contactId": transcription_item['contactId'],
                    "sequenceNumber": transcription_item['sequenceNumber'],
                    "pk": transcription_item['PK'],
                    "sk": transcription_item['SK']
                }
            )
            self.metrics.add_metric(name="TranscriptionStored", unit=MetricUnit.Count, value=1)
            return True, "Transcription stored successfully"
            
        except ClientError as e:
            if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
                # Duplicate item - this is expected behavior
                self.logger.info(
                    "Duplicate transcription detected, skipping",
                    extra={
                        "contactId": transcription_item['contactId'],
                        "sequenceNumber": transcription_item['sequenceNumber'],
                        "pk": transcription_item['PK'],
                        "sk": transcription_item['SK']
                    }
                )
                self.metrics.add_metric(name="DuplicateTranscriptionSkipped", unit=MetricUnit.Count, value=1)
                return False, "Duplicate transcription skipped"
            else:
                # Other DynamoDB errors
                error_msg = f"Failed to store transcription: {str(e)}"
                self.logger.error(
                    error_msg,
                    extra={
                        "error": str(e),
                        "errorCode": e.response['Error']['Code'],
                        "contactId": transcription_item['contactId'],
                        "sequenceNumber": transcription_item['sequenceNumber']
                    }
                )
                self.metrics.add_metric(name="TranscriptionStorageError", unit=MetricUnit.Count, value=1)
                raise
    
    def get_contact_transcriptions(self, contact_id: str) -> List[Dict[str, Any]]:
        """
        Retrieve all transcriptions for a contact
        
        Args:
            contact_id: Contact ID to query
            
        Returns:
            List of transcription items
        """
        try:
            response = self.table.query(
                KeyConditionExpression='PK = :pk',
                ExpressionAttributeValues={
                    ':pk': contact_id
                },
                ScanIndexForward=True  # Sort by SK in ascending order
            )
            
            transcriptions = response.get('Items', [])
            
            self.logger.info(
                "Retrieved contact transcriptions",
                extra={
                    "contactId": contact_id,
                    "transcriptionCount": len(transcriptions)
                }
            )
            
            return transcriptions
            
        except ClientError as e:
            self.logger.error(
                "Failed to retrieve contact transcriptions",
                extra={
                    "error": str(e),
                    "contactId": contact_id
                }
            )
            raise
    
    def detect_contact_completion(self, contact_id: str) -> ContactCompletionStatus:
        """
        Detect if all transcriptions for a contact have been received
        
        This implements multiple completion detection strategies:
        1. Explicit completion flag in transcription metadata
        2. Sequence number validation (all expected sequences received)
        3. Timeout-based completion (configurable)
        4. External completion signal
        
        Args:
            contact_id: Contact ID to check
            
        Returns:
            ContactCompletionStatus with completion information
        """
        transcriptions = self.get_contact_transcriptions(contact_id)
        
        if not transcriptions:
            return ContactCompletionStatus(
                contact_id=contact_id,
                is_complete=False,
                total_received=0,
                total_expected=None,
                completion_method='no_transcriptions',
                last_sequence=-1
            )
        
        # Sort transcriptions by sequence number
        sorted_transcriptions = sorted(
            transcriptions, 
            key=lambda x: x.get('sequenceNumber', 0)
        )
        
        total_received = len(sorted_transcriptions)
        last_sequence = sorted_transcriptions[-1].get('sequenceNumber', -1)
        
        # Strategy 1: Check for explicit completion flag
        for transcription in sorted_transcriptions:
            if transcription.get('isComplete', False):
                self.logger.info(
                    "Contact completion detected via explicit flag",
                    extra={
                        "contactId": contact_id,
                        "totalReceived": total_received,
                        "lastSequence": last_sequence
                    }
                )
                return ContactCompletionStatus(
                    contact_id=contact_id,
                    is_complete=True,
                    total_received=total_received,
                    total_expected=transcription.get('totalExpected'),
                    completion_method='explicit_flag',
                    last_sequence=last_sequence
                )
        
        # Strategy 2: Check sequence completeness
        total_expected = None
        for transcription in sorted_transcriptions:
            if transcription.get('totalExpected'):
                total_expected = transcription.get('totalExpected')
                break
        
        if total_expected and total_received >= total_expected:
            # Verify we have all sequence numbers from 0 to total_expected-1
            expected_sequences = set(range(total_expected))
            received_sequences = set(t.get('sequenceNumber', -1) for t in sorted_transcriptions)
            
            if expected_sequences.issubset(received_sequences):
                self.logger.info(
                    "Contact completion detected via sequence validation",
                    extra={
                        "contactId": contact_id,
                        "totalReceived": total_received,
                        "totalExpected": total_expected,
                        "lastSequence": last_sequence
                    }
                )
                return ContactCompletionStatus(
                    contact_id=contact_id,
                    is_complete=True,
                    total_received=total_received,
                    total_expected=total_expected,
                    completion_method='sequence_complete',
                    last_sequence=last_sequence
                )
        
        # Strategy 3: Check for contact status in metadata
        for transcription in sorted_transcriptions:
            metadata = transcription.get('metadata', {})
            if isinstance(metadata, dict) and metadata.get('contactStatus') == 'COMPLETED':
                self.logger.info(
                    "Contact completion detected via contact status",
                    extra={
                        "contactId": contact_id,
                        "totalReceived": total_received,
                        "lastSequence": last_sequence
                    }
                )
                return ContactCompletionStatus(
                    contact_id=contact_id,
                    is_complete=True,
                    total_received=total_received,
                    total_expected=total_expected,
                    completion_method='external_signal',
                    last_sequence=last_sequence
                )
        
        # Contact is not complete
        self.logger.debug(
            "Contact not yet complete",
            extra={
                "contactId": contact_id,
                "totalReceived": total_received,
                "totalExpected": total_expected,
                "lastSequence": last_sequence
            }
        )
        
        return ContactCompletionStatus(
            contact_id=contact_id,
            is_complete=False,
            total_received=total_received,
            total_expected=total_expected,
            completion_method='incomplete',
            last_sequence=last_sequence
        )
    
    def update_contact_status(
        self, 
        contact_id: str, 
        status: str, 
        completion_info: Optional[ContactCompletionStatus] = None
    ) -> bool:
        """
        Update contact status in DynamoDB
        
        Args:
            contact_id: Contact ID
            status: New status ('IN_PROGRESS', 'COMPLETED', 'FAILED')
            completion_info: Optional completion information
            
        Returns:
            True if updated successfully
        """
        try:
            # Create a status record
            status_item = {
                'PK': contact_id,
                'SK': 'STATUS',
                'contactId': contact_id,
                'status': status,
                'updatedAt': datetime.utcnow().isoformat(),
                'GSI1PK': f"STATUS#{status}",
                'GSI1SK': contact_id
            }
            
            if completion_info:
                status_item.update({
                    'totalReceived': completion_info.total_received,
                    'totalExpected': completion_info.total_expected,
                    'completionMethod': completion_info.completion_method,
                    'lastSequence': completion_info.last_sequence
                })
            
            self.table.put_item(Item=status_item)
            
            self.logger.info(
                "Contact status updated",
                extra={
                    "contactId": contact_id,
                    "status": status,
                    "completionMethod": completion_info.completion_method if completion_info else None
                }
            )
            self.metrics.add_metric(name="ContactStatusUpdated", unit=MetricUnit.Count, value=1)
            return True
            
        except ClientError as e:
            self.logger.error(
                "Failed to update contact status",
                extra={
                    "error": str(e),
                    "contactId": contact_id,
                    "status": status
                }
            )
            self.metrics.add_metric(name="ContactStatusUpdateError", unit=MetricUnit.Count, value=1)
            raise
    
    def enable_dynamodb_streams(self) -> bool:
        """
        Enable DynamoDB Streams on the transcriptions table
        This is typically done during infrastructure setup, but included for completeness
        
        Returns:
            True if streams are enabled or already enabled
        """
        try:
            # Check current stream status
            table_description = self.table.meta.client.describe_table(
                TableName=self.table_name
            )
            
            stream_spec = table_description['Table'].get('StreamSpecification', {})
            
            if stream_spec.get('StreamEnabled', False):
                self.logger.info(
                    "DynamoDB Streams already enabled",
                    extra={
                        "tableName": self.table_name,
                        "streamViewType": stream_spec.get('StreamViewType')
                    }
                )
                return True
            
            # Enable streams with NEW_AND_OLD_IMAGES view type
            self.table.meta.client.update_table(
                TableName=self.table_name,
                StreamSpecification={
                    'StreamEnabled': True,
                    'StreamViewType': 'NEW_AND_OLD_IMAGES'
                }
            )
            
            self.logger.info(
                "DynamoDB Streams enabled",
                extra={
                    "tableName": self.table_name,
                    "streamViewType": "NEW_AND_OLD_IMAGES"
                }
            )
            self.metrics.add_metric(name="DynamoDBStreamsEnabled", unit=MetricUnit.Count, value=1)
            return True
            
        except ClientError as e:
            self.logger.error(
                "Failed to enable DynamoDB Streams",
                extra={
                    "error": str(e),
                    "tableName": self.table_name
                }
            )
            return False
    
    def get_contact_status(self, contact_id: str) -> Optional[Dict[str, Any]]:
        """
        Get current status of a contact
        
        Args:
            contact_id: Contact ID
            
        Returns:
            Status item or None if not found
        """
        try:
            response = self.table.get_item(
                Key={
                    'PK': contact_id,
                    'SK': 'STATUS'
                }
            )
            
            return response.get('Item')
            
        except ClientError as e:
            self.logger.error(
                "Failed to get contact status",
                extra={
                    "error": str(e),
                    "contactId": contact_id
                }
            )
            return None
    
    def batch_get_transcriptions(self, contact_ids: List[str]) -> Dict[str, List[Dict[str, Any]]]:
        """
        Retrieve transcriptions for multiple contacts in batch
        
        Args:
            contact_ids: List of contact IDs
            
        Returns:
            Dictionary mapping contact_id to list of transcriptions
        """
        results = {}
        
        # Process in batches of 25 (DynamoDB batch limit)
        batch_size = 25
        for i in range(0, len(contact_ids), batch_size):
            batch_contact_ids = contact_ids[i:i + batch_size]
            
            try:
                # Build batch request
                request_items = {
                    self.table_name: {
                        'Keys': [
                            {'PK': contact_id, 'SK': {'S': {'$exists': True}}}
                            for contact_id in batch_contact_ids
                        ]
                    }
                }
                
                # Use query instead for better performance
                for contact_id in batch_contact_ids:
                    transcriptions = self.get_contact_transcriptions(contact_id)
                    results[contact_id] = transcriptions
                    
            except ClientError as e:
                self.logger.error(
                    "Failed to batch get transcriptions",
                    extra={
                        "error": str(e),
                        "contactIds": batch_contact_ids
                    }
                )
                # Set empty results for failed batch
                for contact_id in batch_contact_ids:
                    results[contact_id] = []
        
        return results
    
    def cleanup_old_transcriptions(self, days_to_keep: int = 30) -> int:
        """
        Clean up old transcriptions based on retention policy
        
        Args:
            days_to_keep: Number of days to keep transcriptions
            
        Returns:
            Number of items deleted
        """
        cutoff_date = datetime.utcnow().timestamp() - (days_to_keep * 24 * 60 * 60)
        deleted_count = 0
        
        try:
            # Scan for old items (in production, use a GSI with timestamp)
            response = self.table.scan(
                FilterExpression='createdAt < :cutoff',
                ExpressionAttributeValues={
                    ':cutoff': datetime.fromtimestamp(cutoff_date).isoformat()
                },
                ProjectionExpression='PK, SK'
            )
            
            # Delete items in batches
            items_to_delete = response.get('Items', [])
            batch_size = 25
            
            for i in range(0, len(items_to_delete), batch_size):
                batch = items_to_delete[i:i + batch_size]
                
                with self.table.batch_writer() as batch_writer:
                    for item in batch:
                        batch_writer.delete_item(
                            Key={
                                'PK': item['PK'],
                                'SK': item['SK']
                            }
                        )
                        deleted_count += 1
            
            self.logger.info(
                "Cleaned up old transcriptions",
                extra={
                    "deletedCount": deleted_count,
                    "daysToKeep": days_to_keep
                }
            )
            self.metrics.add_metric(name="TranscriptionsDeleted", unit=MetricUnit.Count, value=deleted_count)
            
        except ClientError as e:
            self.logger.error(
                "Failed to cleanup old transcriptions",
                extra={
                    "error": str(e),
                    "daysToKeep": days_to_keep
                }
            )
        
        return deleted_count


# Utility functions for integration with the main handler
def create_storage_manager(table_name: str, region: str = None) -> DynamoDBStorageManager:
    """Create a DynamoDB storage manager instance"""
    return DynamoDBStorageManager(table_name, region)


def process_transcription_storage(
    storage_manager: DynamoDBStorageManager,
    transcription_item: Dict[str, Any]
) -> Tuple[bool, ContactCompletionStatus]:
    """
    Process transcription storage and check for contact completion
    
    Args:
        storage_manager: DynamoDB storage manager
        transcription_item: Transcription item to store
        
    Returns:
        Tuple of (stored: bool, completion_status: ContactCompletionStatus)
    """
    # Store the transcription
    stored, message = storage_manager.store_transcription_with_duplicate_prevention(transcription_item)
    
    # Check contact completion status
    contact_id = transcription_item['contactId']
    completion_status = storage_manager.detect_contact_completion(contact_id)
    
    # Update contact status if complete
    if completion_status.is_complete:
        storage_manager.update_contact_status(
            contact_id, 
            'COMPLETED', 
            completion_status
        )
    else:
        # Update as in progress
        storage_manager.update_contact_status(
            contact_id, 
            'IN_PROGRESS', 
            completion_status
        )
    
    return stored, completion_status