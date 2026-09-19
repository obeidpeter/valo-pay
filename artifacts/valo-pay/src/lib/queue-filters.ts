import { useSearchParams } from 'wouter';
import { TIME_ZONE } from './formatters';

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Queue dates use the same lender timezone as the date displayed beside them. */
export function queueDay(value: string | number | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = dayFormatter.formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-');
}

/** A day-only deadline lasts the whole day; a timed deadline expires at its stated instant. */
export function isOverdue(value: unknown, now = Date.now()): boolean {
  const deadline = String(value || '');
  if (!deadline) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    ? deadline < queueDay(now)
    : Date.parse(deadline) < now;
}

/** Match the API's exception/activation deadline comparison, including imported day-only deadlines. */
export function isDeadlineOverdue(value: unknown, now = Date.now()): boolean {
  return Date.parse(String(value || '')) < now;
}

/** Unlike an instalment due date, a stored deadline is an instant in the API. */
export function deadlineInstant(value: unknown): string {
  const deadline = String(value || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? `${deadline}T00:00:00.000Z` : deadline;
}

export function isDueToday(value: unknown, now = Date.now()): boolean {
  const deadline = String(value || '');
  return !!deadline && queueDay(deadline) === queueDay(now);
}

export function deadlineOrder(left: unknown, right: unknown): number {
  const date = (value: unknown) => { const time = Date.parse(String(value || '')); return Number.isFinite(time) ? time : Infinity; };
  const a = date(left), b = date(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Filters survive a copied URL, browser navigation and a visit from the overview. */
export function useQueueFilters<T extends string>(views: readonly T[], fallback: T) {
  const [search, setSearch] = useSearchParams();
  const candidate = search.get('view') as T;
  const view = views.includes(candidate) ? candidate : fallback;
  const owner = search.get('owner') || '';
  const setFilter = (key: 'view' | 'owner' | 'type', value: string) => setSearch(current => {
    const next = new URLSearchParams(current);
    next.delete('page');
    if (!value || (key === 'view' && value === fallback)) next.delete(key);
    else next.set(key, value);
    return next;
  });
  return { view, owner, type: search.get('type') || '', setView: (value: T) => setFilter('view', value), setOwner: (value: string) => setFilter('owner', value), setType: (value: string) => setFilter('type', value) };
}
