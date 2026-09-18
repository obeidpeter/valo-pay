import { describe, expect, it } from 'vitest';
import { deadlineInstant, deadlineOrder, isDueToday, isDeadlineOverdue, isOverdue, queueDay } from '@/lib/queue-filters';

describe('queue deadlines in West Africa Time', () => {
  it('keeps a date-only instalment due all day, and uses Lagos midnight for today', () => {
    const beforeMidnight = Date.parse('2026-09-18T22:59:59Z');
    const midnight = Date.parse('2026-09-18T23:00:00Z');
    expect(queueDay(midnight)).toBe('2026-09-19');
    expect(isDueToday('2026-09-18', beforeMidnight)).toBe(true);
    expect(isOverdue('2026-09-18', beforeMidnight)).toBe(false);
    expect(isOverdue('2026-09-18', midnight)).toBe(true);
    expect(isDueToday('2026-09-19', midnight)).toBe(true);
  });

  it('uses the actual instant for timed exception and activation deadlines', () => {
    const deadline = '2026-09-18T09:30:00Z';
    expect(isOverdue(deadline, Date.parse(deadline))).toBe(false);
    expect(isOverdue(deadline, Date.parse(deadline) + 1)).toBe(true);
    expect(isDueToday(deadline, Date.parse('2026-09-18T23:00:00Z'))).toBe(false);
    expect(isOverdue('not a date')).toBe(false);
    expect(isDueToday(undefined)).toBe(false);
    expect(deadlineOrder(undefined, deadline)).toBeGreaterThan(0);
    expect(deadlineOrder(undefined, undefined)).toBe(0);
    // Imported exception deadlines follow the API's instant comparison;
    // instalment dates continue to last the entire WAT day.
    const sameDay = Date.parse('2026-09-18T10:00:00Z');
    expect(isDeadlineOverdue('2026-09-18', sameDay)).toBe(true);
    expect(isOverdue('2026-09-18', sameDay)).toBe(false);
    expect(deadlineInstant('2026-09-18')).toBe('2026-09-18T00:00:00.000Z');
  });
});
