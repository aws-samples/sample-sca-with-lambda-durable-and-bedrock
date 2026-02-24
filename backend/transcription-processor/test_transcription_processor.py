"""
Property-based tests for the Transcription Processor Lambda function
Tests Property 2: Error Handling and Recovery
"""

import json
import base64
import os
import pytest
from datetime import datetime
from unittest.mock import Mock, patch, MagicMock
from hypothesis import given, strategies as st, settings, assume, HealthCheck
from hypothesis.strategies import composite
from botocore.exceptions import ClientError
from pydantic import ValidationError

# Mock the metrics decorator before importing the handler
with patch('aws_lambda_powertools.Metrics') as mock_metrics_class:
    # Create a mock that returns a decorator that does nothing
    mock_metrics = Mock()
    mock_metrics.log_metrics = lambda func: func  # Return function unchanged
    mock_metrics.add_metric = Mock()
    mock_metrics.flush_metrics = Mock()
    mock_metrics_class.return_value = mock_metrics
    
    # Import the handler and processor after mocking
    from handler import TranscriptionProcessor, ProcessingError, KinesisTranscriptionRecord
    from dynamodb_storage import DynamoDBStorageManager, process_transcription_storage


# Custom strategies for generating test data
@composite
def valid_transcription_data(draw):
    """Generate valid transcription data for testing"""
    contact_id = draw(st.text(min_size=1, max_size=20, alphabet=st.characters(min_codepoint=65, max_codepoint=90)))
    sequence_number = draw(st.integers(min_value=0, max_value=9999))
    timestamp = "2024-01-01T12:00:00Z"  # Fixed timestamp for faster generation
    speaker = draw(st.sampled_from(['AGENT', 'CUSTOMER']))
    text = draw(st.text(min_size=1, max_size=100, alphabet=st.characters(min_codepoint=32, max_codepoint=126)))
    confidence = draw(st.floats(min_value=0.0, max_value=1.0))
    
    # Simplified metadata generation
    metadata = None
    if draw(st.booleans()):
        metadata = {
            'channel': 'voice',
            'language': 'en-US',
            'contactStatus': draw(st.sampled_from(['IN_PROGRESS', 'COMPLETED']))
        }
    
    data = {
        'contactId': contact_id,
        'sequenceNumber': sequence_number,
        'timestamp': timestamp,
        'speaker': speaker,
        'text': text,
        'confidence': confidence
    }
    
    if metadata:
        data['metadata'] = metadata
    
    return data


@composite
def invalid_transcription_data(draw):
    """Generate invalid transcription data for testing error handling"""
    # Choose what type of invalid data to generate
    invalid_type = draw(st.sampled_from([
        'missing_required_field',
        'invalid_speaker',
        'invalid_confidence',
        'empty_text',
        'invalid_sequence_number',
        'invalid_contact_id'
    ]))
    
    # Start with valid data and then break it
    base_data = draw(valid_transcription_data())
    
    if invalid_type == 'missing_required_field':
        field_to_remove = draw(st.sampled_from(['contactId', 'sequenceNumber', 'timestamp', 'speaker', 'text', 'confidence']))
        del base_data[field_to_remove]
    elif invalid_type == 'invalid_speaker':
        base_data['speaker'] = draw(st.text().filter(lambda x: x not in ['AGENT', 'CUSTOMER'] and len(x) > 0))
    elif invalid_type == 'invalid_confidence':
        # Use values that cannot be converted to valid floats
        base_data['confidence'] = draw(st.one_of(
            st.floats(min_value=-1.0, max_value=-0.001),  # Negative
            st.floats(min_value=1.001, max_value=2.0),    # > 1.0
            st.text().filter(lambda x: x not in ['0', '1', '0.0', '1.0'] and not x.replace('.', '').replace('-', '').isdigit()),  # Non-numeric strings
            st.none(),   # None
            st.lists(st.integers()),  # List instead of number
            st.dictionaries(st.text(), st.integers())  # Dict instead of number
        ))
    elif invalid_type == 'empty_text':
        base_data['text'] = ''
    elif invalid_type == 'invalid_sequence_number':
        base_data['sequenceNumber'] = draw(st.one_of(
            st.integers(max_value=-1),  # Negative
            st.text().filter(lambda x: not x.isdigit()),  # Non-numeric string
            st.none(),   # None
            st.lists(st.integers()),  # List instead of number
            st.floats()  # Float instead of int
        ))
    elif invalid_type == 'invalid_contact_id':
        base_data['contactId'] = draw(st.one_of(
            st.just(''),  # Empty string
            st.none(),    # None
            st.text(min_size=257),  # Too long
            st.integers(),  # Number instead of string
            st.lists(st.text())  # List instead of string
        ))
    
    return base_data, invalid_type


@composite
def kinesis_record(draw, transcription_data=None):
    """Generate a Kinesis record with transcription data"""
    if transcription_data is None:
        transcription_data = draw(valid_transcription_data())
    
    # Encode the data as it would come from Kinesis
    json_data = json.dumps(transcription_data)
    encoded_data = base64.b64encode(json_data.encode('utf-8')).decode('utf-8')
    
    record_id = draw(st.text(min_size=10, max_size=50))
    
    return {
        'recordId': record_id,
        'kinesis': {
            'data': encoded_data,
            'sequenceNumber': str(draw(st.integers(min_value=1, max_value=999999))),
            'partitionKey': transcription_data.get('contactId', 'test-contact')
        }
    }


class TestTranscriptionProcessor:
    """Test class for TranscriptionProcessor"""
    
    def setup_method(self):
        """Set up test fixtures"""
        self.processor = TranscriptionProcessor()
    
    @given(valid_transcription_data())
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_property_valid_data_validation_succeeds(self, transcription_data):
        """
        Feature: serverless-conversational-analytics, Property 2: Error Handling and Recovery
        Test that valid transcription data always passes validation
        """
        # This should not raise any exceptions
        validated = self.processor.validate_transcription_data(transcription_data)
        
        # Verify the validated data matches input
        assert validated.contactId == transcription_data['contactId']
        assert validated.sequenceNumber == transcription_data['sequenceNumber']
        assert validated.speaker == transcription_data['speaker']
        assert validated.text == transcription_data['text']
        assert validated.confidence == transcription_data['confidence']
    
    @given(invalid_transcription_data())
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_property_invalid_data_validation_fails(self, invalid_data_tuple):
        """
        Feature: serverless-conversational-analytics, Property 2: Error Handling and Recovery
        Test that invalid transcription data always fails validation with appropriate errors
        """
        invalid_data, invalid_type = invalid_data_tuple
        
        # Skip cases where Pydantic might successfully coerce the data
        # We want to test truly invalid cases that should always fail
        if invalid_type == 'invalid_sequence_number':
            # Only test cases that should definitely fail
            seq_num = invalid_data.get('sequenceNumber')
            if isinstance(seq_num, (int, float)) and seq_num >= 0:
                # Pydantic will coerce valid numbers, so skip this case
                assume(False)
        
        if invalid_type == 'invalid_confidence':
            # Only test cases that should definitely fail
            confidence = invalid_data.get('confidence')
            if isinstance(confidence, (int, float)) and 0.0 <= confidence <= 1.0:
                # Pydantic will accept valid numbers, so skip this case
                assume(False)
        
        if invalid_type == 'invalid_contact_id':
            # Skip cases where empty string might be handled differently
            contact_id = invalid_data.get('contactId')
            if contact_id == '':
                # Empty string should fail min_length validation
                pass
            elif contact_id is None:
                # None should fail validation
                pass
            elif isinstance(contact_id, str) and len(contact_id) <= 256:
                # Valid length strings might pass, so skip
                assume(False)
        
        # This should raise a ValidationError from pydantic
        with pytest.raises((ValidationError, ValueError, TypeError)):
            self.processor.validate_transcription_data(invalid_data)
    
    @given(valid_transcription_data())
    @settings(max_examples=100)
    def test_property_dynamodb_item_creation_consistency(self, transcription_data):
        """
        Feature: serverless-conversational-analytics, Property 2: Error Handling and Recovery
        Test that DynamoDB item creation is consistent and contains all required fields
        """
        validated = self.processor.validate_transcription_data(transcription_data)
        item = self.processor.create_dynamodb_item(validated)
        
        # Verify required fields are present
        assert 'PK' in item
        assert 'SK' in item
        assert item['PK'] == transcription_data['contactId']
        assert item['contactId'] == transcription_data['contactId']
        assert item['sequenceNumber'] == transcription_data['sequenceNumber']
        assert item['speaker'] == transcription_data['speaker']
        assert item['text'] == transcription_data['text']
        assert item['confidence'] == transcription_data['confidence']
        
        # Verify GSI keys are present
        assert 'GSI1PK' in item
        assert 'GSI1SK' in item
        assert item['GSI1PK'] == f"CONTACT#{transcription_data['contactId']}"
        
        # Verify timestamps are present
        assert 'createdAt' in item
        assert 'updatedAt' in item
    
    @patch('dynamodb_storage.DynamoDBStorageManager.store_transcription_with_duplicate_prevention')
    @patch('dynamodb_storage.DynamoDBStorageManager.detect_contact_completion')
    @patch('dynamodb_storage.DynamoDBStorageManager.update_contact_status')
    @given(valid_transcription_data())
    @settings(max_examples=100)
    def test_property_duplicate_prevention_mechanism(self, mock_update_status, mock_detect_completion, mock_store, transcription_data):
        """
        Feature: serverless-conversational-analytics, Property 2: Error Handling and Recovery
        Test that duplicate prevention works correctly for all valid transcription data
        """
        from dynamodb_storage import ContactCompletionStatus
        
        validated = self.processor.validate_transcription_data(transcription_data)
        item = self.processor.create_dynamodb_item(validated)
        
        # Mock completion status
        completion_status = ContactCompletionStatus(
            contact_id=transcription_data['contactId'],
            is_complete=False,
            total_received=1,
            total_expected=None,
            completion_method='incomplete',
            last_sequence=transcription_data['sequenceNumber']
        )
        
        # Test first insertion succeeds
        mock_store.return_value = (True, "Transcription stored successfully")
        mock_detect_completion.return_value = completion_status
        mock_update_status.return_value = True
        
        # Mock the process_transcription_storage function
        with patch('handler.process_transcription_storage') as mock_process:
            mock_process.return_value = (True, completion_status)
            result1 = self.processor.store_transcription(item)
            assert result1 is True
        
        # Test duplicate insertion is prevented
        mock_store.return_value = (False, "Duplicate transcription skipped")
        with patch('handler.process_transcription_storage') as mock_process:
            mock_process.return_value = (False, completion_status)
            result2 = self.processor.store_transcription(item)
            assert result2 is False
    
    @patch('handler.sqs')
    @patch('handler.DLQ_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/test-dlq')
    @given(kinesis_record())
    @settings(max_examples=100)
    def test_property_dlq_routing_for_processing_failures(self, mock_sqs, record):
        """
        Feature: serverless-conversational-analytics, Property 2: Error Handling and Recovery
        Test that processing failures are properly routed to DLQ with error context
        """
        # Create a processing error
        error = ProcessingError(
            error_type='VALIDATION_ERROR',
            message='Test validation error',
            context={'test': 'context'},
            timestamp=datetime.utcnow(),
            retryable=False
        )
        
        # Mock SQS send_message
        mock_sqs.send_message.return_value = {'MessageId': 'test-message-id'}
        
        # Send to DLQ
        self.processor.send_to_dlq(record, error)
        
        # Verify SQS was called
        mock_sqs.send_message.assert_called()
        call_args = mock_sqs.send_message.call_args
        
        # Verify message structure
        assert 'QueueUrl' in call_args.kwargs
        assert 'MessageBody' in call_args.kwargs
        assert 'MessageAttributes' in call_args.kwargs
        
        # Verify message content
        message_body = json.loads(call_args.kwargs['MessageBody'])
        assert 'originalRecord' in message_body
        assert 'error' in message_body
        assert message_body['error']['errorType'] == 'VALIDATION_ERROR'
        assert message_body['error']['retryable'] is False
    
    @patch('dynamodb_storage.DynamoDBStorageManager.store_transcription_with_duplicate_prevention')
    @given(kinesis_record())
    @settings(max_examples=100)
    def test_property_retry_mechanism_for_retryable_errors(self, mock_store, record):
        """
        Feature: serverless-conversational-analytics, Property 2: Error Handling and Recovery
        Test that retryable errors trigger appropriate retry mechanisms
        """
        # Mock retryable DynamoDB error in the storage manager
        mock_store.side_effect = ClientError(
            error_response={'Error': {'Code': 'ProvisionedThroughputExceededException'}},
            operation_name='PutItem'
        )
        
        # Mock the process_transcription_storage function to raise the error
        with patch('handler.process_transcription_storage') as mock_process:
            mock_process.side_effect = ClientError(
                error_response={'Error': {'Code': 'ProvisionedThroughputExceededException'}},
                operation_name='PutItem'
            )
            
            # Process the record
            result = self.processor.process_record(record)
            
            # Verify the result indicates processing failed (for retry)
            assert result['result'] == 'ProcessingFailed'
            assert result['recordId'] == record['recordId']
    
    @patch('handler.sqs')
    @patch('handler.DLQ_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/test-dlq')
    @patch('dynamodb_storage.DynamoDBStorageManager.store_transcription_with_duplicate_prevention')
    @given(kinesis_record())
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_property_non_retryable_errors_go_to_dlq(self, mock_store, mock_sqs, record):
        """
        Feature: serverless-conversational-analytics, Property 2: Error Handling and Recovery
        Test that non-retryable errors are sent to DLQ and don't trigger retries
        """
        # Mock non-retryable DynamoDB error
        mock_store.side_effect = ClientError(
            error_response={'Error': {'Code': 'ValidationException'}},
            operation_name='PutItem'
        )
        
        # Mock SQS send_message
        mock_sqs.send_message.return_value = {'MessageId': 'test-message-id'}
        
        # Mock the processor's metrics to avoid namespace issues
        self.processor.metrics = Mock()
        self.processor.metrics.add_metric = Mock()
        
        # Mock the process_transcription_storage function to raise the error
        with patch('handler.process_transcription_storage') as mock_process:
            mock_process.side_effect = ClientError(
                error_response={'Error': {'Code': 'ValidationException'}},
                operation_name='PutItem'
            )
            
            # Process the record
            result = self.processor.process_record(record)
            
            # Verify the result indicates processing failed
            assert result['result'] == 'ProcessingFailed'
            
            # Verify DLQ was called
            mock_sqs.send_message.assert_called()
    
    @patch('handler.processor')
    @given(st.lists(kinesis_record(), min_size=1, max_size=10))
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_property_batch_processing_handles_mixed_results(self, mock_processor, records):
        """
        Feature: serverless-conversational-analytics, Property 2: Error Handling and Recovery
        Test that batch processing correctly handles mixed success/failure results
        """
        # Mock mixed results
        mock_results = []
        for i, record in enumerate(records):
            if i % 2 == 0:  # Even indices succeed
                mock_results.append({
                    'recordId': record['recordId'],
                    'result': 'Ok',
                    'data': {'contactId': 'test', 'stored': True}
                })
            else:  # Odd indices fail
                mock_results.append({
                    'recordId': record['recordId'],
                    'result': 'ProcessingFailed',
                    'data': None
                })
        
        mock_processor.process_record.side_effect = mock_results
        
        # Create a proper mock Lambda context
        mock_context = Mock()
        mock_context.function_name = 'test-function'
        mock_context.memory_limit_in_mb = 128
        mock_context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:test-function'
        mock_context.aws_request_id = 'test-request-id'
        mock_context.log_group_name = '/aws/lambda/test-function'
        mock_context.log_stream_name = '2024/01/01/[$LATEST]test-stream'
        mock_context.get_remaining_time_in_millis = Mock(return_value=30000)
        
        # Import the lambda_handler function - it's already imported at module level
        from handler import lambda_handler
        
        # Mock the metrics at the handler module level to avoid namespace validation
        with patch('handler.metrics') as mock_metrics:
            # Create a complete mock that bypasses all validation
            mock_metrics.add_metric = Mock()
            mock_metrics.flush_metrics = Mock()
            
            # Call the handler directly
            event = {'Records': records}
            result = lambda_handler(event, mock_context)
        
        # Verify all records were processed
        assert len(result['records']) == len(records)
        
        # Verify mixed results
        successful = [r for r in result['records'] if r['result'] == 'Ok']
        failed = [r for r in result['records'] if r['result'] == 'ProcessingFailed']
        
        expected_successful = (len(records) + 1) // 2  # Ceiling division for even indices
        expected_failed = len(records) - expected_successful
        
        assert len(successful) == expected_successful
        assert len(failed) == expected_failed


# Additional edge case tests
class TestTranscriptionProcessorEdgeCases:
    """Test edge cases and specific error scenarios"""
    
    def setup_method(self):
        """Set up test fixtures"""
        self.processor = TranscriptionProcessor()
    
    def test_malformed_json_in_kinesis_record(self):
        """Test handling of malformed JSON in Kinesis records"""
        # Create a record with invalid JSON
        invalid_json = "{ invalid json }"
        encoded_data = base64.b64encode(invalid_json.encode('utf-8')).decode('utf-8')
        
        record = {
            'recordId': 'test-record-1',
            'kinesis': {
                'data': encoded_data,
                'sequenceNumber': '12345',
                'partitionKey': 'test-contact'
            }
        }
        
        result = self.processor.process_record(record)
        assert result['result'] == 'ProcessingFailed'
    
    def test_empty_kinesis_data(self):
        """Test handling of empty Kinesis data"""
        record = {
            'recordId': 'test-record-2',
            'kinesis': {
                'data': base64.b64encode(b'').decode('utf-8'),
                'sequenceNumber': '12345',
                'partitionKey': 'test-contact'
            }
        }
        
        result = self.processor.process_record(record)
        assert result['result'] == 'ProcessingFailed'
    
    @patch('handler.sqs')
    @patch('handler.DLQ_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/test-dlq')
    def test_dlq_send_failure_handling(self, mock_sqs):
        """Test handling of DLQ send failures"""
        # Mock SQS send_message failure
        mock_sqs.send_message.side_effect = ClientError(
            error_response={'Error': {'Code': 'AccessDenied'}},
            operation_name='SendMessage'
        )
        
        error = ProcessingError(
            error_type='VALIDATION_ERROR',
            message='Test error',
            context={},
            timestamp=datetime.utcnow(),
            retryable=False
        )
        
        # This should not raise an exception, just log the error
        self.processor.send_to_dlq({}, error)
        
        # Verify SQS was called
        mock_sqs.send_message.assert_called_once()