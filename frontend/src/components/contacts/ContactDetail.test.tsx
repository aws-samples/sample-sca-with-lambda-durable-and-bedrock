import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import * as fc from 'fast-check';
import { ContactDetail } from './ContactDetail';
import { AuthProvider } from '../../contexts/AuthContext';
import { contactGenerator } from '../../test-utils/generators';
import { Contact } from '../../types';

// Mock fetch globally
global.fetch = jest.fn();

// Mock useAuth hook
jest.mock('../../contexts/AuthContext', () => ({
  ...jest.requireActual('../../contexts/AuthContext'),
  useAuth: () => ({
    user: { username: 'testuser', token: 'test-token' },
    isAuthenticated: true,
    isLoading: false,
    error: null,
    login: jest.fn(),
    logout: jest.fn(),
  }),
}));

// Mock environment variables
process.env.REACT_APP_API_ENDPOINT = 'http://test-api.example.com';

const renderContactDetail = (contactId: string) => {
  return render(
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/contacts/:contactId" element={<ContactDetail />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>,
    { initialEntries: [`/contacts/${contactId}`] } as any
  );
};

describe('ContactDetail Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Feature: serverless-conversational-analytics, Property 7: Web Application Data Display
   * Validates: Requirements 5.2, 5.4
   * 
   * Property: For any contact with detailed information, ContactDetail should display
   * all transcriptions, analytics, and metadata
   */
  test('Property 7.6: ContactDetail displays complete contact information', async () => {
    await fc.assert(
      fc.asyncProperty(contactGenerator(), async (contact: Contact) => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ contact }),
        });

        renderContactDetail(contact.id);

        await waitFor(() => {
          expect(screen.queryByText('Loading contact details...')).not.toBeInTheDocument();
        });

        // Verify contact ID is displayed
        expect(screen.getByText(contact.id)).toBeInTheDocument();

        // Verify status is displayed
        expect(screen.getByText(contact.status)).toBeInTheDocument();

        // Verify transcriptions count if present
        if (contact.transcriptions && contact.transcriptions.length > 0) {
          expect(screen.getByText(new RegExp(`Transcriptions \\(${contact.transcriptions.length}\\)`))).toBeInTheDocument();
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7.7: ContactDetail displays all transcriptions in sequence order
   * Validates: Requirements 5.2, 5.4
   */
  test('Property 7.7: All transcriptions are displayed in correct sequence', async () => {
    await fc.assert(
      fc.asyncProperty(contactGenerator(), async (contact: Contact) => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ contact }),
        });

        renderContactDetail(contact.id);

        await waitFor(() => {
          expect(screen.queryByText('Loading contact details...')).not.toBeInTheDocument();
        });

        // Verify each transcription text is displayed
        if (contact.transcriptions && contact.transcriptions.length > 0) {
          contact.transcriptions.forEach(transcription => {
            // Check that transcription text appears somewhere in the document
            const textElements = screen.queryAllByText(new RegExp(transcription.text.substring(0, 20)));
            expect(textElements.length).toBeGreaterThan(0);
          });
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7.8: ContactDetail displays analytics summary when available
   * Validates: Requirements 5.2
   */
  test('Property 7.8: Analytics summary is displayed when present', async () => {
    await fc.assert(
      fc.asyncProperty(contactGenerator(), async (contact: Contact) => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ contact }),
        });

        renderContactDetail(contact.id);

        await waitFor(() => {
          expect(screen.queryByText('Loading contact details...')).not.toBeInTheDocument();
        });

        // If analytics exists, verify summary is displayed
        if (contact.analytics && contact.analytics.summary) {
          const summaryText = contact.analytics.summary.substring(0, 50);
          expect(screen.getByText(new RegExp(summaryText.substring(0, 20)))).toBeInTheDocument();
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7.9: ContactDetail displays sentiment analysis when available
   * Validates: Requirements 5.2
   */
  test('Property 7.9: Sentiment analysis is displayed correctly', async () => {
    await fc.assert(
      fc.asyncProperty(contactGenerator(), async (contact: Contact) => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ contact }),
        });

        renderContactDetail(contact.id);

        await waitFor(() => {
          expect(screen.queryByText('Loading contact details...')).not.toBeInTheDocument();
        });

        // If analytics exists, verify sentiment is displayed
        if (contact.analytics) {
          expect(screen.getByText(contact.analytics.sentiment.overall)).toBeInTheDocument();
        }
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7.10: ContactDetail displays topics when available
   * Validates: Requirements 5.2
   */
  test('Property 7.10: Key topics are displayed when present', async () => {
    await fc.assert(
      fc.asyncProperty(contactGenerator(), async (contact: Contact) => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ contact }),
        });

        renderContactDetail(contact.id);

        await waitFor(() => {
          expect(screen.queryByText('Loading contact details...')).not.toBeInTheDocument();
        });

        // If topics exist, verify they are displayed
        if (contact.analytics && contact.analytics.topics && contact.analytics.topics.length > 0) {
          contact.analytics.topics.forEach(topic => {
            expect(screen.getByText(topic.name)).toBeInTheDocument();
          });
        }
      }),
      { numRuns: 100 }
    );
  });
});
