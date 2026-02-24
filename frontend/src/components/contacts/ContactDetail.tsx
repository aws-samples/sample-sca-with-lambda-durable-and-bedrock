import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Contact } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useRealTime } from '../../contexts/RealTimeContext';
import './ContactDetail.css';

export const ContactDetail: React.FC = () => {
  const { contactId } = useParams<{ contactId: string }>();
  const [contact, setContact] = useState<Contact | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const { user } = useAuth();
  const { subscribe, isConnected } = useRealTime();
  const navigate = useNavigate();

  useEffect(() => {
    if (contactId) {
      fetchContactDetail(contactId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  // Subscribe to real-time updates for this specific contact
  useEffect(() => {
    if (!contactId) return;

    const unsubscribe = subscribe(contactId, (event) => {
      console.log('Received real-time event for contact:', event);
      
      // Handle different event types
      switch (event.eventType) {
        case 'CONTACT_UPDATED':
        case 'ANALYTICS_COMPLETED':
          if (event.data.contact) {
            setContact(event.data.contact);
          } else if (event.data.analytics) {
            setContact(prev => prev ? { ...prev, analytics: event.data.analytics } : null);
          }
          break;
          
        case 'SUMMARY_STREAMING':
          // Handle streaming summary updates
          if (event.data.summaryChunk) {
            setContact(prev => {
              if (prev && prev.analytics) {
                return {
                  ...prev,
                  analytics: {
                    ...prev.analytics,
                    summary: event.data.isComplete 
                      ? event.data.summary || prev.analytics.summary
                      : (prev.analytics.summary || '') + event.data.summaryChunk
                  }
                };
              }
              return prev;
            });
          }
          break;
      }
    });

    return () => unsubscribe();
  }, [contactId, subscribe]);

  const fetchContactDetail = async (id: string) => {
    setIsLoading(true);
    setError(null);

    try {
      // Use /api proxy path - nginx will forward to private API Gateway
      const response = await fetch(`/api/contacts/${id}`, {
        headers: {
          'Authorization': `Bearer ${user?.token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch contact: ${response.statusText}`);
      }

      const data = await response.json();
      console.log('[ContactDetail] Received data:', data);
      
      // API Gateway returns the Lambda response wrapped in an object
      // We need to parse the body field which contains the actual JSON string
      let parsedData;
      if (data.body && typeof data.body === 'string') {
        console.log('[ContactDetail] Parsing body field as JSON string');
        parsedData = JSON.parse(data.body);
      } else if (data.contact) {
        console.log('[ContactDetail] Using data.contact directly');
        parsedData = data;
      } else {
        console.error('[ContactDetail] Invalid response structure:', data);
        throw new Error('Invalid response format: no contact data found');
      }
      
      console.log('[ContactDetail] Parsed data:', parsedData);
      
      if (!parsedData.contact) {
        console.error('[ContactDetail] Invalid contact data structure:', parsedData);
        throw new Error('Invalid response format: contact data missing');
      }
      
      setContact(parsedData.contact);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load contact details');
      setContact(null);
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getSentimentColor = (sentiment?: string) => {
    switch (sentiment) {
      case 'POSITIVE':
        return '#4caf50';
      case 'NEGATIVE':
        return '#f44336';
      case 'NEUTRAL':
        return '#9e9e9e';
      case 'MIXED':
        return '#ff9800';
      default:
        return '#9e9e9e';
    }
  };

  const getSentimentForTranscription = (transcription: any) => {
    if (!contact?.analytics?.sentiment?.segments || !contact?.transcriptions) return null;
    
    // Create a sorted list of transcriptions by sequence number (same order Bedrock analyzed them)
    const sortedBySequence = [...contact.transcriptions]
      .filter(t => {
        // Apply same filtering as display
        if (!t.text || !t.timestamp) return false;
        const date = new Date(t.timestamp);
        if (isNaN(date.getTime())) return false;
        if (t.confidence === 0) return false;
        return true;
      })
      .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
    
    // Find the index of this transcription in the sequence-sorted list
    const lineNumber = sortedBySequence.findIndex(t => 
      t.sequenceNumber === transcription.sequenceNumber &&
      t.timestamp === transcription.timestamp &&
      t.text === transcription.text
    ) + 1; // Line numbers are 1-based
    
    if (lineNumber === 0) return null;
    
    // Find the sentiment segment with this line number
    const segment = contact.analytics.sentiment.segments.find(
      s => s.lineNumber === lineNumber
    );
    
    return segment;
  };



  if (isLoading) {
    return (
      <div className="container">
        <div className="loading">Loading contact details...</div>
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="container">
        <div className="error">
          <strong>Error:</strong> {error || 'Contact not found'}
          <button onClick={() => navigate('/contacts')} className="button" style={{ marginTop: '16px' }}>
            Back to Contacts
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="detail-header">
        <button onClick={() => navigate('/contacts')} className="button back-button">
          ← Back to Contacts
        </button>
        <h2>Contact Details</h2>
        <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
          <span className="status-dot"></span>
          {isConnected ? 'Live' : 'Offline'}
        </div>
      </div>

      <div className="detail-content">
        {/* Contact Overview */}
        <div className="detail-section">
          <h3>Overview</h3>
          <div className="info-grid">
            <div className="info-item">
              <span className="info-label">Contact ID:</span>
              <span className="info-value">{contact.id}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Status:</span>
              <span className={`status-badge status-${contact.status.toLowerCase()}`}>
                {contact.status}
              </span>
            </div>
            <div className="info-item">
              <span className="info-label">Created:</span>
              <span className="info-value">{formatDate(contact.createdAt)}</span>
            </div>
            <div className="info-item">
              <span className="info-label">Updated:</span>
              <span className="info-value">{formatDate(contact.updatedAt)}</span>
            </div>
            {contact.metadata.totalDuration && (
              <div className="info-item">
                <span className="info-label">Duration:</span>
                <span className="info-value">{contact.metadata.totalDuration}s</span>
              </div>
            )}
            {contact.metadata.participantCount && (
              <div className="info-item">
                <span className="info-label">Participants:</span>
                <span className="info-value">{contact.metadata.participantCount}</span>
              </div>
            )}
          </div>
        </div>

        {/* Analytics Section */}
        {contact.analytics && (
          <>
            {/* Summary */}
            <div className="detail-section">
              <h3>Summary</h3>
              <div className="summary-box">
                {contact.analytics.summary}
              </div>
            </div>

            {/* Sentiment Analysis */}
            <div className="detail-section">
              <h3>Sentiment Analysis</h3>
              <div className="sentiment-box">
                <div className="sentiment-overall">
                  <span className="sentiment-label">Overall Sentiment:</span>
                  <span
                    className="sentiment-value-large"
                    style={{ color: getSentimentColor(contact.analytics.sentiment.overall) }}
                  >
                    {contact.analytics.sentiment.overall}
                  </span>
                  <span className="confidence">
                    ({(contact.analytics.sentiment.confidence * 100).toFixed(1)}% confidence)
                  </span>
                </div>
              </div>
            </div>

            {/* Topics */}
            {contact.analytics.topics && contact.analytics.topics.length > 0 && (
              <div className="detail-section">
                <h3>Key Topics</h3>
                <div className="topics-grid">
                  {contact.analytics.topics.map((topic, idx) => (
                    <div key={idx} className="topic-card">
                      <div className="topic-name">{topic.name}</div>
                      <div className="topic-stats">
                        <span>Confidence: {(topic.confidence * 100).toFixed(1)}%</span>
                        <span>Mentions: {topic.mentions}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Transcriptions */}
        {contact.transcriptions && contact.transcriptions.length > 0 && (
          <div className="detail-section">
            <h3>Transcriptions ({contact.transcriptions.filter(t => {
              // Filter out invalid entries
              if (!t.text || !t.timestamp) return false;
              
              // Check if timestamp is valid
              const date = new Date(t.timestamp);
              if (isNaN(date.getTime())) return false;
              
              // Check if confidence is 0 (likely invalid data)
              if (t.confidence === 0) return false;
              
              return true;
            }).length})</h3>
            <div className="transcriptions-list">
              {contact.transcriptions
                .filter(t => {
                  // Filter out invalid entries
                  if (!t.text || !t.timestamp) return false;
                  
                  // Check if timestamp is valid
                  const date = new Date(t.timestamp);
                  if (isNaN(date.getTime())) return false;
                  
                  // Check if confidence is 0 (likely invalid data)
                  if (t.confidence === 0) return false;
                  
                  return true;
                })
                .sort((a, b) => {
                  // Sort by timestamp (oldest to newest)
                  const timeA = new Date(a.timestamp).getTime();
                  const timeB = new Date(b.timestamp).getTime();
                  return timeA - timeB;
                })
                .map((transcription, idx) => {
                  const sentiment = getSentimentForTranscription(transcription);
                  
                  return (
                    <div key={idx} className="transcription-item">
                      <div className="transcription-header">
                        <span className={`speaker speaker-${(transcription.speaker || 'unknown').toLowerCase()}`}>
                          {transcription.speaker || 'Unknown'}
                        </span>
                        <span className="timestamp">{formatDate(transcription.timestamp)}</span>
                        <span className="confidence">
                          Confidence: {((transcription.confidence || 0) * 100).toFixed(1)}%
                        </span>
                        {sentiment && (
                          <span 
                            className="transcription-sentiment"
                            style={{ 
                              color: getSentimentColor(sentiment.sentiment),
                              fontWeight: 'bold',
                              marginLeft: '8px'
                            }}
                          >
                            {sentiment.sentiment}
                          </span>
                        )}
                        {!sentiment && (
                          <span 
                            className="transcription-sentiment"
                            style={{ 
                              color: getSentimentColor('NEUTRAL'),
                              fontWeight: 'bold',
                              marginLeft: '8px'
                            }}
                          >
                            NEUTRAL
                          </span>
                        )}
                      </div>
                      <div className="transcription-text">{transcription.text || ''}</div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
