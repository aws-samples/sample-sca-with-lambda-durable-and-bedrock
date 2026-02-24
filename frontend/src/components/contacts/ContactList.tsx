import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Contact } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useRealTime } from '../../contexts/RealTimeContext';
import './ContactList.css';

export const ContactList: React.FC = () => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  
  const { user } = useAuth();
  const { subscribeToAll, isConnected } = useRealTime();
  const navigate = useNavigate();

  useEffect(() => {
    fetchContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    filterContacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts, searchTerm, statusFilter]);

  // Subscribe to real-time updates
  useEffect(() => {
    const unsubscribe = subscribeToAll((event) => {
      console.log('Received real-time event:', event);
      
      // Handle different event types
      switch (event.eventType) {
        case 'CONTACT_CREATED':
          if (event.data.contact) {
            setContacts(prev => {
              // Check if contact already exists
              const exists = prev.some(c => c.id === event.data.contact!.id);
              if (exists) {
                return prev;
              }
              return [event.data.contact!, ...prev];
            });
          }
          break;
          
        case 'CONTACT_UPDATED':
        case 'ANALYTICS_COMPLETED':
          if (event.data.contact) {
            setContacts(prev => prev.map(c => 
              c.id === event.contactId ? event.data.contact! : c
            ));
          } else if (event.data.analytics) {
            // Update just the analytics for the contact
            setContacts(prev => prev.map(c => 
              c.id === event.contactId ? { ...c, analytics: event.data.analytics } : c
            ));
          }
          break;
          
        case 'SUMMARY_STREAMING':
          // Handle streaming summary updates
          if (event.data.summaryChunk) {
            setContacts(prev => prev.map(c => {
              if (c.id === event.contactId && c.analytics) {
                return {
                  ...c,
                  analytics: {
                    ...c.analytics,
                    summary: event.data.isComplete 
                      ? event.data.summary || c.analytics.summary
                      : (c.analytics.summary || '') + event.data.summaryChunk
                  }
                };
              }
              return c;
            }));
          }
          break;
      }
    });

    return () => unsubscribe();
  }, [subscribeToAll]);

  const fetchContacts = async (loadMore: boolean = false) => {
    if (loadMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
      setContacts([]);
      setNextToken(null);
      setHasMore(true);
    }
    setError(null);

    try {
      console.log('[ContactList] Fetching contacts from /api/contacts');
      console.log('[ContactList] User token:', user?.token ? 'Present' : 'Missing');
      console.log('[ContactList] Load more:', loadMore, 'Next token:', nextToken);
      
      // Build URL with pagination parameters
      let url = '/api/contacts?limit=3';
      if (loadMore && nextToken) {
        url += `&next_token=${encodeURIComponent(nextToken)}`;
      }
      
      // Use /api proxy path - nginx will forward to private API Gateway
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${user?.token}`,
          'Content-Type': 'application/json',
        },
      });

      console.log('[ContactList] Response status:', response.status);
      console.log('[ContactList] Response headers:', Object.fromEntries(response.headers.entries()));

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ContactList] Error response:', errorText);
        throw new Error(`Failed to fetch contacts: ${response.statusText}`);
      }

      const data = await response.json();
      console.log('[ContactList] Received data:', data);
      console.log('[ContactList] Data type:', typeof data);
      console.log('[ContactList] Has body:', 'body' in data);
      console.log('[ContactList] Body type:', typeof data.body);
      
      // API Gateway returns the Lambda response wrapped in an object
      // We need to parse the body field which contains the actual JSON string
      let parsedData: any;
      if (data.body && typeof data.body === 'string') {
        console.log('[ContactList] Parsing body field as JSON string');
        parsedData = JSON.parse(data.body);
        console.log('[ContactList] Parsed data from body:', parsedData);
      } else if (data.contacts) {
        console.log('[ContactList] Using data.contacts directly');
        parsedData = data;
      } else {
        console.error('[ContactList] Invalid response structure:', data);
        throw new Error('Invalid response format: no contacts data found');
      }
      
      console.log('[ContactList] Final parsed data:', parsedData);
      console.log('[ContactList] Contacts array:', parsedData?.contacts);
      console.log('[ContactList] Is array:', Array.isArray(parsedData?.contacts));
      console.log('[ContactList] Next token:', parsedData?.next_token);
      
      if (!parsedData || !parsedData.contacts || !Array.isArray(parsedData.contacts)) {
        console.error('[ContactList] Invalid contacts data structure:', parsedData);
        throw new Error('Invalid response format: contacts is not an array');
      }
      
      // Update contacts list
      if (loadMore) {
        setContacts(prev => [...prev, ...parsedData.contacts]);
      } else {
        setContacts(parsedData.contacts);
      }
      
      // Update pagination state
      setNextToken(parsedData.next_token || null);
      setHasMore(!!parsedData.next_token);
      
    } catch (err) {
      console.error('[ContactList] Fetch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load contacts');
      if (!loadMore) {
        setContacts([]);
      }
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  };

  const filterContacts = () => {
    let filtered = [...contacts];

    // Apply search filter
    if (searchTerm) {
      filtered = filtered.filter(contact =>
        contact.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        contact.analytics?.summary?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    // Apply status filter
    if (statusFilter !== 'ALL') {
      filtered = filtered.filter(contact => contact.status === statusFilter);
    }

    // Sort by date - most recent first
    filtered.sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return dateB - dateA; // Descending order (newest first)
    });

    setFilteredContacts(filtered);
  };

  const handleContactClick = (contactId: string) => {
    navigate(`/contacts/${contactId}`);
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

  if (isLoading) {
    return (
      <div className="container">
        <div className="contact-list-header">
          <h2>Contact Interactions</h2>
        </div>
        <div className="contacts-grid">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="contact-card skeleton">
              <div className="skeleton-header">
                <div className="skeleton-line skeleton-title"></div>
                <div className="skeleton-badge"></div>
              </div>
              <div className="skeleton-body">
                <div className="skeleton-line skeleton-short"></div>
                <div className="skeleton-line skeleton-medium"></div>
                <div className="skeleton-line skeleton-long"></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container">
        <div className="error">
          <strong>Error:</strong> {error}
          <button onClick={() => fetchContacts(false)} className="button" style={{ marginTop: '16px' }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="contact-list-header">
        <h2>Contact Interactions</h2>
        <div className="header-actions">
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            <span className="status-dot"></span>
            {isConnected ? 'Live' : 'Offline'}
          </div>
          <button onClick={() => fetchContacts(false)} className="button refresh-button">
            Refresh
          </button>
        </div>
      </div>

      <div className="filters">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search contacts..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="status-filter">
          <label htmlFor="status-filter">Status:</label>
          <select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="filter-select"
          >
            <option value="ALL">All</option>
            <option value="IN_PROGRESS">In Progress</option>
            <option value="COMPLETED">Completed</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>
      </div>

      {filteredContacts.length === 0 ? (
        <div className="no-contacts">
          <p>No contacts found</p>
          {searchTerm || statusFilter !== 'ALL' ? (
            <button
              onClick={() => {
                setSearchTerm('');
                setStatusFilter('ALL');
              }}
              className="button"
            >
              Clear Filters
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="contacts-grid">
            {filteredContacts.map((contact) => (
              <div
                key={contact.id}
                className="contact-card"
                onClick={() => handleContactClick(contact.id)}
              >
                <div className="contact-card-header">
                  <h3 className="contact-id">{contact.id}</h3>
                  <span className={`status-badge status-${contact.status.toLowerCase()}`}>
                    {contact.status}
                  </span>
                </div>

                <div className="contact-card-body">
                  {contact.analytics && (
                    <>
                      <div className="sentiment-indicator">
                        <span className="label">Sentiment:</span>
                        <span
                          className="sentiment-value"
                          style={{ color: getSentimentColor(contact.analytics.sentiment.overall) }}
                        >
                          {contact.analytics.sentiment.overall}
                        </span>
                      </div>

                      {contact.analytics.summary && (
                        <p className="summary-preview">
                          {contact.analytics.summary.substring(0, 150)}
                          {contact.analytics.summary.length > 150 ? '...' : ''}
                        </p>
                      )}

                      {contact.analytics.topics && contact.analytics.topics.length > 0 && (
                        <div className="topics-preview">
                          {contact.analytics.topics.slice(0, 3).map((topic, idx) => (
                            <span key={idx} className="topic-tag">
                              {topic.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  <div className="contact-meta">
                    <span className="meta-item">
                      Created: {formatDate(contact.createdAt)}
                    </span>
                    {contact.transcriptions && (
                      <span className="meta-item">
                        Transcriptions: {contact.transcriptions.length}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {hasMore && !searchTerm && statusFilter === 'ALL' && (
            <div className="pagination-controls">
              <button
                onClick={() => fetchContacts(true)}
                className="button load-more-button"
                disabled={isLoadingMore}
              >
                {isLoadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
