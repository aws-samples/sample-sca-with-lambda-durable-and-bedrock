import * as fc from 'fast-check';
import { Contact, Transcription, ContactAnalytics } from '../types';

// Generator for transcriptions
export const transcriptionGenerator = (): fc.Arbitrary<Transcription> => {
  return fc.record({
    contactId: fc.uuid(),
    sequenceNumber: fc.nat(),
    timestamp: fc.date().map(d => d.toISOString()),
    speaker: fc.constantFrom('AGENT' as const, 'CUSTOMER' as const),
    text: fc.lorem({ maxCount: 50 }),
    confidence: fc.double({ min: 0, max: 1 }),
    isComplete: fc.option(fc.boolean(), { nil: undefined }),
    totalExpected: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
    metadata: fc.record({
      channel: fc.option(fc.string(), { nil: undefined }),
      language: fc.option(fc.constantFrom('en-US', 'es-ES', 'fr-FR'), { nil: undefined }),
      duration: fc.option(fc.nat({ max: 3600 }), { nil: undefined }),
      contactStatus: fc.option(fc.constantFrom('IN_PROGRESS' as const, 'COMPLETED' as const), { nil: undefined }),
    }),
  });
};

// Generator for contact analytics
export const analyticsGenerator = (): fc.Arbitrary<ContactAnalytics> => {
  return fc.record({
    contactId: fc.uuid(),
    summary: fc.lorem({ maxCount: 100 }),
    sentiment: fc.record({
      overall: fc.constantFrom('POSITIVE' as const, 'NEGATIVE' as const, 'NEUTRAL' as const, 'MIXED' as const),
      confidence: fc.double({ min: 0, max: 1 }),
      segments: fc.array(
        fc.record({
          text: fc.lorem({ maxCount: 20 }),
          sentiment: fc.string(),
          confidence: fc.double({ min: 0, max: 1 }),
        }),
        { minLength: 0, maxLength: 5 }
      ),
    }),
    topics: fc.array(
      fc.record({
        name: fc.lorem({ maxCount: 3 }),
        confidence: fc.double({ min: 0, max: 1 }),
        mentions: fc.nat({ max: 50 }),
      }),
      { minLength: 0, maxLength: 10 }
    ),
    generatedAt: fc.date().map(d => d.toISOString()),
  });
};

// Generator for contacts
export const contactGenerator = (): fc.Arbitrary<Contact> => {
  return fc.record({
    id: fc.uuid(),
    transcriptions: fc.array(transcriptionGenerator(), { minLength: 1, maxLength: 10 }),
    analytics: fc.option(analyticsGenerator(), { nil: undefined }),
    status: fc.constantFrom('IN_PROGRESS' as const, 'COMPLETED' as const, 'FAILED' as const),
    createdAt: fc.date().map(d => d.toISOString()),
    updatedAt: fc.date().map(d => d.toISOString()),
    metadata: fc.record({
      totalDuration: fc.option(fc.nat({ max: 7200 }), { nil: undefined }),
      participantCount: fc.option(fc.integer({ min: 1, max: 10 }), { nil: undefined }),
      source: fc.option(fc.string(), { nil: undefined }),
    }),
  });
};

// Generator for arrays of contacts
export const contactsArrayGenerator = (minLength = 0, maxLength = 20): fc.Arbitrary<Contact[]> => {
  return fc.array(contactGenerator(), { minLength, maxLength });
};
