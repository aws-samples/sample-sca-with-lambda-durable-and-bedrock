"""
Property-based tests for Data Query Functionality
Tests Property 9: Data Query Functionality
Validates: Requirements 6.2
"""

import json
import os
import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import Mock, patch, MagicMock
from hypothesis import given, strategies as st, settings, assume, HealthCheck
from hypothesis.strategies import composite
from typing import Dict, List, Any

# Set environment variables before importing handler
os.environ['TRANSCRIPTIONS_TABLE'] = 'test-transcriptions-table'
os.environ['ANALYTICS_TABLE'] = 'test-analytics-table'
os.environ['AWS_REGION'] = 'us-east-1'
os.environ['AWS_ACCESS_KEY_ID'] = 'testing'
os.environ['AWS_SECRET_ACCESS_KEY'] = 'testing'
os.environ['AWS_SECURITY_TOKEN'] = 'testing'
os.environ['AWS_SESSION_TOKEN'] = 'testing'

# Mock boto3 and AWS Lambda Powertools before importing handler
with patch('boto3.resource') as mock_boto_resource, \
     patch('aws_lambda_powertools.Logger') as mock_logger_class, \
     patch('aws_lambda_powertools.Tracer') as mock_tracer_class:
    
    # Mock DynamoDB tables
    mock_transcriptions_table = Mock()
    mock_analytics_table = Mock()
    
    def resource_side_effect(service_name):
        mock_dynamodb = Mock()
        mock_dynamodb.Table = Mock(side_effect=lambda name: 
            mock_transcriptions_table if 'transcriptions' in name.lower() 
            else mock_analytics_table
        )
        return mock_dynamodb
    
    mock_boto_resource.side_effect = resource_side_effect
    
    mock_logger = Mock()
    mock_logger.info = Mock()
    mock_logger.error = Mock()
    mock_logger_class.return_value = mock_logger
    
    mock_tracer = Mock()
    mock_tracer.capture_method = lambda func: func
    mock_tracer.capture_lambda_handler = lambda func: func
    mock_tracer_class.return_value = mock_tracer
    
    from handler import (
        get_contact, 
        get_transcriptions, 
        get_analytics, 
        list_contacts,
        DecimalEncoder
    )


# Custom strategies for generating test data
@composite
def contact_id_strategy(draw):
    """Generate valid contact IDs"""
    return draw(st.text(
        min_size=10, 
        max_size=50, 
        alphabet=st.characters(min_codepoint=48, max_codepoint=122)
    ))


@composite
def transcription_item_strategy(draw, contact_id: str):
    """Generate a valid transcription item for DynamoDB"""
    sequence_number = draw(st.integers(min_value=0, max_value=100))
    timestamp = datetime.utcnow().isoformat()
    speaker = draw(st.sampled_from(['AGENT', 'CUSTOMER']))
    text = draw(st.text(min_size=1, max_size=200))
    confidence = draw(st.floats(min_value=0.0, max_value=1.0))
    
    return {
        'contact_id': contact_id,
        'sequence_number': sequence_number,
        'timestamp': timestamp,
        'speaker': speaker,
        'text': text,
        'confidence': Decimal(str(confidence)),
        'is_complete': draw(st.booleans())
    }


@composite
def analytics_item_strategy(draw, contact_id: str):
    """Generate a valid analytics item for DynamoDB"""
    return {
        'contact_id': contact_id,
        'summary': draw(st.text(min_size=10, max_size=500)),
        'sentiment': {
            'overall': draw(st.sampled_from(['POSITIVE', 'NEGATIVE', 'NEUTRAL', 'MIXED'])),
            'confidence': Decimal(str(draw(st.floats(min_value=0.0, max_value=1.0))))
        },
        'topics': [
            {
                'name': draw(st.text(min_size=3, max_size=20)),
                'confidence': Decimal(str(draw(st.floats(min_value=0.0, max_value=1.0))))
            }
            for _ in range(draw(st.integers(min_value=1, max_value=5)))
        ],
        'generated_at': datetime.utcnow().isoformat(),
        'timestamp': datetime.utcnow().isoformat()
    }


@composite
def contact_data_strategy(draw):
    """Generate complete contact data with transcriptions and analytics"""
    contact_id = draw(contact_id_strategy())
    num_transcriptions = draw(st.integers(min_value=1, max_value=10))
    
    transcriptions = [
        draw(transcription_item_strategy(contact_id))
        for _ in range(num_transcriptions)
    ]
    
    # Optionally include analytics
    has_analytics = draw(st.booleans())
    analytics = draw(analytics_item_strategy(contact_id)) if has_analytics else None
    
    return {
        'contact_id': contact_id,
        'transcriptions': transcriptions,
        'analytics': analytics
    }


@composite
def time_range_strategy(draw):
    """Generate valid time ranges for queries"""
    base_time = datetime.utcnow()
    start_offset = draw(st.integers(min_value=1, max_value=30))
    end_offset = draw(st.integers(min_value=0, max_value=start_offset - 1)) if start_offset > 1 else 0
    
    start_time = (base_time - timedelta(days=start_offset)).isoformat()
    end_time = (base_time - timedelta(days=end_offset)).isoformat()
    
    return start_time, end_time


# Property 9: Data Query Functionality
# Feature: serverless-conversational-analytics, Property 9: Data Query Functionality

@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow]
)
@given(contact_data=contact_data_strategy())
def test_property_query_by_contact_id_returns_correct_data(contact_data):
    """
    Property: For any valid contact ID query, the system should retrieve and return 
    the appropriate contact data including transcriptions and analytics.
    
    Feature: serverless-conversational-analytics, Property 9: Data Query Functionality
    Validates: Requirements 6.2
    """
    contact_id = contact_data['contact_id']
    transcriptions = contact_data['transcriptions']
    analytics = contact_data['analytics']
    
    # Mock DynamoDB responses
    with patch('handler.transcriptions_table') as mock_trans_table, \
         patch('handler.analytics_table') as mock_analytics_table:
        
        # Setup mock responses
        mock_trans_table.query.return_value = {
            'Items': transcriptions
        }
        
        mock_analytics_table.query.return_value = {
            'Items': [analytics] if analytics else []
        }
        
        # Execute query
        result = get_contact(contact_id)
        
        # Verify the query returns correct data
        assert result['statusCode'] == 200
        assert result['body']['contact_id'] == contact_id
        assert result['body']['transcriptions'] == transcriptions
        
        if analytics:
            assert result['body']['analytics'] == analytics
        else:
            assert result['body']['analytics'] is None
        
        # Verify DynamoDB was queried correctly
        mock_trans_table.query.assert_called_once()
        mock_analytics_table.query.assert_called_once()


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow]
)
@given(contact_id=contact_id_strategy())
def test_property_query_nonexistent_contact_returns_404(contact_id):
    """
    Property: For any contact ID that doesn't exist, the system should return 404.
    
    Feature: serverless-conversational-analytics, Property 9: Data Query Functionality
    Validates: Requirements 6.2
    """
    # Mock DynamoDB responses with empty results
    with patch('handler.transcriptions_table') as mock_trans_table, \
         patch('handler.analytics_table') as mock_analytics_table:
        
        mock_trans_table.query.return_value = {'Items': []}
        mock_analytics_table.query.return_value = {'Items': []}
        
        # Execute query
        result = get_contact(contact_id)
        
        # Verify 404 response
        assert result['statusCode'] == 404
        assert 'not found' in result['body']['message'].lower()


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow]
)
@given(
    contact_data=contact_data_strategy(),
    limit=st.integers(min_value=1, max_value=150)
)
def test_property_list_contacts_respects_limit(contact_data, limit):
    """
    Property: For any list query with a limit, the system should respect the limit
    (capped at 100) and return at most that many results.
    
    Feature: serverless-conversational-analytics, Property 9: Data Query Functionality
    Validates: Requirements 6.2
    """
    # Generate multiple contacts
    num_contacts = min(limit + 10, 120)  # More than limit to test pagination
    contacts = [
        {
            'contact_id': f"contact-{i}",
            'summary': f"Summary {i}",
            'timestamp': datetime.utcnow().isoformat()
        }
        for i in range(num_contacts)
    ]
    
    # Mock DynamoDB scan response
    with patch('handler.analytics_table') as mock_analytics_table:
        # Simulate DynamoDB limiting results
        expected_limit = min(limit, 100)
        returned_contacts = contacts[:expected_limit]
        
        mock_analytics_table.scan.return_value = {
            'Items': returned_contacts,
            'LastEvaluatedKey': {'contact_id': 'next-key'} if len(contacts) > expected_limit else {}
        }
        
        # Create mock event
        mock_event = Mock()
        mock_event.get_query_string_value = Mock(side_effect=lambda key, default_value=None: {
            'limit': str(limit),
            'start_time': None,
            'end_time': None,
            'next_token': None
        }.get(key, default_value))
        
        with patch('handler.app') as mock_app:
            mock_app.current_event = mock_event
            
            # Execute query
            result = list_contacts()
            
            # Verify limit is respected (capped at 100)
            assert result['statusCode'] == 200
            assert len(result['body']['contacts']) <= 100
            assert len(result['body']['contacts']) <= limit


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow]
)
@given(
    contact_data=contact_data_strategy(),
    time_range=time_range_strategy()
)
def test_property_time_range_query_filters_correctly(contact_data, time_range):
    """
    Property: For any valid time range query, the system should return only contacts
    within that time range.
    
    Feature: serverless-conversational-analytics, Property 9: Data Query Functionality
    Validates: Requirements 6.2
    """
    start_time, end_time = time_range
    
    # Create contacts with timestamps in and out of range
    in_range_contact = {
        'contact_id': 'in-range',
        'timestamp': start_time,
        'summary': 'In range'
    }
    
    # Mock DynamoDB scan with filter
    with patch('handler.analytics_table') as mock_analytics_table:
        mock_analytics_table.scan.return_value = {
            'Items': [in_range_contact]
        }
        
        # Create mock event with time range
        mock_event = Mock()
        mock_event.get_query_string_value = Mock(side_effect=lambda key, default_value=None: {
            'start_time': start_time,
            'end_time': end_time,
            'limit': '50',
            'next_token': None
        }.get(key, default_value))
        
        with patch('handler.app') as mock_app:
            mock_app.current_event = mock_event
            
            # Execute query
            result = list_contacts()
            
            # Verify response
            assert result['statusCode'] == 200
            
            # Verify scan was called with filter expression
            call_args = mock_analytics_table.scan.call_args
            assert 'FilterExpression' in call_args[1]


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow]
)
@given(contact_data=contact_data_strategy())
def test_property_transcriptions_sorted_by_sequence(contact_data):
    """
    Property: For any contact, transcriptions should be returned sorted by sequence number.
    
    Feature: serverless-conversational-analytics, Property 9: Data Query Functionality
    Validates: Requirements 6.2
    """
    contact_id = contact_data['contact_id']
    transcriptions = contact_data['transcriptions']
    
    # Shuffle transcriptions to test sorting
    import random
    shuffled = transcriptions.copy()
    random.shuffle(shuffled)
    
    # Mock DynamoDB response with shuffled data
    with patch('handler.transcriptions_table') as mock_trans_table:
        mock_trans_table.query.return_value = {
            'Items': shuffled
        }
        
        # Execute query
        result = get_transcriptions(contact_id)
        
        # Verify transcriptions are sorted
        assert result['statusCode'] == 200
        returned_transcriptions = result['body']['transcriptions']
        
        # Check sorting by sequence number
        sequence_numbers = [t.get('sequence_number', 0) for t in returned_transcriptions]
        assert sequence_numbers == sorted(sequence_numbers)


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture, HealthCheck.too_slow]
)
@given(contact_data=contact_data_strategy())
def test_property_pagination_token_enables_continuation(contact_data):
    """
    Property: For any paginated query, providing a next_token should enable
    continuation of results from where the previous query left off.
    
    Feature: serverless-conversational-analytics, Property 9: Data Query Functionality
    Validates: Requirements 6.2
    """
    # Create pagination scenario
    first_batch = [
        {'contact_id': f'contact-{i}', 'timestamp': datetime.utcnow().isoformat()}
        for i in range(50)
    ]
    
    last_evaluated_key = {'contact_id': 'contact-49'}
    next_token = json.dumps(last_evaluated_key, cls=DecimalEncoder)
    
    # Mock first query with pagination
    with patch('handler.analytics_table') as mock_analytics_table:
        mock_analytics_table.scan.return_value = {
            'Items': first_batch,
            'LastEvaluatedKey': last_evaluated_key
        }
        
        # Create mock event
        mock_event = Mock()
        mock_event.get_query_string_value = Mock(side_effect=lambda key, default_value=None: {
            'limit': '50',
            'start_time': None,
            'end_time': None,
            'next_token': None
        }.get(key, default_value))
        
        with patch('handler.app') as mock_app:
            mock_app.current_event = mock_event
            
            # Execute first query
            result = list_contacts()
            
            # Verify pagination token is returned
            assert result['statusCode'] == 200
            assert 'next_token' in result['body']
            
            # Now test continuation with next_token
            second_batch = [
                {'contact_id': f'contact-{i}', 'timestamp': datetime.utcnow().isoformat()}
                for i in range(50, 100)
            ]
            
            mock_analytics_table.scan.return_value = {
                'Items': second_batch
            }
            
            mock_event.get_query_string_value = Mock(side_effect=lambda key, default_value=None: {
                'limit': '50',
                'start_time': None,
                'end_time': None,
                'next_token': next_token
            }.get(key, default_value))
            
            # Execute continuation query
            result2 = list_contacts()
            
            # Verify continuation worked
            assert result2['statusCode'] == 200
            
            # Verify ExclusiveStartKey was used
            call_args = mock_analytics_table.scan.call_args
            assert 'ExclusiveStartKey' in call_args[1]


# Edge case tests
def test_edge_case_empty_transcriptions():
    """
    Edge case: Contact with no transcriptions should return 404.
    """
    with patch('handler.transcriptions_table') as mock_trans_table:
        mock_trans_table.query.return_value = {'Items': []}
        
        result = get_transcriptions('empty-contact')
        
        assert result['statusCode'] == 404


def test_edge_case_decimal_encoding():
    """
    Edge case: Decimal values should be properly encoded in JSON responses.
    """
    test_data = {
        'confidence': Decimal('0.95'),
        'score': Decimal('123.456')
    }
    
    # Test DecimalEncoder
    encoded = json.dumps(test_data, cls=DecimalEncoder)
    decoded = json.loads(encoded)
    
    assert isinstance(decoded['confidence'], float)
    assert isinstance(decoded['score'], float)
    assert decoded['confidence'] == 0.95


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
