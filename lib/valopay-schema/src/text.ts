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
