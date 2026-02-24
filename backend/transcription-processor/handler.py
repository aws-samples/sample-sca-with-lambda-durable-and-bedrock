"""
Transcription Processor Lambda Function

This Lambda function processes transcription data from Kinesis Streams,
validates the data, and stores it in DynamoDB with proper error handling.
"""

import json
import logging
import os
from datetime import datetime
from decimal import Decimal
from typing import Dict, List, Any, Optional

import boto3
from aws_lambda_powertools import Logger, Tracer, Metrics
from aws_lambda_powertools.logging import correlation_paths
from aws_lambda_powertools.metrics import MetricUnit
from botocore.exceptions import ClientError

from dynamodb_storage import DynamoDBStorageManager, process_transcription_storage

# Initialize AWS Lambda Powertools
logger = Logger()
tracer = Tracer()
metrics = Metrics()

# Initialize AWS clients
sqs = boto3.client('sqs')

# Environment variables
TRANSCRIPTIONS_TABLE = os.environ.get('TRANSCRIPTIONS_TABLE', 'sca-transcriptions')
DLQ_URL = os.environ.get('DLQ_URL', '')

# Initialize DynamoDB storage manager
storage_manager = DynamoDBStorageManager(TRANSCRIPTIONS_TABLE)


def convert_floats_to_decimal(obj: Any) -> Any:
    """
    Recursively convert float values to Decimal for DynamoDB compatibility
    
    Args:
        obj: Object to convert (dict, list, or primitive)
        
    Returns:
        Object with floats converted to Decimal
    """
    if isinstance(obj, float):
        return Decimal(str(obj))
    elif isinstance(obj, dict):
        return {k: convert_floats_to_decimal(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_floats_to_decimal(item) for item in obj]
    else:
        return obj


def parse_contact_lens_data(raw_data: Dict[str, Any]) -> tuple[List[Dict[str, Any]], bool]:
    """
    Parse Contact Lens streaming data format into individual transcription records
    
    Contact Lens format:
    {
        "Version": "1.0.0",
        "Channel": "VOICE",
        "ContactId": "...",
        "EventType": "SEGMENTS" | "COMPLETED",
        "Segments": [
            {
                "Transcript": {
                    "ParticipantRole": "CUSTOMER" | "AGENT",
                    "Content": "text",
                    "BeginOffsetMillis": 1000,
                    "EndOffsetMillis": 2000,
                    "Id": "segment-id",
                    "Time": {"AbsoluteTime": "2026-01-15T04:38:19.349Z"},
                    "Sentiment": "NEUTRAL"
                }
            }
        ]
    }
    
    Args:
        raw_data: Raw Contact Lens data from Kinesis
        
    Returns:
        Tuple of (transcription records list, is_contact_complete boolean)
        
    Raises:
        ValueError: If data validation fails
    """
    # Validate Contact Lens format
    if 'ContactId' not in raw_data:
        raise ValueError("Missing required field: ContactId")
    
    # Segments array is optional for COMPLETED events
    event_type = raw_data.get('EventType', 'SEGMENTS')
    if event_type != 'COMPLETED' and ('Segments' not in raw_data or not isinstance(raw_data['Segments'], list)):
        raise ValueError("Missing or invalid Segments array")
    
    contact_id = raw_data['ContactId']
    channel = raw_data.get('Channel', 'VOICE')
    language = raw_data.get('LanguageCode', 'en-US')
    event_type = raw_data.get('EventType', 'SEGMENTS')
    
    # Check if this event indicates contact completion
    is_contact_complete = event_type == 'COMPLETED'
    
    # If COMPLETED event with no segments, return empty list with completion flag
    if is_contact_complete and 'Segments' not in raw_data:
        logger.info(f"Received COMPLETED event for contact {contact_id} with no segments")
        return [], is_contact_complete
    
    transcriptions = []
    
    for idx, segment in enumerate(raw_data.get('Segments', [])):
        # Contact Lens can send different segment types: Transcript, Utterance, Categories, Issues
        # We're interested in Transcript (final) and Utterance (partial/real-time)
        segment_data = None
        segment_type = None
        
        if 'Transcript' in segment:
            segment_data = segment['Transcript']
            segment_type = 'Transcript'
        elif 'Utterance' in segment:
            segment_data = segment['Utterance']
            segment_type = 'Utterance'
        else:
            # Skip segments without transcription data (e.g., Categories, Issues)
            logger.debug(f"Segment {idx} has no Transcript or Utterance field, skipping")
            continue
        
        # Extract required fields
        participant_role = segment_data.get('ParticipantRole', 'CUSTOMER')
        
        # Content field name differs between Transcript and Utterance
        if segment_type == 'Transcript':
            content = segment_data.get('Content', '')
        else:  # Utterance
            content = segment_data.get('PartialContent', '')
        
        # Skip empty content
        if not content or len(content.strip()) == 0:
            logger.debug(f"Segment {idx} has empty content, skipping")
            continue
        
        segment_id = segment_data.get('Id', f'segment-{idx}')
        transcript_id = segment_data.get('TranscriptId', '')
        
        # Map ParticipantRole to our speaker format
        speaker = 'AGENT' if participant_role == 'AGENT' else 'CUSTOMER'
        
        # Extract timestamp
        timestamp = None
        if 'Time' in segment_data and 'AbsoluteTime' in segment_data['Time']:
            timestamp = segment_data['Time']['AbsoluteTime']
        else:
            # Fallback to current time if not provided
            timestamp = datetime.utcnow().isoformat() + 'Z'
        
        # Extract timing information
        begin_offset = segment_data.get('BeginOffsetMillis', 0)
        end_offset = segment_data.get('EndOffsetMillis', 0)
        
        # Extract sentiment (optional, usually only in Transcript)
        sentiment = segment_data.get('Sentiment', 'NEUTRAL')
        
        # Create transcription record
        transcription = {
            'contactId': contact_id,
            'sequenceNumber': idx,  # Use segment index as sequence
            'timestamp': timestamp,
            'speaker': speaker,
            'text': content,
            'confidence': 1.0,  # Contact Lens doesn't provide confidence per segment
            'metadata': {
                'segmentId': segment_id,
                'transcriptId': transcript_id,
                'segmentType': segment_type,
                'channel': channel,
                'language': language,
                'beginOffsetMillis': begin_offset,
                'endOffsetMillis': end_offset,
                'sentiment': sentiment,
                'contactStatus': 'COMPLETED' if is_contact_complete else 'IN_PROGRESS'
            }
        }
        
        transcriptions.append(transcription)
    
    if not transcriptions:
        # Check if we had any segments at all
        if len(raw_data.get('Segments', [])) == 0:
            # If this is a COMPLETED event with no segments, that's OK
            if is_contact_complete:
                logger.info(f"Received COMPLETED event for contact {contact_id} with no segments")
                return [], is_contact_complete
            raise ValueError("No segments found in Contact Lens data")
        # If we had segments but none were transcriptions, this is OK
        # (e.g., PostContactSummary, Categories, Issues segments)
        logger.info(f"No transcription segments found in {len(raw_data.get('Segments', []))} segment(s) - likely non-transcription data (PostContactSummary, Categories, etc.)")
        return [], is_contact_complete  # Return empty list with completion status
    
    return transcriptions, is_contact_complete


def validate_transcription_data(raw_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate individual transcription record
    
    Args:
        raw_data: Transcription record
        
    Returns:
        Validated transcription record
        
    Raises:
        ValueError: If data validation fails
    """
    required_fields = ['contactId', 'sequenceNumber', 'timestamp', 'speaker', 'text', 'confidence']
    
    for field in required_fields:
        if field not in raw_data:
            raise ValueError(f"Missing required field: {field}")
    
    # Validate types and constraints
    if not isinstance(raw_data['contactId'], str) or len(raw_data['contactId']) == 0:
        raise ValueError("contactId must be a non-empty string")
    
    if not isinstance(raw_data['sequenceNumber'], int) or raw_data['sequenceNumber'] < 0:
        raise ValueError("sequenceNumber must be a non-negative integer")
    
    if not isinstance(raw_data['timestamp'], str) or len(raw_data['timestamp']) == 0:
        raise ValueError("timestamp must be a non-empty string")
    
    if raw_data['speaker'] not in ['AGENT', 'CUSTOMER']:
        raise ValueError("speaker must be either 'AGENT' or 'CUSTOMER'")
    
    if not isinstance(raw_data['text'], str) or len(raw_data['text']) == 0:
        raise ValueError("text must be a non-empty string")
    
    if not isinstance(raw_data['confidence'], (int, float)) or not (0.0 <= raw_data['confidence'] <= 1.0):
        raise ValueError("confidence must be a number between 0.0 and 1.0")
    
    return raw_data


class TranscriptionProcessor:
    """Main processor class for handling transcription data"""
    
    def __init__(self):
        self.logger = logger
        self.metrics = metrics
    
    def create_dynamodb_item(self, transcription: Dict[str, Any]) -> Dict[str, Any]:
        """
        Create DynamoDB item from validated transcription data
        
        Args:
            transcription: Validated transcription record
            
        Returns:
            DynamoDB item dictionary with floats converted to Decimal
        """
        # Create partition key (contactId) and sort key (timestamp with sequence)
        pk = transcription['contactId']
        sk = f"{transcription['timestamp']}#{transcription['sequenceNumber']:010d}"
        
        item = {
            'PK': pk,
            'SK': sk,
            'contactId': transcription['contactId'],
            'sequenceNumber': transcription['sequenceNumber'],
            'timestamp': transcription['timestamp'],
            'speaker': transcription['speaker'],
            'text': transcription['text'],
            'confidence': transcription['confidence'],
            'createdAt': datetime.utcnow().isoformat(),
            'updatedAt': datetime.utcnow().isoformat()
        }
        
        # Add optional metadata fields
        if 'metadata' in transcription and transcription['metadata']:
            metadata_dict = transcription['metadata']
            if metadata_dict:
                item['metadata'] = metadata_dict
                
            # Add completion tracking fields at top level for easier querying
            if 'isComplete' in metadata_dict:
                item['isComplete'] = metadata_dict['isComplete']
            if 'totalExpected' in metadata_dict:
                item['totalExpected'] = metadata_dict['totalExpected']
        
        # Add GSI keys for additional query patterns
        item['GSI1PK'] = f"CONTACT#{transcription['contactId']}"
        item['GSI1SK'] = f"SEQ#{transcription['sequenceNumber']:010d}"
        
        # Convert all float values to Decimal for DynamoDB compatibility
        item = convert_floats_to_decimal(item)
        
        return item
    
    def store_transcription(self, item: Dict[str, Any]) -> bool:
        """
        Store transcription item in DynamoDB with duplicate prevention and completion detection
        
        Args:
            item: DynamoDB item to store
            
        Returns:
            True if stored successfully, False if duplicate
            
        Raises:
            ClientError: If DynamoDB operation fails
        """
        try:
            # Use the storage manager for enhanced functionality
            stored, completion_status = process_transcription_storage(
                storage_manager, item
            )
            
            # Log completion status if contact is complete
            if completion_status.is_complete:
                self.logger.info(
                    "Contact completion detected",
                    extra={
                        "contactId": completion_status.contact_id,
                        "completionMethod": completion_status.completion_method,
                        "totalTranscriptions": completion_status.total_received
                    }
                )
                self.metrics.add_metric(name="ContactCompleted", unit=MetricUnit.Count, value=1)
            
            return stored
            
        except ClientError as e:
            # Error handling is managed by the storage manager
            raise
    
    def send_to_dlq(self, original_record: Dict[str, Any], error: Dict[str, Any]) -> None:
        """
        Send failed record to Dead Letter Queue
        
        Args:
            original_record: Original Kinesis record that failed processing
            error: Error information dictionary
        """
        if not DLQ_URL:
            self.logger.warning("DLQ URL not configured, cannot send failed record")
            return
        
        dlq_message = {
            'originalRecord': original_record,
            'error': {
                'errorType': error['error_type'],
                'message': error['message'],
                'context': error['context'],
                'timestamp': error['timestamp'].isoformat(),
                'retryable': error['retryable']
            },
            'attemptCount': 1,
            'firstAttempt': error['timestamp'].isoformat(),
            'lastAttempt': error['timestamp'].isoformat()
        }
        
        try:
            sqs.send_message(
                QueueUrl=DLQ_URL,
                MessageBody=json.dumps(dlq_message),
                MessageAttributes={
                    'ErrorType': {
                        'StringValue': error['error_type'],
                        'DataType': 'String'
                    },
                    'Retryable': {
                        'StringValue': str(error['retryable']),
                        'DataType': 'String'
                    }
                }
            )
            
            self.logger.info("Failed record sent to DLQ", extra={"errorType": error['error_type']})
            self.metrics.add_metric(name="RecordSentToDLQ", unit=MetricUnit.Count, value=1)
            
        except ClientError as e:
            self.logger.error("Failed to send record to DLQ", extra={"error": str(e)})
            self.metrics.add_metric(name="DLQSendError", unit=MetricUnit.Count, value=1)
    
    def process_record(self, record: Dict[str, Any]) -> Dict[str, Any]:
        """
        Process a single Kinesis record containing Contact Lens data
        
        Args:
            record: Kinesis record
            
        Returns:
            Processing result dictionary
        """
        result = {
            'recordId': record.get('recordId', 'unknown'),
            'result': 'Ok',
            'data': None
        }
        
        try:
            # Decode Kinesis data
            import base64
            encoded_data = record['kinesis']['data']
            decoded_data = base64.b64decode(encoded_data).decode('utf-8')
            contact_lens_data = json.loads(decoded_data)
            
            # Log the raw Contact Lens data for debugging (first 1000 chars)
            self.logger.debug(
                "Raw Contact Lens data",
                extra={
                    "recordId": result['recordId'],
                    "rawData": decoded_data[:1000] if len(decoded_data) > 1000 else decoded_data
                }
            )
            
            self.logger.info(
                "Processing Contact Lens record",
                extra={
                    "recordId": result['recordId'],
                    "contactId": contact_lens_data.get('ContactId', 'unknown'),
                    "eventType": contact_lens_data.get('EventType', 'unknown'),
                    "segmentCount": len(contact_lens_data.get('Segments', []))
                }
            )
            
            # Parse Contact Lens format into individual transcriptions
            transcriptions, is_contact_complete = parse_contact_lens_data(contact_lens_data)
            
            # If no transcriptions found (e.g., PostContactSummary only), check if contact is complete
            if not transcriptions:
                # If this is a completion event, update contact status
                if is_contact_complete:
                    contact_id = contact_lens_data.get('ContactId')
                    self.logger.info(
                        "Received contact completion event",
                        extra={
                            "recordId": result['recordId'],
                            "contactId": contact_id,
                            "eventType": contact_lens_data.get('EventType')
                        }
                    )
                    
                    # Update contact status to COMPLETED
                    from dynamodb_storage import ContactCompletionStatus
                    completion_status = ContactCompletionStatus(
                        contact_id=contact_id,
                        is_complete=True,
                        total_received=0,
                        total_expected=None,
                        completion_method='external_signal',
                        last_sequence=-1
                    )
                    storage_manager.update_contact_status(contact_id, 'COMPLETED', completion_status)
                    
                    result['data'] = {
                        'contactId': contact_id,
                        'segmentsProcessed': 0,
                        'stored': 0,
                        'duplicates': 0,
                        'completed': True
                    }
                    self.metrics.add_metric(name="ContactCompleted", unit=MetricUnit.Count, value=1)
                    return result
                
                self.logger.info(
                    "No transcription data in Contact Lens record, skipping",
                    extra={
                        "recordId": result['recordId'],
                        "contactId": contact_lens_data.get('ContactId'),
                        "eventType": contact_lens_data.get('EventType')
                    }
                )
                result['data'] = {
                    'contactId': contact_lens_data.get('ContactId'),
                    'segmentsProcessed': 0,
                    'stored': 0,
                    'duplicates': 0,
                    'skipped': True,
                    'reason': 'No transcription segments'
                }
                self.metrics.add_metric(name="RecordSkipped", unit=MetricUnit.Count, value=1)
                return result
            
            # Process each transcription segment
            stored_count = 0
            duplicate_count = 0
            
            for transcription in transcriptions:
                # Validate transcription data
                validated_transcription = validate_transcription_data(transcription)
                
                # Create DynamoDB item
                dynamodb_item = self.create_dynamodb_item(validated_transcription)
                
                # Store in DynamoDB
                stored = self.store_transcription(dynamodb_item)
                
                if stored:
                    stored_count += 1
                else:
                    duplicate_count += 1
            
            result['data'] = {
                'contactId': contact_lens_data.get('ContactId'),
                'segmentsProcessed': len(transcriptions),
                'stored': stored_count,
                'duplicates': duplicate_count
            }
            
            self.metrics.add_metric(name="RecordProcessedSuccessfully", unit=MetricUnit.Count, value=1)
            self.metrics.add_metric(name="SegmentsProcessed", unit=MetricUnit.Count, value=len(transcriptions))
            
        except ValueError as e:
            # Data validation error - not retryable
            error = {
                'error_type': 'VALIDATION_ERROR',
                'message': f"Invalid Contact Lens data: {str(e)}",
                'context': {'record': record},
                'timestamp': datetime.utcnow(),
                'retryable': False
            }
            
            self.send_to_dlq(record, error)
            result['result'] = 'ProcessingFailed'
            self.metrics.add_metric(name="ValidationError", unit=MetricUnit.Count, value=1)
            
        except json.JSONDecodeError as e:
            # JSON parsing error - not retryable
            error = {
                'error_type': 'VALIDATION_ERROR',
                'message': f"Invalid JSON data: {str(e)}",
                'context': {'record': record},
                'timestamp': datetime.utcnow(),
                'retryable': False
            }
            
            self.send_to_dlq(record, error)
            result['result'] = 'ProcessingFailed'
            self.metrics.add_metric(name="JSONParsingError", unit=MetricUnit.Count, value=1)
            
        except ClientError as e:
            # DynamoDB error - potentially retryable
            retryable = e.response['Error']['Code'] in [
                'ProvisionedThroughputExceededException',
                'ThrottlingException',
                'ServiceUnavailable'
            ]
            
            error = {
                'error_type': 'STORAGE_ERROR',
                'message': f"DynamoDB error: {str(e)}",
                'context': {'record': record, 'error_code': e.response['Error']['Code']},
                'timestamp': datetime.utcnow(),
                'retryable': retryable
            }
            
            if retryable:
                # Let Kinesis retry
                result['result'] = 'ProcessingFailed'
            else:
                # Send to DLQ
                self.send_to_dlq(record, error)
                result['result'] = 'ProcessingFailed'
            
            self.metrics.add_metric(name="StorageError", unit=MetricUnit.Count, value=1)
            
        except Exception as e:
            # Unexpected error - potentially retryable
            self.logger.error(
                f"Unexpected error processing record: {str(e)}",
                extra={
                    "error": str(e),
                    "errorType": type(e).__name__,
                    "recordId": result['recordId']
                },
                exc_info=True  # Include full stack trace
            )
            
            error = {
                'error_type': 'PROCESSING_ERROR',
                'message': f"Unexpected error: {str(e)}",
                'context': {'record': record},
                'timestamp': datetime.utcnow(),
                'retryable': True
            }
            
            result['result'] = 'ProcessingFailed'
            self.metrics.add_metric(name="UnexpectedError", unit=MetricUnit.Count, value=1)
            
        return result


# Initialize processor
processor = TranscriptionProcessor()


@tracer.capture_lambda_handler
@logger.inject_lambda_context
@metrics.log_metrics
def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda handler for processing Kinesis Stream records
    
    Args:
        event: Kinesis event containing records
        context: Lambda context
        
    Returns:
        Kinesis response with processing results
    """
    logger.info(f"Processing {len(event['Records'])} records")
    
    results = []
    
    for record in event['Records']:
        result = processor.process_record(record)
        results.append(result)
    
    # Log summary metrics
    successful = sum(1 for r in results if r['result'] == 'Ok')
    failed = len(results) - successful
    
    logger.info(
        "Batch processing completed",
        extra={
            "totalRecords": len(results),
            "successful": successful,
            "failed": failed
        }
    )
    
    metrics.add_metric(name="BatchProcessed", unit=MetricUnit.Count, value=1)
    metrics.add_metric(name="RecordsProcessed", unit=MetricUnit.Count, value=len(results))
    
    return {'records': results}
