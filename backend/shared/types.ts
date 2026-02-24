/**
 * Core data types for the Serverless Conversational Analytics solution
 */

export interface Transcription {
  contactId: string;
  sequenceNumber: number;
  timestamp: Date;
  speaker: 'AGENT' | 'CUSTOMER';
  text: string;
  confidence: number;
  isComplete?: boolean; // Indicates if this is the final transcription for the contact
  totalExpected?: number; // Total number of transcription segments expected
  metadata: {
    channel?: string;
    language?: string;
    duration?: number;
    contactStatus?: 'IN_PROGRESS' | 'COMPLETED';
  };
}

export interface ContactAnalytics {
  contactId: string;
  summary: string;
  sentiment: {
    overall: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED';
    confidence: number;
    segments: Array<{
      text: string;
      sentiment: string;
      confidence: number;
    }>;
  };
  topics: Array<{
    name: string;
    confidence: number;
    mentions: number;
  }>;
  generatedAt: Date;
}

export interface Contact {
  id: string;
  transcriptions: Transcription[];
  analytics?: ContactAnalytics;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  createdAt: Date;
  updatedAt: Date;
  metadata: {
    totalDuration?: number;
    participantCount?: number;
    source?: string;
  };
}

// AppSync Events schema
export interface AppSyncEvent {
  eventType: 'CONTACT_UPDATED' | 'CONTACT_CREATED' | 'ANALYTICS_COMPLETED' | 'SUMMARY_STREAMING';
  contactId: string;
  timestamp: string; // ISO8601
  data: {
    contact?: Contact;
    analytics?: ContactAnalytics;
    summary?: string;
    summaryChunk?: string; // For streaming responses
    isComplete?: boolean;   // Indicates if streaming is complete
  };
}

// Kinesis Stream record structure
export interface KinesisTranscriptionRecord {
  contactId: string;
  sequenceNumber: number;
  timestamp: string;
  speaker: 'AGENT' | 'CUSTOMER';
  text: string;
  confidence: number;
  metadata?: {
    channel?: string;
    language?: string;
    duration?: number;
    contactStatus?: 'IN_PROGRESS' | 'COMPLETED';
    isComplete?: boolean;
    totalExpected?: number;
  };
}

// DynamoDB item structures
export interface TranscriptionDynamoDBItem {
  PK: string; // contactId
  SK: string; // timestamp or sequenceNumber
  contactId: string;
  sequenceNumber: number;
  timestamp: string;
  speaker: string;
  text: string;
  confidence: number;
  isComplete?: boolean;
  totalExpected?: number;
  metadata?: Record<string, any>;
  GSI1PK?: string; // For additional query patterns
  GSI1SK?: string;
}

export interface AnalyticsDynamoDBItem {
  PK: string; // contactId
  SK: string; // analyticsType (SUMMARY, SENTIMENT, TOPICS)
  contactId: string;
  analyticsType: 'SUMMARY' | 'SENTIMENT' | 'TOPICS';
  content: string;
  confidence?: number;
  generatedAt: string;
  metadata?: Record<string, any>;
}

// Error handling types
export interface ProcessingError {
  errorType: 'VALIDATION_ERROR' | 'PROCESSING_ERROR' | 'STORAGE_ERROR' | 'AI_SERVICE_ERROR';
  message: string;
  context: Record<string, any>;
  timestamp: Date;
  retryable: boolean;
}

export interface DeadLetterQueueMessage {
  originalMessage: any;
  error: ProcessingError;
  attemptCount: number;
  firstAttempt: Date;
  lastAttempt: Date;
}