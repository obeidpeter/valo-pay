/**
 * Wording helpers shared by the API and the console, so a count reads the same
 * everywhere and the market's number conventions are named once.
 */

/** Nigerian English for numbers and money: 1,234.56 and the naira sign. */
export const MARKET_LOCALE = "en-NG";

const numberFormat = new Intl.NumberFormat(MARKET_LOCALE);
const moneyFormat = new Intl.NumberFormat(MARKET_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pluralRules = new Intl.PluralRules(MARKET_LOCALE);

/** A count with its noun in the right number: "1 item", "0 items", "1,234 records". An irregular plural is passed in. */
export function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${numberFormat.format(count)} ${pluralRules.select(count) === "one" ? singular : plural}`;
}
/** An amount in kobo as the API's messages write money: "NGN 25,000.00". */
export function nairaText(kobo: number): string {
  return `NGN ${moneyFormat.format(kobo / 100)}`;
}
