import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import * as fc from 'fast-check';
import { ContactList } from './ContactList';
import { AuthProvider } from '../../contexts/AuthContext';
import { contactsArrayGenerator } from '../../test-utils/generators';
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

const renderContactList = () => {
  return render(
    <BrowserRouter>
      <AuthProvider>
        <ContactList />
      </AuthProvider>
    </BrowserRouter>
  );
};

describe('ContactList Property Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Feature: serverless-conversational-analytics, Property 7: Web Application Data Display
   * Validates: Requirements 5.1, 5.2, 5.4, 5.5
   * 
   * Property: For any list of contacts returned by the API, the ContactList component
   * should display all contacts with their interaction data
   */
  test('Property 7.1: ContactList displays all contacts from API response', async () => {
    await fc.assert(
      fc.asyncProperty(contactsArrayGenerator(1, 10), async (contacts: Contact[]) => {
        // Mock API response
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ contacts }),
        });

        renderContactList();

        // Wait for contacts to load
        await waitFor(() => {
          expect(screen.queryByText('Loading contacts...')).not.toBeInTheDocument();
        });

        // Verify all contacts are displayed
        contacts.forEach(contact => {
          expect(screen.getByText(contact.id)).toBeInTheDocument();
        });
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7.2: ContactList displays contact status badges correctly
   * Validates: Requirements 5.1, 5.2
   */
  test('Property 7.2: All contact status badges are displayed correctly', async () => {
    await fc.assert(
      fc.asyncProperty(contactsArrayGenerator(1, 10), async (contacts: Contact[]) => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ contacts }),
        });

        renderContactList();

        await waitFor(() => {
          expect(screen.queryByText('Loading contacts...')).not.toBeInTheDocument();
        });

        // Verify each contact has a status badge
        contacts.forEach(contact => {
          const statusElements = screen.getAllByText(contact.status);
          expect(statusElements.length).toBeGreaterThan(0);
        });
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7.3: ContactList displays analytics data when available
   * Validates: Requirements 5.2
   */
  test('Property 7.3: Analytics data is displayed for contacts that have it', async () => {
    await fc.assert(
      fc.asyncProperty(contactsArrayGenerator(1, 10), async (contacts: Contact[]) => {
        (global.fetch as jest.Mock).mockResolvedValueOnce({
          ok: true,
          json: async () => ({ contacts }),
        });

        renderContactList();

        await waitFor(() => {
          expect(screen.queryByText('Loading contacts...')).not.toBeInTheDocument();
        });

        // Verify analytics data is shown for contacts that have it
        contacts.forEach(contact => {
          if (contact.analytics) {
            // Check sentiment is displayed
            expect(screen.getByText(contact.analytics.sentiment.overall)).toBeInTheDocument();
            
            // Check summary preview is displayed (at least part of it)
            const summaryPreview = contact.analytics.summary.substring(0, 50);
            expect(screen.getByText(new RegExp(summaryPreview.substring(0, 20)))).toBeInTheDocument();
          }
        });
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7.4: Loading indicator is shown while fetching data
   * Validates: Requirements 5.5
   */
  test('Property 7.4: Loading indicator appears during data fetch', async () => {
    await fc.assert(
      fc.asyncProperty(contactsArrayGenerator(1, 5), async (contacts: Contact[]) => {
        // Create a delayed promise to simulate loading
        let resolvePromise: (value: any) => void;
        const delayedPromise = new Promise(resolve => {
          resolvePromise = resolve;
        });

        (global.fetch as jest.Mock).mockReturnValueOnce(delayedPromise);

        renderContactList();

        // Loading indicator should be present initially
        expect(screen.getByText('Loading contacts...')).toBeInTheDocument();

        // Resolve the promise
        resolvePromise!({
          ok: true,
          json: async () => ({ contacts }),
        });

        // Wait for loading to complete
        await waitFor(() => {
          expect(screen.queryByText('Loading contacts...')).not.toBeInTheDocument();
        });
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7.5: Error handling displays error message
   * Validates: Requirements 5.5
   */
  test('Property 7.5: Error message is displayed when API call fails', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), async (errorMessage: string) => {
        (global.fetch as jest.Mock).mockRejectedValueOnce(new Error(errorMessage));

        renderContactList();

        await waitFor(() => {
          expect(screen.queryByText('Loading contacts...')).not.toBeInTheDocument();
        });

        // Error message should be displayed
        expect(screen.getByText(/Error:/)).toBeInTheDocument();
        expect(screen.getByText(new RegExp(errorMessage))).toBeInTheDocument();
      }),
      { numRuns: 100 }
    );
  });
});
