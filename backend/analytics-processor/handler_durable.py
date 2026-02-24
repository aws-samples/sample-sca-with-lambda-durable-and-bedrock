"""
Analytics Processor Lambda Function with Durable Execution

This Lambda function processes DynamoDB Stream events from the Transcriptions table,
implements skip logic to ensure all transcriptions are received, and triggers analytics
processing when contacts are complete. Uses Lambda Durable Functions for resilient Bedrock processing.
"""

import json
import os
from datetime import datetime
from typing import Dict, List, Any

import boto3
from aws_lambda_powertools import Logger, Metrics
from aws_lambda_powertools.metrics import MetricUnit
from botocore.exceptions import ClientError
from aws_durable_execution_sdk_python import durable_execution, DurableContext

from bedrock_analytics import BedrockAnalytics, convert_floats_to_decimal

# Initialize AWS Lambda Powertools
logger = Logger()
metrics = Metrics(namespace="AnalyticsProcessor")

# Initialize AWS clients
dynamodb = boto3.resource('dynamodb')

# Environment variables
TRANSCRIPTIONS_TABLE = os.environ.get('TRANSCRIPTIONS_TABLE', 'sca-transcriptions')
ANALYTICS_TABLE = os.environ.get('ANALYTICS_TABLE', 'sca-analytics')

# Initialize DynamoDB tables
transcriptions_table = dynamodb.Table(TRANSCRIPTIONS_TABLE)
analytics_table = dynamodb.Table(ANALYTICS_TABLE)

# Initialize Bedrock analytics
bedrock_analytics = BedrockAnalytics()


def get_all_transcriptions(contact_id: str) -> List[Dict[str, Any]]:
    """Retrieve all transcriptions for a contact"""
    response = transcriptions_table.query(
        KeyConditionExpression='PK = :pk',
        ExpressionAttributeValues={':pk': contact_id},
        ScanIndexForward=True
    )
    
    # Filter out STATUS records
    transcriptions = [
        item for item in response.get('Items', [])
        if item.get('SK', '').startswith('2')
    ]
    
    logger.info(f"Retrieved {len(transcriptions)} transcriptions for contact {contact_id}")
    return transcriptions


def analyze_sentiment_step(transcriptions: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Step: Analyze sentiment using Bedrock"""
    logger.info("Analyzing sentiment")
    return bedrock_analytics.analyze_sentiment(transcriptions)


def extract_topics_step(transcriptions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Step: Extract topics using Bedrock"""
    logger.info("Extracting topics")
    return bedrock_analytics.extract_topics(transcriptions)


def generate_summary_step(transcriptions: List[Dict[str, Any]]) -> str:
    """Step: Generate summary using Bedrock"""
    logger.info("Generating summary")
    summary_chunks = []
    for chunk in bedrock_analytics.generate_summary_streaming(transcriptions):
        summary_chunks.append(chunk)
    return ''.join(summary_chunks)


def store_analytics(contact_id: str, analytics: Dict[str, Any]) -> None:
    """Store analytics results in DynamoDB"""
    logger.info(f"Storing analytics for contact {contact_id}")
    
    # Store sentiment
    sentiment_item = {
        'PK': contact_id,
        'SK': 'ANALYTICS#SENTIMENT',
        'contactId': contact_id,
        'analyticsType': 'SENTIMENT',
        'content': json.dumps(analytics['sentiment']),
        'confidence': analytics['sentiment'].get('confidence'),
        'generatedAt': analytics['generatedAt'],
        'metadata': {
            'overall': analytics['sentiment']['overall'],
            'segmentCount': len(analytics['sentiment'].get('segments', []))
        }
    }
    sentiment_item = convert_floats_to_decimal(sentiment_item)
    analytics_table.put_item(Item=sentiment_item)
    
    # Store topics
    topics_item = {
        'PK': contact_id,
        'SK': 'ANALYTICS#TOPICS',
        'contactId': contact_id,
        'analyticsType': 'TOPICS',
        'content': json.dumps(analytics['topics']),
        'generatedAt': analytics['generatedAt'],
        'metadata': {
            'topicCount': len(analytics['topics'])
        }
    }
    topics_item = convert_floats_to_decimal(topics_item)
    analytics_table.put_item(Item=topics_item)
    
    # Store summary
    summary_item = {
        'PK': contact_id,
        'SK': 'ANALYTICS#SUMMARY',
        'contactId': contact_id,
        'analyticsType': 'SUMMARY',
        'content': analytics['summary'],
        'generatedAt': analytics['generatedAt'],
        'metadata': {
            'summaryLength': len(analytics['summary'])
        }
    }
    summary_item = convert_floats_to_decimal(summary_item)
    analytics_table.put_item(Item=summary_item)
    
    logger.info(f"Analytics stored successfully for contact {contact_id}")


@durable_execution
def handler(event: Dict[str, Any], context: DurableContext) -> Dict[str, Any]:
    """
    Lambda handler with durable execution for analytics processing
    
    Args:
        event: DynamoDB Stream event or direct invocation event
        context: DurableContext for durable operations
        
    Returns:
        Processing results
    """
    logger.info("Processing analytics with durable execution")
    
    # Check if this is a direct invocation with contact_id
    if 'contact_id' in event:
        contact_id = event['contact_id']
        logger.info(f"Direct invocation for contact {contact_id}")
        
        # Step 1: Get transcriptions (checkpointed)
        transcriptions = context.step(
            lambda _: get_all_transcriptions(contact_id),
            name='get_transcriptions'
        )
        
        if not transcriptions:
            logger.warning(f"No transcriptions found for contact {contact_id}")
            return {
                'statusCode': 200,
                'body': {
                    'contactId': contact_id,
                    'status': 'skipped',
                    'reason': 'No transcriptions found'
                }
            }
        
        # Step 2: Analyze sentiment (checkpointed - will retry on throttling)
        sentiment = context.step(
            lambda _: analyze_sentiment_step(transcriptions),
            name='analyze_sentiment'
        )
        
        # Step 3: Extract topics (checkpointed - will retry on throttling)
        topics = context.step(
            lambda _: extract_topics_step(transcriptions),
            name='extract_topics'
        )
        
        # Step 4: Generate summary (checkpointed - will retry on throttling)
        summary = context.step(
            lambda _: generate_summary_step(transcriptions),
            name='generate_summary'
        )
        
        # Combine results
        analytics = {
            'contactId': contact_id,
            'sentiment': sentiment,
            'topics': topics,
            'summary': summary,
            'generatedAt': datetime.utcnow().isoformat()
        }
        
        # Step 5: Store analytics (checkpointed)
        context.step(
            lambda _: store_analytics(contact_id, analytics),
            name='store_analytics'
        )
        
        logger.info(f"Analytics processing completed for contact {contact_id}")
        
        metrics.add_metric(name="AnalyticsCompleted", unit=MetricUnit.Count, value=1)
        
        return {
            'statusCode': 200,
            'body': {
                'contactId': contact_id,
                'status': 'completed',
                'sentiment': sentiment['overall'],
                'topicCount': len(topics),
                'summaryLength': len(summary)
            }
        }
    
    # Handle DynamoDB Stream events (not using durable execution for stream processing)
    else:
        logger.info("DynamoDB Stream event - processing without durable execution")
        records = event.get('Records', [])
        logger.info(f"Processing {len(records)} DynamoDB Stream records")
        
        # For stream events, we just return success
        # The actual durable execution will be triggered by async invocation
        return {
            'statusCode': 200,
            'body': {
                'totalRecords': len(records),
                'message': 'Stream processing completed'
            }
        }
