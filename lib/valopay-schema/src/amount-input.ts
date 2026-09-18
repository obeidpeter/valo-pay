/** Exact decimal parsing shared by forms and CSV imports. Stored money is integer kobo. */
export class MoneyInputError extends Error {}

/** Parse a decimal naira string without floating-point multiplication. */
export function nairaToKobo(value: string): number {
  const input = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{0,2})?$/.test(input)) {
    throw new MoneyInputError('Enter an amount in naira with no more than 2 decimal places, for example 1,000.50.');
  }
  const [whole, fraction = ''] = input.replace(/,/g, '').split('.');
  const kobo = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (kobo > BigInt(Number.MAX_SAFE_INTEGER)) throw new MoneyInputError('Enter an amount of ₦90,071,992,547,409.91 or less.');
  return Number(kobo);
}

/** Format an integer kobo amount exactly, including the safe-integer boundary. */
export function koboToNaira(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new MoneyInputError('The stored amount must be a non-negative whole number of kobo.');
  const kobo = BigInt(value);
  return `${kobo / 100n}.${String(kobo % 100n).padStart(2, '0')}`;
}

/** Decode a CSV source amount in its explicitly chosen unit. */
export function csvAmountToKobo(value: string, unit: 'naira' | 'kobo'): number {
  if (unit === 'naira') return nairaToKobo(value);
  const input = value.trim();
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(Number(input))) {
    throw new MoneyInputError('Enter kobo as a whole number without commas or decimals, for example 100000. Choose Naira if the source uses naira.');
  }
  return Number(input);
}
