"""
Core data types for the Serverless Conversational Analytics solution
Python version of the TypeScript types for consistency across the stack
"""

from datetime import datetime
from typing import Dict, List, Optional, Any, Literal
from dataclasses import dataclass
from enum import Enum


class SpeakerType(str, Enum):
    """Speaker types in conversations"""
    AGENT = "AGENT"
    CUSTOMER = "CUSTOMER"


class ContactStatus(str, Enum):
    """Contact processing status"""
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class SentimentType(str, Enum):
    """Sentiment analysis results"""
    POSITIVE = "POSITIVE"
    NEGATIVE = "NEGATIVE"
    NEUTRAL = "NEUTRAL"
    MIXED = "MIXED"


class EventType(str, Enum):
    """AppSync event types"""
    CONTACT_UPDATED = "CONTACT_UPDATED"
    CONTACT_CREATED = "CONTACT_CREATED"
    ANALYTICS_COMPLETED = "ANALYTICS_COMPLETED"
    SUMMARY_STREAMING = "SUMMARY_STREAMING"


class AnalyticsType(str, Enum):
    """Types of analytics stored in DynamoDB"""
    SUMMARY = "SUMMARY"
    SENTIMENT = "SENTIMENT"
    TOPICS = "TOPICS"


class ErrorType(str, Enum):
    """Error types for processing failures"""
    VALIDATION_ERROR = "VALIDATION_ERROR"
    PROCESSING_ERROR = "PROCESSING_ERROR"
    STORAGE_ERROR = "STORAGE_ERROR"
    AI_SERVICE_ERROR = "AI_SERVICE_ERROR"


@dataclass
class TranscriptionMetadata:
    """Metadata for transcription records"""
    channel: Optional[str] = None
    language: Optional[str] = None
    duration: Optional[float] = None
    contact_status: Optional[ContactStatus] = None


@dataclass
class Transcription:
    """Core transcription data structure"""
    contact_id: str
    sequence_number: int
    timestamp: datetime
    speaker: SpeakerType
    text: str
    confidence: float
    is_complete: Optional[bool] = None
    total_expected: Optional[int] = None
    metadata: Optional[TranscriptionMetadata] = None


@dataclass
class SentimentSegment:
    """Individual sentiment analysis segment"""
    text: str
    sentiment: str
    confidence: float


@dataclass
class Sentiment:
    """Sentiment analysis results"""
    overall: SentimentType
    confidence: float
    segments: List[SentimentSegment]


@dataclass
class Topic:
    """Extracted topic information"""
    name: str
    confidence: float
    mentions: int


@dataclass
class ContactAnalytics:
    """Complete analytics for a contact"""
    contact_id: str
    summary: str
    sentiment: Sentiment
    topics: List[Topic]
    generated_at: datetime


@dataclass
class ContactMetadata:
    """Contact metadata"""
    total_duration: Optional[float] = None
    participant_count: Optional[int] = None
    source: Optional[str] = None


@dataclass
class Contact:
    """Complete contact information"""
    id: str
    transcriptions: List[Transcription]
    analytics: Optional[ContactAnalytics] = None
    status: ContactStatus = ContactStatus.IN_PROGRESS
    created_at: datetime = None
    updated_at: datetime = None
    metadata: Optional[ContactMetadata] = None

    def __post_init__(self):
        if self.created_at is None:
            self.created_at = datetime.utcnow()
        if self.updated_at is None:
            self.updated_at = datetime.utcnow()


@dataclass
class AppSyncEventData:
    """Data payload for AppSync events"""
    contact: Optional[Contact] = None
    analytics: Optional[ContactAnalytics] = None
    summary: Optional[str] = None
    summary_chunk: Optional[str] = None  # For streaming responses
    is_complete: Optional[bool] = None   # Indicates if streaming is complete


@dataclass
class AppSyncEvent:
    """AppSync event structure"""
    event_type: EventType
    contact_id: str
    timestamp: str  # ISO8601
    data: AppSyncEventData


@dataclass
class KinesisTranscriptionRecord:
    """Kinesis Stream record structure"""
    contact_id: str
    sequence_number: int
    timestamp: str
    speaker: SpeakerType
    text: str
    confidence: float
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class TranscriptionDynamoDBItem:
    """DynamoDB item structure for transcriptions"""
    PK: str  # contactId
    SK: str  # timestamp or sequenceNumber
    contact_id: str
    sequence_number: int
    timestamp: str
    speaker: str
    text: str
    confidence: float
    is_complete: Optional[bool] = None
    total_expected: Optional[int] = None
    metadata: Optional[Dict[str, Any]] = None
    GSI1PK: Optional[str] = None  # For additional query patterns
    GSI1SK: Optional[str] = None


@dataclass
class AnalyticsDynamoDBItem:
    """DynamoDB item structure for analytics"""
    PK: str  # contactId
    SK: str  # analyticsType (SUMMARY, SENTIMENT, TOPICS)
    contact_id: str
    analytics_type: AnalyticsType
    content: str
    confidence: Optional[float] = None
    generated_at: str = None
    metadata: Optional[Dict[str, Any]] = None

    def __post_init__(self):
        if self.generated_at is None:
            self.generated_at = datetime.utcnow().isoformat()


@dataclass
class ProcessingError:
    """Error information for failed processing"""
    error_type: ErrorType
    message: str
    context: Dict[str, Any]
    timestamp: datetime
    retryable: bool


@dataclass
class DeadLetterQueueMessage:
    """Dead Letter Queue message structure"""
    original_message: Any
    error: ProcessingError
    attempt_count: int
    first_attempt: datetime
    last_attempt: datetime


# Utility functions for type conversion
def transcription_to_dict(transcription: Transcription) -> Dict[str, Any]:
    """Convert Transcription dataclass to dictionary"""
    result = {
        'contactId': transcription.contact_id,
        'sequenceNumber': transcription.sequence_number,
        'timestamp': transcription.timestamp.isoformat(),
        'speaker': transcription.speaker.value,
        'text': transcription.text,
        'confidence': transcription.confidence
    }
    
    if transcription.is_complete is not None:
        result['isComplete'] = transcription.is_complete
    if transcription.total_expected is not None:
        result['totalExpected'] = transcription.total_expected
    if transcription.metadata:
        result['metadata'] = {
            'channel': transcription.metadata.channel,
            'language': transcription.metadata.language,
            'duration': transcription.metadata.duration,
            'contactStatus': transcription.metadata.contact_status.value if transcription.metadata.contact_status else None
        }
    
    return result


def dict_to_transcription(data: Dict[str, Any]) -> Transcription:
    """Convert dictionary to Transcription dataclass"""
    metadata = None
    if 'metadata' in data and data['metadata']:
        metadata = TranscriptionMetadata(
            channel=data['metadata'].get('channel'),
            language=data['metadata'].get('language'),
            duration=data['metadata'].get('duration'),
            contact_status=ContactStatus(data['metadata']['contactStatus']) if data['metadata'].get('contactStatus') else None
        )
    
    return Transcription(
        contact_id=data['contactId'],
        sequence_number=data['sequenceNumber'],
        timestamp=datetime.fromisoformat(data['timestamp'].replace('Z', '+00:00')),
        speaker=SpeakerType(data['speaker']),
        text=data['text'],
        confidence=data['confidence'],
        is_complete=data.get('isComplete'),
        total_expected=data.get('totalExpected'),
        metadata=metadata
    )