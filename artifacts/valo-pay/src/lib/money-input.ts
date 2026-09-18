/** Form and import amounts use the same exact parser; API amounts remain integer kobo. */
export { MoneyInputError, nairaToKobo, koboToNaira } from '@workspace/valopay-schema';

/** Existing form definitions still identify API fields by their canonical Kobo names. */
export function moneyFieldLabel(label: string): string {
  if (/\([^)]*kobo[^)]*\)/i.test(label)) return label.replace(/\([^)]*kobo[^)]*\)/i, '(₦)');
  return label.includes('₦') ? label : `${label} (₦)`;
}
