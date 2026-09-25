/** Money rules from the business plan v2.1 and TRD sections 5.3 and 5.15.  Amounts are integer kobo. */

/** Debits under ₦5,000 are refused with no override (MAN-07, gate change note change 11). */
export const ABSOLUTE_TICKET_FLOOR_KOBO = 500_000;
/** Merchant default minimum; between the floor and this value a recorded Admin override is needed. */
export const DEFAULT_MINIMUM_TICKET_KOBO = 1_000_000;

/** Usage fee: 0.3% capped at ₦150 per successful collection (BIL-02). */
export const USAGE_FEE_BPS = 30;
/** The cap on the usage fee for one collection: ₦150. */
export const USAGE_FEE_CAP_KOBO = 15_000;

/** Monthly licence tiers by successful collections (BIL-02). */
export const licenceTiers = [
  { name: "Entry", maxMonthlyCollections: 2_999, licenceKobo: 15_000_000, targetCustomer: false },
  { name: "Standard", maxMonthlyCollections: 10_000, licenceKobo: 35_000_000, targetCustomer: true },
  { name: "Scale", maxMonthlyCollections: Number.POSITIVE_INFINITY, licenceKobo: 60_000_000, targetCustomer: true },
] as const;
/** The licence tier for a month's successful collections; the largest tier when the volume exceeds every bound. */
export function licenceTierFor(monthlyCollections: number) {
  return licenceTiers.find((tier) => monthlyCollections <= tier.maxMonthlyCollections) ?? licenceTiers[licenceTiers.length - 1]!;
}

/** Recovery fee, gated on the Test 2 decision (BIL-03): billed only after the 30-day window closes, engine arm only. */
export const RECOVERY_FEE_KOBO = 15_000;

/** BIL-04: invoices are net of VAT with VAT shown; Nigeria's statutory rate, overridable per merchant in settings.vatBps. */
export const DEFAULT_VAT_BPS = 750;
/** VAT on a net amount at the given basis points, rounded down to a kobo. */
export function vatKobo(netKobo: number, bps: number = DEFAULT_VAT_BPS): number {
  return Math.floor((netKobo * bps) / 10_000);
}

/** Design partners pay half in 2027 and full public prices from 1 January 2028. */
export const DESIGN_PARTNER_DISCOUNT_YEAR = "2027";
/** The share of the public price a design partner pays in the discount year. */
export const DESIGN_PARTNER_DISCOUNT = 0.5;

/**
 * Provider (aggregator) fee schedule per CON-09.  The plan's sourced figure for
 * NIBSS direct debit through Paystack is 0.5% capped at ₦1,000; each provider
 * connection and merchant may configure its own dated schedule.
 */
export interface ProviderFeeSchedule { readonly bps: number; readonly capKobo: number }
/** The plan's sourced schedule: 0.5% capped at ₦1,000. */
export const DEFAULT_PROVIDER_FEE: ProviderFeeSchedule = { bps: 50, capKobo: 100_000 };
/** The provider's fee on a gross collection under a schedule, rounded down and capped. */
export function providerFeeKobo(grossKobo: number, schedule: ProviderFeeSchedule = DEFAULT_PROVIDER_FEE): number {
  const fee = Math.floor((grossKobo * schedule.bps) / 10_000);
  return Math.min(fee, schedule.capKobo);
}

/**
 * Decision on settlement batches in another currency: a fee schedule is in
 * naira (basis points with a cap in kobo), whether configured per connection
 * (providerFeeSchedule), the legacy providerFeeBps or the plan's default, so
 * only a batch in naira has one. A batch in another currency has no expected
 * fee and no fee variance: its fees are not checked, and only its statement
 * credit is.
 */
export const FEE_SCHEDULE_CURRENCY = "NGN";
/** Whether a fee schedule exists for money in this currency (FEE_SCHEDULE_CURRENCY), so its fees are checked. */
export const hasFeeSchedule = (currency: string): boolean => String(currency || FEE_SCHEDULE_CURRENCY).trim().toUpperCase() === FEE_SCHEDULE_CURRENCY;

/** ING-07 tolerances: ₦0 per item, ₦100 per batch by default. */
export const SETTLEMENT_ITEM_TOLERANCE_KOBO = 0;
/** How far a batch's net may differ from gross minus fees before it is a variance: ₦100. */
export const SETTLEMENT_BATCH_TOLERANCE_KOBO = 10_000;

/**
 * BIL-01: a collection is billable when its attempt succeeded, which means a
 * direct debit the platform observed; transfers, card receipts and statement
 * credits are reconciled and reported but never billed as collections.
 */
export const billableChannels = ["direct_debit"] as const;
/** True for a channel whose collections are billed. */
export const isBillableChannel = (channel: unknown): boolean => (billableChannels as readonly string[]).includes(String(channel));
/** Days after settlement before a collection can be billed unless the provider's own window is configured. */
export const DEFAULT_REVERSAL_WINDOW_DAYS = 7;

/** The usage fee on a collected amount (BIL-02): 0.3%, rounded down and capped. */
export function usageFeeKobo(collectedKobo: number): number {
  return Math.min(USAGE_FEE_CAP_KOBO, Math.floor((collectedKobo * USAGE_FEE_BPS) / 10_000));
}

/** True for a non-negative safe integer, the only shape an amount may take. */
export const isKobo = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** MEA-03: the plan's unit-economics assumptions to compare against: NGN 15 variable cost per collection and 85–90% gross margin. */
export const VARIABLE_COST_PER_COLLECTION_KOBO = 1_500;
/** The plan's gross-margin range the measured margin is compared against (MEA-03). */
export const PLAN_GROSS_MARGIN = { low: 0.85, high: 0.9 } as const;
