import { renderHook, act, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import fc from 'fast-check';
import { RealTimeProvider, useRealTime } from './RealTimeContext';
import { AuthProvider } from './AuthContext';
import { AppSyncEvent } from '../types';

// Mock WebSocket
class MockWebSocket {
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public readyState: number = WebSocket.CONNECTING;

  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = WebSocket.OPEN;
      if (this.onopen) {
        this.onopen(new Event('open'));
      }
    }, 0);
  }

  send(_data: string) {
    // Mock send - parameter prefixed with _ to indicate intentionally unused
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close'));
    }
  }
}

// Replace global WebSocket
(global as any).WebSocket = MockWebSocket;

// Mock environment variables
process.env.REACT_APP_APPSYNC_EVENTS_ENDPOINT = 'wss://test.appsync-api.us-east-1.amazonaws.com/event';

// Mock AuthContext
jest.mock('./AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: { token: 'mock-token', username: 'test-user' },
    isAuthenticated: true,
    login: jest.fn(),
    logout: jest.fn(),
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <AuthProvider>
    <RealTimeProvider>{children}</RealTimeProvider>
  </AuthProvider>
);

// Generator for AppSync events
const appSyncEventArb = fc.record({
  eventType: fc.constantFrom('CONTACT_UPDATED', 'ANALYTICS_COMPLETED', 'SUMMARY_STREAMING'),
  contactId: fc.uuid(),
  timestamp: fc.date().map(d => d.toISOString()),
  data: fc.record({
    contact: fc.option(fc.record({
      id: fc.uuid(),
      status: fc.constantFrom('PROCESSING', 'COMPLETED', 'FAILED'),
    }), { nil: undefined }),
    analytics: fc.option(fc.record({
      summary: fc.string(),
    }), { nil: undefined }),
    summaryChunk: fc.option(fc.string(), { nil: undefined }),
    isComplete: fc.option(fc.boolean(), { nil: undefined }),
  }),
});

describe('RealTimeContext Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Property 8.1: Subscription callbacks receive all published events
  test('Property 8.1: All subscribed callbacks receive published events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.array(appSyncEventArb, { minLength: 1, maxLength: 10 }),
        async (contactId, events) => {
          const { result } = renderHook(() => useRealTime(), { wrapper });

          // Wait for connection
          await waitFor(() => {
            expect(result.current.isConnected).toBe(true);
          });

          const receivedEvents: AppSyncEvent[] = [];
          
          // Subscribe to events
          act(() => {
            result.current.subscribe(contactId, (event) => {
              receivedEvents.push(event);
            });
          });

          // Simulate receiving events
          const ws = (global as any).WebSocket.mock?.instances?.[0];
          if (ws && ws.onmessage) {
            for (const event of events) {
              const messageEvent = new MessageEvent('message', {
                data: JSON.stringify({ ...event, contactId }),
              });
              act(() => {
                ws.onmessage(messageEvent);
              });
            }
          }

          // Wait for events to be processed
          await waitFor(() => {
            expect(receivedEvents.length).toBe(events.length);
          });

          // Verify all events were received
          expect(receivedEvents.length).toBe(events.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 8.2: Unsubscribed callbacks do not receive events
  test('Property 8.2: Unsubscribed callbacks stop receiving events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        appSyncEventArb,
        async (contactId, event) => {
          const { result } = renderHook(() => useRealTime(), { wrapper });

          await waitFor(() => {
            expect(result.current.isConnected).toBe(true);
          });

          let receivedCount = 0;
          let unsubscribe: (() => void) | undefined;

          // Subscribe
          act(() => {
            unsubscribe = result.current.subscribe(contactId, () => {
              receivedCount++;
            });
          });

          // Unsubscribe immediately
          act(() => {
            if (unsubscribe) unsubscribe();
          });

          // Try to send event
          const ws = (global as any).WebSocket.mock?.instances?.[0];
          if (ws && ws.onmessage) {
            const messageEvent = new MessageEvent('message', {
              data: JSON.stringify({ ...event, contactId }),
            });
            act(() => {
              ws.onmessage(messageEvent);
            });
          }

          // Wait a bit to ensure no events are received
          await new Promise(resolve => setTimeout(resolve, 100));

          // Verify no events were received after unsubscribe
          expect(receivedCount).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 8.3: Connection status reflects WebSocket state
  test('Property 8.3: Connection status accurately reflects WebSocket state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(null),
        async () => {
          const { result } = renderHook(() => useRealTime(), { wrapper });

          // Initially disconnected
          expect(result.current.isConnected).toBe(false);

          // Wait for connection
          await waitFor(() => {
            expect(result.current.isConnected).toBe(true);
          });

          // Verify connected state
          expect(result.current.isConnected).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 8.4: Multiple subscriptions to same contact all receive events
  test('Property 8.4: Multiple subscriptions to same contact receive events', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        appSyncEventArb,
        fc.integer({ min: 2, max: 5 }),
        async (contactId, event, subscriberCount) => {
          const { result } = renderHook(() => useRealTime(), { wrapper });

          await waitFor(() => {
            expect(result.current.isConnected).toBe(true);
          });

          const receivedCounts: number[] = Array(subscriberCount).fill(0);

          // Create multiple subscriptions
          act(() => {
            for (let i = 0; i < subscriberCount; i++) {
              result.current.subscribe(contactId, () => {
                receivedCounts[i]++;
              });
            }
          });

          // Send event
          const ws = (global as any).WebSocket.mock?.instances?.[0];
          if (ws && ws.onmessage) {
            const messageEvent = new MessageEvent('message', {
              data: JSON.stringify({ ...event, contactId }),
            });
            act(() => {
              ws.onmessage(messageEvent);
            });
          }

          // Wait for events to be processed
          await waitFor(() => {
            expect(receivedCounts.every(count => count > 0)).toBe(true);
          });

          // Verify all subscribers received the event
          expect(receivedCounts.every(count => count === 1)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 8.5: Events for different contacts are routed correctly
  test('Property 8.5: Events are routed only to matching contact subscriptions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        appSyncEventArb,
        async (contactId1, contactId2, event) => {
          fc.pre(contactId1 !== contactId2); // Ensure different contact IDs

          const { result } = renderHook(() => useRealTime(), { wrapper });

          await waitFor(() => {
            expect(result.current.isConnected).toBe(true);
          });

          let contact1Received = 0;
          let contact2Received = 0;

          // Subscribe to both contacts
          act(() => {
            result.current.subscribe(contactId1, () => {
              contact1Received++;
            });
            result.current.subscribe(contactId2, () => {
              contact2Received++;
            });
          });

          // Send event for contact1
          const ws = (global as any).WebSocket.mock?.instances?.[0];
          if (ws && ws.onmessage) {
            const messageEvent = new MessageEvent('message', {
              data: JSON.stringify({ ...event, contactId: contactId1 }),
            });
            act(() => {
              ws.onmessage(messageEvent);
            });
          }

          // Wait for event processing
          await waitFor(() => {
            expect(contact1Received).toBe(1);
          });

          // Verify only contact1 subscription received the event
          expect(contact1Received).toBe(1);
          expect(contact2Received).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
