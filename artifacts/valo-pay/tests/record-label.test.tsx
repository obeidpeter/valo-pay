import { describe, expect, it } from 'vitest';
import { readableLabel } from '../src/components/record-label';

describe('readable record labels', () => {
  it('explains known statuses and failure codes in ordinary words', () => {
    expect(readableLabel('pending_activation')).toBe('Awaiting activation');
    expect(readableLabel('INSUFFICIENT_FUNDS')).toBe('Insufficient funds');
  });

  it('keeps unfamiliar values readable without confusing them with inherited properties', () => {
    expect(readableLabel('awaitingProviderReview')).toBe('Awaiting Provider Review');
    expect(readableLabel('next_provider-stage')).toBe('Next provider stage');
    expect(readableLabel('constructor')).toBe('Constructor');
    expect(readableLabel(undefined)).toBe('Unknown');
  });
});
