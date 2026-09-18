/**
 * TRD 4.4 normalised failure codes.  Every module downstream of a connector
 * works only with these codes; provider-specific spellings are aliases.
 */
export type RetryRule = "yes" | "once" | "no" | "never" | "unresolved";

/** A catalogue entry: what the code means, its retry rule and how it is handled. */
export interface FailureCodeDefinition {
  readonly meaning: string;
  readonly retry: RetryRule;
  readonly handling: string;
}

/** The TRD 4.4 catalogue, keyed by normalised code. */
export const failureCodes = {
  INSUFFICIENT_FUNDS: { meaning: "Not enough money on the due date.", retry: "yes", handling: "Policy retry with notice." },
  ACCOUNT_RESTRICTED: { meaning: "Post-no-debit or similar restriction.", retry: "once", handling: "One retry after spacing; then exception." },
  INVALID_ACCOUNT: { meaning: "Account does not exist or is closed.", retry: "no", handling: "Exception; mandate flagged." },
  MANDATE_INACTIVE: { meaning: "Mandate not active at the provider.", retry: "no", handling: "Mandate operations; attempt cancelled." },
  MANDATE_LIMIT_EXCEEDED: { meaning: "Amount above the mandate limit.", retry: "no", handling: "Exception; never re-sent at a lower amount without consent coverage." },
  BANK_UNAVAILABLE: { meaning: "The customer's bank did not respond.", retry: "yes", handling: "Policy retry." },
  PROVIDER_ERROR: { meaning: "The aggregator failed internally.", retry: "yes", handling: "Transport retry first; policy retry if the provider confirms no debit occurred." },
  TIMEOUT_UNKNOWN: { meaning: "No definitive outcome.", retry: "unresolved", handling: "Status query; exception after 24 hours." },
  DUPLICATE: { meaning: "Provider reports a duplicate instruction.", retry: "no", handling: "Reconcile against the original." },
  CUSTOMER_DISPUTED: { meaning: "Customer has disputed the debit.", retry: "never", handling: "Freeze the due item; exception with 1-day SLA." },
  UNKNOWN: { meaning: "Unmapped provider code.", retry: "no", handling: "Exception; classify; extend mapping." },
} as const satisfies Record<string, FailureCodeDefinition>;

/** A catalogue code. */
export type FailureCode = keyof typeof failureCodes;
/** Every catalogue code, in catalogue order. */
export const failureCodeList = Object.keys(failureCodes) as FailureCode[];

/** Spellings earlier builds and some providers use.  Mapped, never stored. */
export const failureCodeAliases: Readonly<Record<string, FailureCode>> = {
  TECHNICAL_FAILURE: "PROVIDER_ERROR",
  ACCOUNT_CLOSED: "INVALID_ACCOUNT",
  MANDATE_CANCELLED: "MANDATE_INACTIVE",
  MANDATE_EXPIRED: "MANDATE_INACTIVE",
  MANDATE_SUSPENDED: "MANDATE_INACTIVE",
  NO_MANDATE: "MANDATE_INACTIVE",
  LIMIT_EXCEEDED: "MANDATE_LIMIT_EXCEEDED",
  TIMEOUT: "TIMEOUT_UNKNOWN",
  DISPUTED: "CUSTOMER_DISPUTED",
};

/** True for a catalogue code or a known alias, whatever its case. */
export function isKnownFailureCode(raw: unknown): boolean {
  const value = String(raw ?? "").trim().toUpperCase();
  return value in failureCodes || value in failureCodeAliases;
}

/** Map any raw code to the catalogue; unmapped codes become UNKNOWN (mapping needed). */
export function normaliseFailureCode(raw: unknown): FailureCode {
  const value = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (value in failureCodes) return value as FailureCode;
  return failureCodeAliases[value] ?? "UNKNOWN";
}

/** The retry rule for any raw code; an unmapped code is UNKNOWN and is not retried. */
export function retryRuleFor(raw: unknown): RetryRule {
  return failureCodes[normaliseFailureCode(raw)].retry;
}

/** Codes the section 6.2 parameter table allows a policy to retry. */
export const retryableFailureCodes: readonly FailureCode[] = failureCodeList.filter((code) => failureCodes[code].retry === "yes" || failureCodes[code].retry === "once");
/** Codes that can never be added to a retryable list (section 6.2). */
export const neverRetryableFailureCodes: readonly FailureCode[] = ["INVALID_ACCOUNT", "MANDATE_INACTIVE", "MANDATE_LIMIT_EXCEEDED", "CUSTOMER_DISPUTED"];
