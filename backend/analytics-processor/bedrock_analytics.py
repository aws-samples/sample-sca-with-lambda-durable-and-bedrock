"""
Amazon Bedrock integration for conversational analytics

This module provides sentiment analysis, topic extraction, and summarization
using Amazon Bedrock with durable execution for resilient processing.
"""

import json
import time
from typing import Dict, List, Any, Optional, Iterator
from datetime import datetime
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError
from aws_lambda_powertools import Logger, Metrics
from aws_lambda_powertools.metrics import MetricUnit
from aws_durable_execution_sdk_python import StepContext, durable_step

# Initialize logger and metrics
logger = Logger()
metrics = Metrics()

# Initialize Bedrock client
bedrock_runtime = boto3.client('bedrock-runtime')

# Model configurations
CLAUDE_MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"
MAX_RETRIES = 3
RETRY_DELAY_SECONDS = 2


class BedrockAnalyticsError(Exception):
    """Base exception for Bedrock analytics errors"""
    pass


class BedrockThrottlingError(BedrockAnalyticsError):
    """Exception for throttling errors"""
    pass


class BedrockServiceError(BedrockAnalyticsError):
    """Exception for service errors"""
    pass


class BedrockAnalytics:
    """Handles all Bedrock-based analytics operations"""
    
    def __init__(self, model_id: str = CLAUDE_MODEL_ID):
        self.model_id = model_id
        self.logger = logger
        self.metrics = metrics
    
    def _prepare_conversation_text(self, transcriptions: List[Dict[str, Any]]) -> str:
        """
        Prepare conversation text from transcriptions
        
        Args:
            transcriptions: List of transcription items
            
        Returns:
            Formatted conversation text
        """
        # Sort by sequence number
        sorted_transcriptions = sorted(
            transcriptions,
            key=lambda x: x.get('sequenceNumber', 0)
        )
        
        conversation_lines = []
        for transcription in sorted_transcriptions:
            speaker = transcription.get('speaker', 'UNKNOWN')
            text = transcription.get('text', '')
            conversation_lines.append(f"{speaker}: {text}")
        
        return "\n".join(conversation_lines)
    
    def analyze_sentiment(self, transcriptions: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Perform sentiment analysis on conversation with per-transcription sentiment
        
        Args:
            transcriptions: List of transcription items
            
        Returns:
            Sentiment analysis results with per-transcription sentiment
        """
        self.logger.info("Starting sentiment analysis")
        
        # Sort transcriptions by sequence number
        sorted_transcriptions = sorted(
            transcriptions,
            key=lambda x: x.get('sequenceNumber', 0)
        )
        
        # Build conversation with line numbers for reference
        conversation_lines = []
        for idx, transcription in enumerate(sorted_transcriptions):
            speaker = transcription.get('speaker', 'UNKNOWN')
            text = transcription.get('text', '')
            conversation_lines.append(f"{idx+1}. {speaker}: {text}")
        
        conversation_text = "\n".join(conversation_lines)
        
        prompt = f"""Analyze the sentiment of the following customer service conversation. 
Provide:
1. Overall sentiment (POSITIVE, NEGATIVE, NEUTRAL, or MIXED)
2. Confidence score (0.0 to 1.0)
3. Sentiment for EACH line in the conversation (use the line number as reference)

Conversation:
{conversation_text}

Respond in JSON format:
{{
    "overall": "POSITIVE|NEGATIVE|NEUTRAL|MIXED",
    "confidence": 0.95,
    "segments": [
        {{"lineNumber": 1, "sentiment": "POSITIVE", "confidence": 0.9}},
        {{"lineNumber": 2, "sentiment": "NEUTRAL", "confidence": 0.85}}
    ]
}}

IMPORTANT: Include a sentiment entry for EVERY line in the conversation."""
        
        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2000,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.1
        }
        
        try:
            self.logger.info("Invoking Bedrock for sentiment analysis")
            
            response = bedrock_runtime.invoke_model(
                modelId=self.model_id,
                body=json.dumps(request_body)
            )
            
            response_body = json.loads(response['body'].read())
            content = response_body['content'][0]['text']
            
            # Parse JSON response
            sentiment_data = json.loads(content)
            
            # Ensure sentiment has a default value if not found
            if not sentiment_data.get('overall'):
                sentiment_data['overall'] = 'NEUTRAL'
                self.logger.warning(
                    "Sentiment overall not found in response, defaulting to NEUTRAL",
                    extra={"rawContent": content}
                )
            
            # Ensure confidence has a default value
            if sentiment_data.get('confidence') is None:
                sentiment_data['confidence'] = 0.0
            
            self.logger.info(
                "Sentiment analysis completed",
                extra={
                    "overall": sentiment_data.get('overall'),
                    "confidence": sentiment_data.get('confidence')
                }
            )
            
            self.metrics.add_metric(
                name="SentimentAnalysisCompleted",
                unit=MetricUnit.Count,
                value=1
            )
            
            return sentiment_data
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            self.logger.error(
                f"Bedrock API error: {error_code}",
                extra={"errorCode": error_code, "error": str(e)}
            )
            
            # Raise appropriate exception for retry
            if error_code in ['ThrottlingException', 'ServiceUnavailable', 'TooManyRequestsException']:
                raise BedrockThrottlingError(f"Bedrock throttled: {str(e)}")
            else:
                raise BedrockServiceError(f"Bedrock service error: {str(e)}")
                
        except json.JSONDecodeError as e:
            self.logger.error(f"Failed to parse Bedrock response: {str(e)}")
            # Return default sentiment on parse error
            self.logger.warning("Returning default NEUTRAL sentiment due to parse error")
            return {
                'overall': 'NEUTRAL',
                'confidence': 0.0,
                'segments': []
            }
        except (KeyError, IndexError) as e:
            self.logger.error(f"Unexpected Bedrock response structure: {str(e)}")
            # Return default sentiment on structure error
            self.logger.warning("Returning default NEUTRAL sentiment due to response structure error")
            return {
                'overall': 'NEUTRAL',
                'confidence': 0.0,
                'segments': []
            }
    
    def extract_topics(self, transcriptions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Extract key topics from conversation
        
        Args:
            transcriptions: List of transcription items
            
        Returns:
            List of extracted topics
        """
        self.logger.info("Starting topic extraction")
        
        conversation_text = self._prepare_conversation_text(transcriptions)
        
        prompt = f"""Extract the key topics discussed in the following customer service conversation.
For each topic, provide:
1. Topic name
2. Confidence score (0.0 to 1.0)
3. Number of mentions

Conversation:
{conversation_text}

Respond in JSON format:
{{
    "topics": [
        {{"name": "topic name", "confidence": 0.9, "mentions": 3}}
    ]
}}"""
        
        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 2000,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.1
        }
        
        try:
            self.logger.info("Invoking Bedrock for topic extraction")
            
            response = bedrock_runtime.invoke_model(
                modelId=self.model_id,
                body=json.dumps(request_body)
            )
            
            response_body = json.loads(response['body'].read())
            content = response_body['content'][0]['text']
            
            # Parse JSON response
            topics_data = json.loads(content)
            topics = topics_data.get('topics', [])
            
            self.logger.info(
                "Topic extraction completed",
                extra={"topicCount": len(topics)}
            )
            
            self.metrics.add_metric(
                name="TopicExtractionCompleted",
                unit=MetricUnit.Count,
                value=1
            )
            
            return topics
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            self.logger.error(
                f"Bedrock API error: {error_code}",
                extra={"errorCode": error_code, "error": str(e)}
            )
            
            # Raise appropriate exception for retry
            if error_code in ['ThrottlingException', 'ServiceUnavailable', 'TooManyRequestsException']:
                raise BedrockThrottlingError(f"Bedrock throttled: {str(e)}")
            else:
                raise BedrockServiceError(f"Bedrock service error: {str(e)}")
                
        except json.JSONDecodeError as e:
            self.logger.error(f"Failed to parse Bedrock response: {str(e)}")
            raise BedrockAnalyticsError(f"Invalid JSON response from Bedrock: {str(e)}")
    
    def generate_summary_streaming(
        self,
        transcriptions: List[Dict[str, Any]]
    ) -> Iterator[str]:
        """
        Generate conversation summary with streaming responses
        
        Args:
            transcriptions: List of transcription items
            
        Yields:
            Summary text chunks as they are generated
        """
        self.logger.info("Starting summary generation")
        
        conversation_text = self._prepare_conversation_text(transcriptions)
        
        prompt = f"""Provide a concise summary of the following customer service conversation.
Focus on:
1. Main issue or request
2. Key points discussed
3. Resolution or outcome

Conversation:
{conversation_text}

Summary:"""
        
        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 1000,
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.3
        }
        
        try:
            self.logger.info("Invoking Bedrock for summary generation (streaming)")
            
            response = bedrock_runtime.invoke_model_with_response_stream(
                modelId=self.model_id,
                body=json.dumps(request_body)
            )
            
            stream = response.get('body')
            
            if stream:
                for event in stream:
                    chunk = event.get('chunk')
                    if chunk:
                        chunk_data = json.loads(chunk.get('bytes').decode())
                        
                        if chunk_data['type'] == 'content_block_delta':
                            delta = chunk_data.get('delta', {})
                            if delta.get('type') == 'text_delta':
                                text = delta.get('text', '')
                                if text:
                                    yield text
                        
                        elif chunk_data['type'] == 'message_stop':
                            self.logger.info("Summary generation completed")
                            self.metrics.add_metric(
                                name="SummaryGenerationCompleted",
                                unit=MetricUnit.Count,
                                value=1
                            )
                            break
            
        except ClientError as e:
            error_code = e.response['Error']['Code']
            self.logger.error(
                f"Bedrock API error: {error_code}",
                extra={"errorCode": error_code, "error": str(e)}
            )
            
            # Raise appropriate exception for retry
            if error_code in ['ThrottlingException', 'ServiceUnavailable', 'TooManyRequestsException']:
                raise BedrockThrottlingError(f"Bedrock throttled: {str(e)}")
            else:
                raise BedrockServiceError(f"Bedrock service error: {str(e)}")
                
        except Exception as e:
            self.logger.error(f"Error in streaming summary generation: {str(e)}", exc_info=True)
            raise BedrockAnalyticsError(f"Streaming error: {str(e)}")
    
    def generate_summary(self, transcriptions: List[Dict[str, Any]]) -> str:
        """
        Generate conversation summary (non-streaming version)
        
        Args:
            transcriptions: List of transcription items
            
        Returns:
            Complete summary text
        """
        summary_chunks = []
        
        for chunk in self.generate_summary_streaming(transcriptions):
            summary_chunks.append(chunk)
        
        return ''.join(summary_chunks)
    
    def generate_complete_analytics(
        self,
        contact_id: str,
        transcriptions: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Generate all analytics for a contact
        
        Args:
            contact_id: Contact ID
            transcriptions: List of transcription items
            
        Returns:
            Complete analytics results
        """
        self.logger.info(
            "Starting complete analytics generation",
            extra={
                "contactId": contact_id,
                "transcriptionCount": len(transcriptions)
            }
        )
        
        start_time = time.time()
        
        try:
            # Generate sentiment analysis
            sentiment = self.analyze_sentiment(transcriptions)
            
            # Extract topics
            topics = self.extract_topics(transcriptions)
            
            # Generate summary (non-streaming for complete analytics)
            summary = self.generate_summary(transcriptions)
            
            analytics = {
                'contactId': contact_id,
                'sentiment': sentiment,
                'topics': topics,
                'summary': summary,
                'generatedAt': datetime.utcnow().isoformat(),
                'processingTimeSeconds': time.time() - start_time
            }
            
            self.logger.info(
                "Complete analytics generation finished",
                extra={
                    "contactId": contact_id,
                    "processingTime": analytics['processingTimeSeconds']
                }
            )
            
            self.metrics.add_metric(
                name="CompleteAnalyticsGenerated",
                unit=MetricUnit.Count,
                value=1
            )
            
            return analytics
            
        except BedrockAnalyticsError as e:
            self.logger.error(
                f"Analytics generation failed: {str(e)}",
                extra={
                    "contactId": contact_id,
                    "error": str(e)
                }
            )
            self.metrics.add_metric(
                name="AnalyticsGenerationFailed",
                unit=MetricUnit.Count,
                value=1
            )
            raise


def convert_floats_to_decimal(obj: Any) -> Any:
    """
    Recursively convert float values to Decimal for DynamoDB compatibility
    
    Args:
        obj: Object to convert
        
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


# Utility functions
def create_bedrock_analytics(model_id: str = CLAUDE_MODEL_ID) -> BedrockAnalytics:
    """Create a BedrockAnalytics instance"""
    return BedrockAnalytics(model_id)
