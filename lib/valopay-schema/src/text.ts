/**
 * Wording helpers shared by the API and the console, so a count reads the same
 * everywhere and the market's number conventions are named once.
 */

/** Nigerian English for numbers and money: 1,234.56 and the naira sign. */
export const MARKET_LOCALE = "en-NG";

const numberFormat = new Intl.NumberFormat(MARKET_LOCALE);
const moneyFormat = new Intl.NumberFormat(MARKET_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The layout (sign and separators) of an amount above zero and one below.
const moneyLayout = { positive: moneyFormat.formatToParts(1), negative: moneyFormat.formatToParts(-1) };
const pluralRules = new Intl.PluralRules(MARKET_LOCALE);

/** A count with its noun in the right number: "1 item", "0 items", "1,234 records". An irregular plural is passed in. */
export function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${numberFormat.format(count)} ${pluralRules.select(count) === "one" ? singular : plural}`;
}
/**
 * An amount in kobo as the API's messages write money: "NGN 25,000.00". A whole
 * number of kobo is split into naira and kobo with integer arithmetic, so every
 * safe integer reads exactly; dividing by 100 as a float loses a kobo above about
 * NGN 10 trillion.
 */
export function nairaText(kobo: number): string {
  if (!Number.isSafeInteger(kobo)) return `NGN ${moneyFormat.format(kobo / 100)}`;
  const minor = BigInt(kobo), whole = minor < 0n ? -minor : minor;
  const parts = (minor < 0n ? moneyLayout.negative : moneyLayout.positive)
    .map((part) => part.type === "integer" ? numberFormat.format(whole / 100n) : part.type === "fraction" ? String(whole % 100n).padStart(2, "0") : part.value);
  return `NGN ${parts.join("")}`;
}

/** The decimal places of a currency's minor unit, as Intl knows it: 2 for USD, 0 for JPY; 2 for a code it cannot read. */
function minorUnitDigits(currency: string): number {
  try {
    return new Intl.NumberFormat(MARKET_LOCALE, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}
/**
 * An amount in its currency's minor unit, as a payment stores it, written the
 * way the API's messages write money: naira as nairaText does ("NGN 25,000.00"),
 * any other currency by its code with its own decimals ("USD 1,000.00" for
 * 100,000 cents), with the same integer arithmetic.
 */
export function moneyText(amount: number, currency = "NGN"): string {
  const code = String(currency || "NGN").trim().toUpperCase();
  if (code === "NGN") return nairaText(amount);
  const digits = minorUnitDigits(code), layout = new Intl.NumberFormat(MARKET_LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (!Number.isSafeInteger(amount)) return `${code} ${layout.format(amount / 10 ** digits)}`;
  const minor = BigInt(amount), whole = minor < 0n ? -minor : minor, unit = 10n ** BigInt(digits);
  const parts = layout.formatToParts(minor < 0n ? -1 : 1)
    .map((part) => part.type === "integer" ? numberFormat.format(whole / unit) : part.type === "fraction" ? String(whole % unit).padStart(digits, "0") : part.value);
  return `${code} ${parts.join("")}`;
}
/**
 * Money in currencies other than naira, as the close and the billing statement
 * list it beside a naira total (otherCurrencies: each code's count and amount
 * in its minor unit), for a sentence: "EUR 50.00 and USD 1,000.00", by code.
 */
export function otherCurrenciesText(other: Readonly<Record<string, { amount: number }>> | undefined): string {
  const rows = Object.entries(other ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Intl.ListFormat("en-GB").format(rows.map(([code, row]) => moneyText(row.amount, code)));
}
