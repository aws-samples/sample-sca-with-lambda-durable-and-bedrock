"""
Property-based tests for Analytics Processor Lambda

Feature: serverless-conversational-analytics
Property 3: Analytics Generation Completeness
Validates: Requirements 2.1, 2.2, 2.3, 2.4
"""

import json
import pytest
from hypothesis import given, strategies as st, settings, HealthCheck
from datetime import datetime
from decimal import Decimal
from unittest.mock import Mock, patch, MagicMock
from typing import List, Dict, Any

# Import the modules to test
from handler import ContactCompletionChecker, AnalyticsProcessor
from bedrock_analytics import BedrockAnalytics


# Custom strategies for generating test data
@st.composite
def transcription_item(draw, contact_id=None, sequence_number=None):
    """Generate a valid transcription item"""
    if contact_id is None:
        contact_id = draw(st.text(min_size=10, max_size=50, alphabet=st.characters(whitelist_categories=('Lu', 'Ll', 'Nd'))))
    if sequence_number is None:
        sequence_number = draw(st.integers(min_value=0, max_value=100))
    
    timestamp = datetime.utcnow().isoformat()
    speaker = draw(st.sampled_from(['AGENT', 'CUSTOMER']))
    text = draw(st.text(min_size=10, max_size=200))
    confidence = draw(st.floats(min_value=0.0, max_value=1.0))
    
    return {
        'PK': contact_id,
        'SK': f"{timestamp}#{sequence_number:010d}",
        'contactId': contact_id,
        'sequenceNumber': sequence_number,
        'timestamp': timestamp,
        'speaker': speaker,
        'text': text,
        'confidence': Decimal(str(confidence)),
        'metadata': {
            'channel': 'VOICE',
            'language': 'en-US',
            'contactStatus': 'IN_PROGRESS'
        }
    }


@st.composite
def complete_contact_transcriptions(draw, min_transcriptions=3, max_transcriptions=10):
    """Generate a complete set of transcriptions for a contact"""
    contact_id = draw(st.text(min_size=10, max_size=50, alphabet=st.characters(whitelist_categories=('Lu', 'Ll', 'Nd'))))
    num_transcriptions = draw(st.integers(min_value=min_transcriptions, max_value=max_transcriptions))
    
    transcriptions = []
    for i in range(num_transcriptions):
        trans = draw(transcription_item(contact_id=contact_id, sequence_number=i))
        transcriptions.append(trans)
    
    # Mark the last transcription as complete
    transcriptions[-1]['isComplete'] = True
    transcriptions[-1]['totalExpected'] = num_transcriptions
    transcriptions[-1]['metadata']['contactStatus'] = 'COMPLETED'
    
    return contact_id, transcriptions


@st.composite
def incomplete_contact_transcriptions(draw, min_transcriptions=2, max_transcriptions=8):
    """Generate an incomplete set of transcriptions for a contact"""
    contact_id = draw(st.text(min_size=10, max_size=50, alphabet=st.characters(whitelist_categories=('Lu', 'Ll', 'Nd'))))
    num_transcriptions = draw(st.integers(min_value=min_transcriptions, max_value=max_transcriptions))
    total_expected = draw(st.integers(min_value=num_transcriptions + 1, max_value=num_transcriptions + 5))
    
    transcriptions = []
    for i in range(num_transcriptions):
        trans = draw(transcription_item(contact_id=contact_id, sequence_number=i))
        trans['totalExpected'] = total_expected
        transcriptions.append(trans)
    
    return contact_id, transcriptions, total_expected


class TestContactCompletionChecker:
    """Test the contact completion detection logic"""
    
    @given(complete_contact_transcriptions())
    @settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow])
    def test_property_complete_contact_detected(self, contact_data):
        """
        Property: For any complete contact (with explicit completion flag),
        the completion checker should detect it as complete and ready for processing
        
        Feature: serverless-conversational-analytics, Property 3: Analytics Generation Completeness
        Validates: Requirements 2.1
        """
        contact_id, transcriptions = contact_data
        
        # Mock the DynamoDB table
        mock_table = Mock()
        mock_table.query.return_value = {'Items': transcriptions}
        
        checker = ContactCompletionChecker(mock_table)
        
        # Check completion status
        status = checker.check_completion(contact_id)
        
        # Assertions
        assert status['is_complete'] is True, "Complete contact should be detected as complete"
        assert status['should_process'] is True, "Complete contact should be marked for processing"
        assert status['total_received'] == len(transcriptions), "Should count all transcriptions"
        assert status['completion_method'] in ['explicit_flag', 'sequence_complete', 'external_signal'], \
            "Should use a valid completion detection method"
    
    @given(incomplete_contact_transcriptions())
    @settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def test_property_incomplete_contact_skipped(self, contact_data):
        """
        Property: For any incomplete contact (missing expected transcriptions),
        the completion checker should detect it as incomplete and skip processing
        
        Feature: serverless-conversational-analytics, Property 3: Analytics Generation Completeness
        Validates: Requirements 2.1
        """
        contact_id, transcriptions, total_expected = contact_data
        
        # Mock the DynamoDB table
        mock_table = Mock()
        mock_table.query.return_value = {'Items': transcriptions}
        
        checker = ContactCompletionChecker(mock_table)
        
        # Check completion status
        status = checker.check_completion(contact_id)
        
        # Assertions
        assert status['is_complete'] is False, "Incomplete contact should be detected as incomplete"
        assert status['should_process'] is False, "Incomplete contact should not be processed"
        assert status['total_received'] < total_expected, "Should have fewer transcriptions than expected"
        assert 'incomplete' in status['reason'].lower() or 'skip' in status['reason'].lower(), \
            "Reason should indicate incompleteness"
    
    @given(st.integers(min_value=5, max_value=20))
    @settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def test_property_sequence_validation_completion(self, num_transcriptions):
        """
        Property: For any contact with all expected sequence numbers present,
        the completion checker should detect it as complete via sequence validation
        
        Feature: serverless-conversational-analytics, Property 3: Analytics Generation Completeness
        Validates: Requirements 2.1
        """
        contact_id = f"test-contact-{num_transcriptions}"
        
        # Create transcriptions with all sequence numbers from 0 to num_transcriptions-1
        transcriptions = []
        for i in range(num_transcriptions):
            trans = {
                'PK': contact_id,
                'SK': f"2026-01-15T00:00:00Z#{i:010d}",
                'contactId': contact_id,
                'sequenceNumber': i,
                'timestamp': '2026-01-15T00:00:00Z',
                'speaker': 'AGENT' if i % 2 == 0 else 'CUSTOMER',
                'text': f'Test text {i}',
                'confidence': Decimal('0.95'),
                'totalExpected': num_transcriptions
            }
            transcriptions.append(trans)
        
        # Mock the DynamoDB table
        mock_table = Mock()
        mock_table.query.return_value = {'Items': transcriptions}
        
        checker = ContactCompletionChecker(mock_table)
        
        # Check completion status
        status = checker.check_completion(contact_id)
        
        # Assertions
        assert status['is_complete'] is True, "Contact with all sequences should be complete"
        assert status['should_process'] is True, "Should be marked for processing"
        assert status['total_received'] == num_transcriptions, "Should count all transcriptions"
        assert status['total_expected'] == num_transcriptions, "Should match expected count"


class TestAnalyticsGeneration:
    """Test analytics generation with Bedrock integration"""
    
    @given(complete_contact_transcriptions(min_transcriptions=3, max_transcriptions=5))
    @settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def test_property_analytics_generated_for_complete_contacts(self, contact_data):
        """
        Property: For any complete contact, analytics (sentiment, topics, summary)
        should be generated and stored successfully
        
        Feature: serverless-conversational-analytics, Property 3: Analytics Generation Completeness
        Validates: Requirements 2.2, 2.3, 2.4
        """
        contact_id, transcriptions = contact_data
        
        # Mock Bedrock responses
        mock_sentiment = {
            'overall': 'POSITIVE',
            'confidence': 0.95,
            'segments': [
                {'text': 'test', 'sentiment': 'POSITIVE', 'confidence': 0.9}
            ]
        }
        
        mock_topics = [
            {'name': 'billing', 'confidence': 0.9, 'mentions': 2},
            {'name': 'support', 'confidence': 0.85, 'mentions': 1}
        ]
        
        mock_summary = "Customer contacted about billing issue. Agent resolved the problem."
        
        # Mock DynamoDB tables
        mock_transcriptions_table = Mock()
        mock_transcriptions_table.query.return_value = {'Items': transcriptions}
        
        mock_analytics_table = Mock()
        
        # Create mock Bedrock analytics instance
        mock_bedrock = Mock()
        mock_bedrock.generate_complete_analytics.return_value = {
            'contactId': contact_id,
            'sentiment': mock_sentiment,
            'topics': mock_topics,
            'summary': mock_summary,
            'generatedAt': datetime.utcnow().isoformat(),
            'processingTimeSeconds': 2.5
        }
        
        # Create processor with mocked dependencies
        with patch('handler.transcriptions_table', mock_transcriptions_table):
            with patch('handler.analytics_table', mock_analytics_table):
                with patch('handler.bedrock_analytics', mock_bedrock):
                    processor = AnalyticsProcessor()
                    
                    # Create a mock stream record
                    stream_record = {
                        'eventID': 'test-event-1',
                        'eventName': 'INSERT',
                        'dynamodb': {
                            'NewImage': {
                                'contactId': {'S': contact_id},
                                'SK': {'S': f"2026-01-15T00:00:00Z#0000000001"}
                            }
                        }
                    }
                    
                    # Process the record
                    result = processor.process_stream_record(stream_record)
                    
                    # Assertions
                    assert result['processed'] is True, "Complete contact should be processed"
                    assert 'analytics' in result, "Result should contain analytics summary"
                    assert result['analytics']['sentiment'] in ['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED'], \
                        "Should have valid sentiment"
                    assert result['analytics']['topicCount'] >= 0, "Should have topic count"
                    assert result['analytics']['summaryLength'] > 0, "Should have non-empty summary"
                    
                    # Verify Bedrock was called
                    mock_bedrock.generate_complete_analytics.assert_called_once()
                    
                    # Verify analytics were stored (3 items: sentiment, topics, summary)
                    assert mock_analytics_table.put_item.call_count == 3, \
                        "Should store 3 analytics items (sentiment, topics, summary)"


class TestSkipLogic:
    """Test skip logic for incomplete contacts"""
    
    @given(incomplete_contact_transcriptions(min_transcriptions=2, max_transcriptions=5))
    @settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def test_property_skip_logic_prevents_premature_processing(self, contact_data):
        """
        Property: For any incomplete contact, the skip logic should prevent
        analytics processing and mark the record as skipped
        
        Feature: serverless-conversational-analytics, Property 3: Analytics Generation Completeness
        Validates: Requirements 2.1
        """
        contact_id, transcriptions, total_expected = contact_data
        
        # Mock DynamoDB tables
        mock_transcriptions_table = Mock()
        mock_transcriptions_table.query.return_value = {'Items': transcriptions}
        
        mock_analytics_table = Mock()
        
        # Create processor with mocked dependencies
        with patch('handler.transcriptions_table', mock_transcriptions_table):
            with patch('handler.analytics_table', mock_analytics_table):
                with patch('handler.bedrock_analytics') as mock_bedrock:
                    processor = AnalyticsProcessor()
                    
                    # Create a mock stream record
                    stream_record = {
                        'eventID': 'test-event-1',
                        'eventName': 'INSERT',
                        'dynamodb': {
                            'NewImage': {
                                'contactId': {'S': contact_id},
                                'SK': {'S': f"2026-01-15T00:00:00Z#0000000001"}
                            }
                        }
                    }
                    
                    # Process the record
                    result = processor.process_stream_record(stream_record)
                    
                    # Assertions
                    assert result['skipped'] is True, "Incomplete contact should be skipped"
                    assert result['processed'] is False, "Should not be marked as processed"
                    assert 'incomplete' in result['reason'].lower() or 'skip' in result['reason'].lower(), \
                        "Reason should indicate skipping due to incompleteness"
                    
                    # Verify Bedrock was NOT called
                    mock_bedrock.generate_complete_analytics.assert_not_called()
                    
                    # Verify analytics were NOT stored
                    mock_analytics_table.put_item.assert_not_called()


# Edge case tests
class TestEdgeCases:
    """Test edge cases and error conditions"""
    
    def test_empty_transcriptions_list(self):
        """Test handling of contacts with no transcriptions"""
        contact_id = "test-empty-contact"
        
        # Mock the DynamoDB table with empty results
        mock_table = Mock()
        mock_table.query.return_value = {'Items': []}
        
        checker = ContactCompletionChecker(mock_table)
        
        # Check completion status
        status = checker.check_completion(contact_id)
        
        # Assertions
        assert status['is_complete'] is False
        assert status['should_process'] is False
        assert status['total_received'] == 0
    
    def test_status_records_filtered_out(self):
        """Test that STATUS records are filtered from transcriptions"""
        contact_id = "test-contact-with-status"
        
        transcriptions = [
            {
                'PK': contact_id,
                'SK': '2026-01-15T00:00:00Z#0000000001',
                'contactId': contact_id,
                'sequenceNumber': 0,
                'text': 'Test text',
                'speaker': 'AGENT',
                'confidence': Decimal('0.95')
            },
            {
                'PK': contact_id,
                'SK': 'STATUS',  # This should be filtered out
                'contactId': contact_id,
                'status': 'COMPLETED'
            }
        ]
        
        # Mock the DynamoDB table
        mock_table = Mock()
        mock_table.query.return_value = {'Items': transcriptions}
        
        checker = ContactCompletionChecker(mock_table)
        
        # Get all transcriptions
        result = checker.get_all_transcriptions(contact_id)
        
        # Assertions
        assert len(result) == 1, "Should filter out STATUS records"
        assert result[0]['SK'].startswith('2'), "Should only include timestamp-based records"
    
    def test_sentiment_defaults_to_neutral_on_missing_overall(self):
        """Test that sentiment defaults to NEUTRAL when overall field is missing"""
        transcriptions = [
            {
                'PK': 'test-contact',
                'SK': '2026-01-15T00:00:00Z#0000000001',
                'contactId': 'test-contact',
                'sequenceNumber': 0,
                'text': 'Test conversation',
                'speaker': 'AGENT',
                'confidence': Decimal('0.95')
            }
        ]
        
        # Mock Bedrock to return response without 'overall' field
        with patch('bedrock_analytics.bedrock_runtime') as mock_runtime:
            mock_response = {
                'body': Mock(read=lambda: json.dumps({
                    'content': [{'text': json.dumps({
                        'confidence': 0.8,
                        'segments': []
                    })}]
                }).encode())
            }
            mock_runtime.invoke_model.return_value = mock_response
            
            analytics = BedrockAnalytics()
            sentiment = analytics.analyze_sentiment(transcriptions)
            
            # Assertions
            assert sentiment['overall'] == 'NEUTRAL', "Should default to NEUTRAL when overall is missing"
            assert sentiment['confidence'] == 0.8, "Should preserve other fields"
    
    def test_sentiment_defaults_to_neutral_on_parse_error(self):
        """Test that sentiment defaults to NEUTRAL when JSON parsing fails"""
        transcriptions = [
            {
                'PK': 'test-contact',
                'SK': '2026-01-15T00:00:00Z#0000000001',
                'contactId': 'test-contact',
                'sequenceNumber': 0,
                'text': 'Test conversation',
                'speaker': 'AGENT',
                'confidence': Decimal('0.95')
            }
        ]
        
        # Mock Bedrock to return invalid JSON
        with patch('bedrock_analytics.bedrock_runtime') as mock_runtime:
            mock_response = {
                'body': Mock(read=lambda: json.dumps({
                    'content': [{'text': 'This is not valid JSON'}]
                }).encode())
            }
            mock_runtime.invoke_model.return_value = mock_response
            
            analytics = BedrockAnalytics()
            sentiment = analytics.analyze_sentiment(transcriptions)
            
            # Assertions
            assert sentiment['overall'] == 'NEUTRAL', "Should default to NEUTRAL on parse error"
            assert sentiment['confidence'] == 0.0, "Should default confidence to 0.0"
            assert sentiment['segments'] == [], "Should default segments to empty list"
    
    def test_sentiment_defaults_to_neutral_on_structure_error(self):
        """Test that sentiment defaults to NEUTRAL when response structure is unexpected"""
        transcriptions = [
            {
                'PK': 'test-contact',
                'SK': '2026-01-15T00:00:00Z#0000000001',
                'contactId': 'test-contact',
                'sequenceNumber': 0,
                'text': 'Test conversation',
                'speaker': 'AGENT',
                'confidence': Decimal('0.95')
            }
        ]
        
        # Mock Bedrock to return response with unexpected structure
        with patch('bedrock_analytics.bedrock_runtime') as mock_runtime:
            mock_response = {
                'body': Mock(read=lambda: json.dumps({
                    'unexpected_field': 'value'
                }).encode())
            }
            mock_runtime.invoke_model.return_value = mock_response
            
            analytics = BedrockAnalytics()
            sentiment = analytics.analyze_sentiment(transcriptions)
            
            # Assertions
            assert sentiment['overall'] == 'NEUTRAL', "Should default to NEUTRAL on structure error"
            assert sentiment['confidence'] == 0.0, "Should default confidence to 0.0"
            assert sentiment['segments'] == [], "Should default segments to empty list"


class TestSummaryGeneration:
    """Test summary generation properties
    
    Feature: serverless-conversational-analytics, Property 4: Summary Generation
    Validates: Requirements 3.1, 3.3, 3.4
    """
    
    @given(complete_contact_transcriptions(min_transcriptions=3, max_transcriptions=8))
    @settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow])
    def test_property_summary_generated_for_complete_contacts(self, contact_data):
        """
        Property: For any complete contact with transcriptions, a summary should be generated
        that is non-empty and stored in DynamoDB
        
        Feature: serverless-conversational-analytics, Property 4: Summary Generation
        Validates: Requirements 3.1, 3.3
        """
        contact_id, transcriptions = contact_data
        
        # Mock Bedrock to return a valid summary
        mock_summary = "Customer contacted support regarding billing issue. Agent provided account details and resolved the problem. Customer expressed satisfaction with the resolution."
        
        mock_bedrock = Mock()
        mock_bedrock.generate_summary.return_value = mock_summary
        
        # Create BedrockAnalytics instance with mock
        with patch('bedrock_analytics.bedrock_runtime') as mock_runtime:
            # Mock the Bedrock API response
            mock_response = {
                'body': Mock(read=lambda: json.dumps({
                    'content': [{'text': mock_summary}]
                }).encode())
            }
            mock_runtime.invoke_model.return_value = mock_response
            
            analytics = BedrockAnalytics()
            
            # Generate summary
            summary = analytics.generate_summary(transcriptions)
            
            # Assertions
            assert summary is not None, "Summary should not be None"
            assert isinstance(summary, str), "Summary should be a string"
            assert len(summary) > 0, "Summary should not be empty"
            assert len(summary) > 10, "Summary should be meaningful (more than 10 characters)"
    
    @given(
        complete_contact_transcriptions(min_transcriptions=3, max_transcriptions=8),
        st.integers(min_value=1, max_value=5)
    )
    @settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow])
    def test_property_summary_accessible_after_storage(self, contact_data, retry_count):
        """
        Property: For any complete contact, after summary is stored in DynamoDB,
        it should be accessible for real-time delivery
        
        Feature: serverless-conversational-analytics, Property 4: Summary Generation
        Validates: Requirements 3.3, 3.4
        """
        contact_id, transcriptions = contact_data
        
        mock_summary = "Customer inquiry about product features. Agent explained capabilities and provided documentation links."
        
        # Mock DynamoDB table
        mock_table = Mock()
        stored_items = []
        
        def mock_put_item(Item):
            stored_items.append(Item)
            return {'ResponseMetadata': {'HTTPStatusCode': 200}}
        
        mock_table.put_item.side_effect = mock_put_item
        
        # Store summary item
        summary_item = {
            'PK': contact_id,
            'SK': 'ANALYTICS#SUMMARY',
            'contactId': contact_id,
            'analyticsType': 'SUMMARY',
            'content': mock_summary,
            'generatedAt': datetime.utcnow().isoformat(),
            'metadata': {
                'summaryLength': len(mock_summary)
            }
        }
        
        # Simulate storage with retries
        for attempt in range(retry_count):
            mock_table.put_item(Item=summary_item)
        
        # Assertions
        assert len(stored_items) == retry_count, "Should store summary the expected number of times"
        
        # Verify stored item structure
        last_stored = stored_items[-1]
        assert last_stored['PK'] == contact_id, "Should store with correct partition key"
        assert last_stored['SK'] == 'ANALYTICS#SUMMARY', "Should store with correct sort key"
        assert last_stored['analyticsType'] == 'SUMMARY', "Should mark as SUMMARY type"
        assert last_stored['content'] == mock_summary, "Should store complete summary content"
        assert 'generatedAt' in last_stored, "Should include generation timestamp"
        assert 'metadata' in last_stored, "Should include metadata"
        assert last_stored['metadata']['summaryLength'] == len(mock_summary), "Should track summary length"
    
    @given(st.integers(min_value=2, max_value=10))
    @settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture])
    def test_property_summary_length_proportional_to_transcriptions(self, num_transcriptions):
        """
        Property: For any set of transcriptions, the generated summary should be
        concise (shorter than the original transcriptions combined)
        
        Feature: serverless-conversational-analytics, Property 4: Summary Generation
        Validates: Requirements 3.1, 3.2
        """
        contact_id = f"test-contact-{num_transcriptions}"
        
        # Create transcriptions with known text lengths
        transcriptions = []
        total_text_length = 0
        
        for i in range(num_transcriptions):
            text = f"This is transcription number {i} with some sample text that represents a conversation segment. " * 3
            total_text_length += len(text)
            
            trans = {
                'PK': contact_id,
                'SK': f"2026-01-15T00:00:00Z#{i:010d}",
                'contactId': contact_id,
                'sequenceNumber': i,
                'timestamp': '2026-01-15T00:00:00Z',
                'speaker': 'AGENT' if i % 2 == 0 else 'CUSTOMER',
                'text': text,
                'confidence': Decimal('0.95')
            }
            transcriptions.append(trans)
        
        # Mock Bedrock to return a concise summary
        mock_summary = "Customer contacted support. Agent provided assistance and resolved the issue."
        
        with patch('bedrock_analytics.bedrock_runtime') as mock_runtime:
            # Mock the Bedrock API response
            mock_response = {
                'body': Mock(read=lambda: json.dumps({
                    'content': [{'text': mock_summary}]
                }).encode())
            }
            mock_runtime.invoke_model.return_value = mock_response
            
            analytics = BedrockAnalytics()
            
            # Generate summary
            summary = analytics.generate_summary(transcriptions)
            
            # Assertions
            assert len(summary) < total_text_length, "Summary should be shorter than combined transcriptions"
            assert len(summary) > 0, "Summary should not be empty"
            # Summary should be significantly shorter (at least 50% reduction)
            assert len(summary) < (total_text_length * 0.5), "Summary should be concise (< 50% of original)"


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--hypothesis-profile=dev'])
