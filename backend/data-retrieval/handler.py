"""
Data Retrieval Lambda Handler

Provides REST API endpoints for querying contact transcriptions and analytics.
Supports queries by contact ID, time ranges, and pagination.
"""

import json
import os
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.event_handler import APIGatewayRestResolver
from aws_lambda_powertools.logging import correlation_paths
from aws_lambda_powertools.utilities.typing import LambdaContext
import boto3
from boto3.dynamodb.conditions import Key, Attr

logger = Logger()
tracer = Tracer()
app = APIGatewayRestResolver()

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb')
transcriptions_table = dynamodb.Table(os.environ['TRANSCRIPTIONS_TABLE'])
analytics_table = dynamodb.Table(os.environ['ANALYTICS_TABLE'])


class DecimalEncoder(json.JSONEncoder):
    """Custom JSON encoder for DynamoDB Decimal types"""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)


@app.get("/contacts/<contact_id>")
@tracer.capture_method
def get_contact(contact_id: str) -> Dict[str, Any]:
    """
    Get all transcriptions and analytics for a specific contact.
    
    Args:
        contact_id: The contact ID to retrieve
        
    Returns:
        Dict containing transcriptions and analytics
    """
    logger.info(f"Retrieving contact data for: {contact_id}")
    
    # Query transcriptions using PK/SK schema
    transcriptions_response = transcriptions_table.query(
        KeyConditionExpression=Key('PK').eq(contact_id)
    )
    all_items = transcriptions_response.get('Items', [])
    
    # Filter out STATUS records - only keep transcription records (SK starts with timestamp)
    raw_transcriptions = [
        item for item in all_items
        if item.get('SK', '').startswith('2')  # Timestamps start with '2' (e.g., 2026-01-25)
    ]
    
    # Deduplicate transcriptions - keep only the latest sequence for each unique segment
    # Group by timestamp and text content, keep the one with highest sequence number
    transcription_groups = {}
    for trans in raw_transcriptions:
        # Create a unique key based on timestamp and text (the actual content)
        key = f"{trans.get('timestamp', '')}_{trans.get('text', '')}"
        seq_num = trans.get('sequenceNumber', 0)
        
        # Keep the transcription with the highest sequence number for this content
        if key not in transcription_groups or seq_num > transcription_groups[key].get('sequenceNumber', 0):
            transcription_groups[key] = trans
    
    # Convert back to list
    transcriptions = list(transcription_groups.values())
    
    # Query analytics using PK/SK schema
    analytics_response = analytics_table.query(
        KeyConditionExpression=Key('PK').eq(contact_id)
    )
    analytics_items = analytics_response.get('Items', [])
    
    if not transcriptions and not analytics_items:
        return {
            "statusCode": 404,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            "body": json.dumps({"message": f"Contact {contact_id} not found"})
        }
    
    # Build contact object similar to list_contacts format
    contact = {
        'id': contact_id,
        'status': 'COMPLETED',
        'createdAt': analytics_items[0].get('generatedAt', '') if analytics_items else '',
        'updatedAt': analytics_items[0].get('generatedAt', '') if analytics_items else '',
        'transcriptions': transcriptions,
        'metadata': {},
        'analytics': {}
    }
    
    # Process analytics items
    for item in analytics_items:
        analytics_type = item.get('analyticsType')
        
        if analytics_type == 'SENTIMENT':
            content = item.get('content')
            if isinstance(content, str):
                try:
                    sentiment_data = json.loads(content)
                except Exception as e:
                    logger.error(f"Failed to parse sentiment JSON: {e}")
                    sentiment_data = {'overall': 'NEUTRAL', 'confidence': 0.0, 'segments': []}
            else:
                sentiment_data = content or {'overall': 'NEUTRAL', 'confidence': 0.0, 'segments': []}
            
            contact['analytics']['sentiment'] = sentiment_data
            contact['analytics']['contactId'] = contact_id
            contact['analytics']['generatedAt'] = item.get('generatedAt', '')
            
        elif analytics_type == 'TOPICS':
            content = item.get('content')
            if isinstance(content, str):
                try:
                    topics_data = json.loads(content)
                except Exception as e:
                    logger.error(f"Failed to parse topics JSON: {e}")
                    topics_data = []
            else:
                topics_data = content or []
            
            contact['analytics']['topics'] = topics_data
            
        elif analytics_type == 'SUMMARY':
            contact['analytics']['summary'] = item.get('content', '')
    
    # Lambda Proxy integration requires body to be a JSON string
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        "body": json.dumps({"contact": contact}, cls=DecimalEncoder)
    }


@app.get("/contacts")
@tracer.capture_method
def list_contacts() -> Dict[str, Any]:
    """
    List contacts with optional filtering and pagination.
    
    Query parameters:
        - start_time: ISO format timestamp for range start
        - end_time: ISO format timestamp for range end
        - limit: Maximum number of contacts (default: 50, max: 100)
        - next_token: Pagination token from previous response
        
    Returns:
        Dict containing list of contacts and pagination info
    """
    # Get query parameters
    start_time = app.current_event.get_query_string_value("start_time")
    end_time = app.current_event.get_query_string_value("end_time")
    contact_limit = int(app.current_event.get_query_string_value("limit", default_value="50"))
    next_token = app.current_event.get_query_string_value("next_token")
    
    # Validate limit
    contact_limit = min(contact_limit, 100)
    
    logger.info(f"Listing contacts with filters - start: {start_time}, end: {end_time}, contact_limit: {contact_limit}")
    
    # We need to scan enough items to get the requested number of contacts
    # Since each contact has ~3 analytics items, we multiply by 5 to be safe
    scan_limit = contact_limit * 5
    
    # Build scan parameters
    scan_params = {
        'Limit': scan_limit
    }
    
    if next_token:
        try:
            scan_params['ExclusiveStartKey'] = json.loads(next_token)
        except Exception as e:
            logger.error(f"Failed to parse next_token: {e}")
    
    # Add time range filter if provided
    if start_time or end_time:
        filter_expressions = []
        if start_time:
            filter_expressions.append(Attr('timestamp').gte(start_time))
        if end_time:
            filter_expressions.append(Attr('timestamp').lte(end_time))
        
        filter_expr = filter_expressions[0]
        for expr in filter_expressions[1:]:
            filter_expr = filter_expr & expr
        scan_params['FilterExpression'] = filter_expr
    
    # Keep scanning until we have enough contacts or no more items
    contacts_dict = {}
    last_evaluated_key = None
    
    while len(contacts_dict) < contact_limit:
        # Scan analytics table
        response = analytics_table.scan(**scan_params)
        items = response.get('Items', [])
        
        logger.info(f"Scanned analytics table, found {len(items)} items, have {len(contacts_dict)} contacts so far")
        
        # Group analytics by contact ID
        for item in items:
            contact_id = item.get('PK') or item.get('contactId')
            if not contact_id:
                logger.warning(f"Item without contact_id: {item}")
                continue
                
            if contact_id not in contacts_dict:
                contacts_dict[contact_id] = {
                    'id': contact_id,
                    'status': 'COMPLETED',
                    'createdAt': item.get('generatedAt', ''),
                    'updatedAt': item.get('generatedAt', ''),
                    'transcriptions': [],
                    'metadata': {},
                    'analytics': {}
                }
            
            # Add analytics data based on type
            analytics_type = item.get('analyticsType')
            logger.debug(f"Processing analytics type: {analytics_type} for contact: {contact_id}")
            
            if analytics_type == 'SENTIMENT':
                # Parse sentiment content if it's a JSON string
                content = item.get('content')
                if isinstance(content, str):
                    try:
                        sentiment_data = json.loads(content)
                        logger.debug(f"Parsed sentiment data: {sentiment_data}")
                    except Exception as e:
                        logger.error(f"Failed to parse sentiment JSON: {e}, content: {content}")
                        sentiment_data = {
                            'overall': 'NEUTRAL',
                            'confidence': 0.0,
                            'segments': []
                        }
                else:
                    sentiment_data = content or {
                        'overall': 'NEUTRAL',
                        'confidence': 0.0,
                        'segments': []
                    }
                
                contacts_dict[contact_id]['analytics']['sentiment'] = sentiment_data
                contacts_dict[contact_id]['analytics']['contactId'] = contact_id
                contacts_dict[contact_id]['analytics']['generatedAt'] = item.get('generatedAt', '')
                
            elif analytics_type == 'TOPICS':
                content = item.get('content')
                if isinstance(content, str):
                    try:
                        topics_data = json.loads(content)
                        logger.debug(f"Parsed topics data: {topics_data}")
                    except Exception as e:
                        logger.error(f"Failed to parse topics JSON: {e}, content: {content}")
                        topics_data = []
                else:
                    topics_data = content or []
                
                contacts_dict[contact_id]['analytics']['topics'] = topics_data
                
            elif analytics_type == 'SUMMARY':
                contacts_dict[contact_id]['analytics']['summary'] = item.get('content', '')
            else:
                logger.warning(f"Unknown analytics type: {analytics_type}")
        
        # Check if there are more items to scan
        if 'LastEvaluatedKey' in response:
            last_evaluated_key = response['LastEvaluatedKey']
            scan_params['ExclusiveStartKey'] = last_evaluated_key
        else:
            # No more items in table
            break
        
        # If we have enough contacts, stop scanning
        if len(contacts_dict) >= contact_limit:
            break
    
    # Convert dict to list and limit to requested number
    all_contacts = list(contacts_dict.values())
    contacts = all_contacts[:contact_limit]
    
    logger.info(f"Returning {len(contacts)} contacts out of {len(all_contacts)} found")
    
    # Prepare response body
    body = {
        "contacts": contacts,
        "count": len(contacts)
    }
    
    # Add pagination token if we have more contacts or more items in table
    if len(all_contacts) > contact_limit or last_evaluated_key:
        body["next_token"] = json.dumps(last_evaluated_key, cls=DecimalEncoder) if last_evaluated_key else None
    
    # Lambda Proxy integration requires body to be a JSON string
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        "body": json.dumps(body, cls=DecimalEncoder)
    }


@app.get("/transcriptions/<contact_id>")
@tracer.capture_method
def get_transcriptions(contact_id: str) -> Dict[str, Any]:
    """
    Get all transcriptions for a specific contact.
    
    Args:
        contact_id: The contact ID to retrieve transcriptions for
        
    Returns:
        Dict containing transcriptions sorted by sequence number
    """
    logger.info(f"Retrieving transcriptions for contact: {contact_id}")
    
    response = transcriptions_table.query(
        KeyConditionExpression=Key('PK').eq(contact_id)
    )
    
    raw_transcriptions = response.get('Items', [])
    
    if not raw_transcriptions:
        return {
            "statusCode": 404,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            "body": json.dumps({"message": f"No transcriptions found for contact {contact_id}"})
        }
    
    # Deduplicate transcriptions - keep only the latest sequence for each unique segment
    transcription_groups = {}
    for trans in raw_transcriptions:
        # Create a unique key based on timestamp and text content
        key = f"{trans.get('timestamp', '')}_{trans.get('text', '')}"
        seq_num = trans.get('sequenceNumber', 0)
        
        # Keep the transcription with the highest sequence number for this content
        if key not in transcription_groups or seq_num > transcription_groups[key].get('sequenceNumber', 0):
            transcription_groups[key] = trans
    
    # Convert back to list and sort by sequence number
    transcriptions = list(transcription_groups.values())
    transcriptions.sort(key=lambda x: x.get('sequence_number', 0))
    
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        "body": json.dumps({
            "contact_id": contact_id,
            "transcriptions": transcriptions,
            "count": len(transcriptions)
        }, cls=DecimalEncoder)
    }


@app.get("/analytics/<contact_id>")
@tracer.capture_method
def get_analytics(contact_id: str) -> Dict[str, Any]:
    """
    Get analytics for a specific contact.
    
    Args:
        contact_id: The contact ID to retrieve analytics for
        
    Returns:
        Dict containing analytics (sentiment, topics, summary)
    """
    logger.info(f"Retrieving analytics for contact: {contact_id}")
    
    response = analytics_table.query(
        KeyConditionExpression=Key('contact_id').eq(contact_id)
    )
    
    analytics = response.get('Items', [])
    
    if not analytics:
        return {
            "statusCode": 404,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            "body": json.dumps({"message": f"No analytics found for contact {contact_id}"})
        }
    
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        "body": json.dumps(analytics[0], cls=DecimalEncoder)
    }


@app.get("/health")
def health_check() -> Dict[str, Any]:
    """Health check endpoint"""
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        "body": json.dumps({"status": "healthy"})
    }


@logger.inject_lambda_context(correlation_id_path=correlation_paths.API_GATEWAY_REST)
@tracer.capture_lambda_handler
def lambda_handler(event: Dict[str, Any], context: LambdaContext) -> Dict[str, Any]:
    """
    Lambda handler for data retrieval API.
    
    Args:
        event: API Gateway event
        context: Lambda context
        
    Returns:
        API Gateway response
    """
    return app.resolve(event, context)
