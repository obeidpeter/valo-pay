/**
 * The console's conventions, in one place: British English words and dates
 * (18 Sept 2026, 23:30), the market's numbers and money (₦25,000.00), and every
 * instant in West Africa Time, the lender's operating zone, whatever the
 * viewer's device is set to. Lagos has kept UTC+1 all year since 1949, so the
 * zone label never changes.
 */
export const DATE_LOCALE = 'en-GB';
export const MARKET_LOCALE = 'en-NG';
export const TIME_ZONE = 'Africa/Lagos';
export const TIME_ZONE_LABEL = 'WAT';

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const instant = new Intl.DateTimeFormat(DATE_LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone: TIME_ZONE });
const day = new Intl.DateTimeFormat(DATE_LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: TIME_ZONE });
const naira = new Intl.NumberFormat(MARKET_LOCALE, { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 });
const number = new Intl.NumberFormat(MARKET_LOCALE);
const plural = new Intl.PluralRules(MARKET_LOCALE);

export function formatKobo(kobo: number): string {
  return naira.format(kobo / 100);
}

/** A plain number with the market's grouping: 20,000. */
export function formatNumber(value: number): string {
  return number.format(value);
}

/** A count with its noun in the right number: "1 item", "0 items", "1,234 records". An irregular plural is passed in. (The API's `counted` in the schema package is the same rule; the console keeps its own so the shell does not carry that package.) */
export function formatCount(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${number.format(count)} ${plural.select(count) === 'one' ? singular : pluralForm}`;
}

/** An instant as its date and time in West Africa Time with the zone named. A value that is only a day (YYYY-MM-DD) is shown as that day, with no invented time. */
export function formatDate(dateStr: string): string {
  if (!dateStr) return 'Not recorded';
  const date = new Date(dateStr);
  if (!Number.isFinite(date.getTime())) return dateStr === 'Not closed yet' ? 'Not closed yet' : 'Not recorded';
  if (DAY_ONLY.test(dateStr)) return day.format(date);
  return `${instant.format(date)} ${TIME_ZONE_LABEL}`;
}

/** The day of an instant in West Africa Time: 28 Jun 2027. */
export function formatCompactDate(dateStr: string): string {
  if (!dateStr || !Number.isFinite(new Date(dateStr).getTime())) return 'Not recorded';
  return day.format(new Date(dateStr));
}
