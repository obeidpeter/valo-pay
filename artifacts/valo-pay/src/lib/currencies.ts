import { MARKET_LOCALE, formatCount, formatKobo, formatNumber } from './formatters';

/**
 * Money in another currency than naira, which a close or a report lists beside
 * its naira totals (`otherCurrencies`) and never adds to them. Only the Reports
 * page shows it, so it stays out of `formatters`, which the shell carries.
 */
type Layout = { format: Intl.NumberFormat; unit: bigint; digits: number; positive: Intl.NumberFormatPart[]; negative: Intl.NumberFormatPart[] };
/** Each currency's layout (sign, code and separators) and how many minor units make one, by code; null for a code Intl cannot use. */
const layouts = new Map<string, Layout | null>();
function layoutOf(code: string): Layout | null {
  if (!layouts.has(code)) {
    let layout: Layout | null = null;
    try {
      const format = new Intl.NumberFormat(MARKET_LOCALE, { style: 'currency', currency: code, currencyDisplay: 'code' });
      const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
      layout = { format, unit: 10n ** BigInt(digits), digits, positive: format.formatToParts(1), negative: format.formatToParts(-1) };
    } catch { /* not a currency code */ }
    layouts.set(code, layout);
  }
  return layouts.get(code)!;
}

/**
 * An amount in a currency's minor unit, as a payment stores it, in that
 * currency with its code and the market's grouping: USD 1,000.00, JPY 1,000,
 * KWD 1,000.000; naira as formatKobo shows it. A whole number is split into
 * units and the rest with integer arithmetic, as formatKobo splits kobo, so
 * every safe integer shows exactly. A code Intl cannot use is shown as given,
 * with the amount in its smallest unit.
 */
export function formatMinor(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  if (code === 'NGN') return formatKobo(amount);
  const layout = layoutOf(code);
  if (!layout) return `${formatNumber(amount)} in the smallest unit of ${code || 'an unnamed currency'}`;
  if (!Number.isSafeInteger(amount)) return layout.format.format(amount / Number(layout.unit));
  const minor = BigInt(amount), whole = minor < 0n ? -minor : minor;
  return (minor < 0n ? layout.negative : layout.positive)
    .map(part => part.type === 'integer' ? formatNumber(Number(whole / layout.unit)) : part.type === 'fraction' ? String(whole % layout.unit).padStart(layout.digits, '0') : part.value)
    .join('');
}

/**
 * A naira total with the money held beside it in other currencies, which is
 * never added to it: `otherCurrencies` as the API lists it (by currency code,
 * a count and an amount in that currency's minor unit), each in its own
 * currency with what it counts: "₦32,000.00 and USD 1,000.00 (1 payment)".
 * With none, the naira total alone.
 */
export function formatWithOtherCurrencies(kobo: number, otherCurrencies: unknown, singular: string, pluralForm?: string): string {
  const others = Object.entries(otherCurrencies && typeof otherCurrencies === 'object' ? otherCurrencies as Record<string, { count?: unknown; amount?: unknown } | null> : {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, entry]) => `${formatMinor(Number(entry?.amount ?? 0), code)} (${formatCount(Number(entry?.count ?? 0), singular, pluralForm)})`);
  const amounts = [formatKobo(kobo), ...others];
  return amounts.length === 1 ? amounts[0]! : `${amounts.slice(0, -1).join(', ')} and ${amounts.at(-1)}`;
}
