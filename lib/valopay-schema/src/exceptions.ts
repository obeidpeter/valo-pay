/** TRD Appendix A exception catalogue: trigger, default owner, SLA and controlled resolution codes. */
export interface ExceptionDefinition {
  readonly title: string;
  readonly trigger: string;
  readonly owner: string;
  readonly slaBusinessDays: number;
  readonly severity: "low" | "medium" | "high";
  readonly resolutionCodes: readonly string[];
}

/** The Appendix A catalogue, keyed by exception type. */
export const exceptionCatalogue = {
  activation_expired: { title: "Activation deadline passed", trigger: "Mandate passes its activation deadline", owner: "Operations", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["reissued", "customer_declined", "wrong_number", "abandoned"] },
  unallocated_payment: { title: "Unallocated payment", trigger: "A payment is still unmatched after 24 hours", owner: "Finance", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["allocated_manual", "refund_requested", "held_credit", "not_ours"] },
  suspected_duplicate: { title: "Suspected duplicate", trigger: "A payment may be a duplicate of another payment", owner: "Finance", slaBusinessDays: 2, severity: "high", resolutionCodes: ["confirmed_duplicate_refund", "distinct_payments", "applied_to_next"] },
  overpayment: { title: "Overpayment", trigger: "The allocated amount is more than the instalment due", owner: "Finance", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["refund_requested", "held_credit", "applied_to_next"] },
  unpaid_after_final_attempt: { title: "Unpaid after final attempt", trigger: "The retry policy allows no further attempts", owner: "Operations", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["paid_other_channel", "rescheduled_by_lms", "written_off_by_lms", "mandate_reissued"] },
  mandate_limit_exceeded: { title: "Mandate limit exceeded", trigger: "Due amount above the mandate limit", owner: "Operations", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["limit_raised_new_mandate", "split_by_lms", "cancelled"] },
  settlement_variance: { title: "Settlement variance", trigger: "The net settlement amount does not match the gross amount minus fees", owner: "Finance", slaBusinessDays: 2, severity: "medium", resolutionCodes: ["fee_schedule_updated", "provider_corrected", "accepted_variance"] },
  provider_status_mismatch: { title: "Provider status mismatch", trigger: "Provider and platform disagree on mandate or attempt state", owner: "Operations", slaBusinessDays: 1, severity: "medium", resolutionCodes: ["provider_state_adopted", "platform_state_confirmed", "escalated_to_provider"] },
  customer_dispute: { title: "Customer dispute", trigger: "The provider reports a disputed debit, or the lender records a customer dispute", owner: "Operations", slaBusinessDays: 1, severity: "high", resolutionCodes: ["upheld_refund", "not_upheld", "mandate_cancelled"] },
  unknown_outcome: { title: "Unknown outcome", trigger: "A debit's outcome, or a pay-by-bank payment's, is still unknown after 24 hours", owner: "Operations", slaBusinessDays: 1, severity: "high", resolutionCodes: ["resolved_succeeded", "resolved_failed", "provider_confirmed_no_debit"] },
  notice_not_evidenced: { title: "Notice acceptance not confirmed", trigger: "There is no evidence that the provider accepted a required notice by its deadline", owner: "Operations", slaBusinessDays: 1, severity: "medium", resolutionCodes: ["number_corrected", "channel_restored", "deferred_executed", "customer_unreachable_cancelled"] },
  ownership_conflict: { title: "Ownership conflict", trigger: "Another system attempted collection for a group assigned to Valo Pay, or the group changed before the required ownership check", owner: "Admin", slaBusinessDays: 1, severity: "high", resolutionCodes: ["incumbent_disabled", "owner_reverted", "duplicate_refund_requested"] },
  imported_consent_gap: { title: "Missing consent evidence", trigger: "An imported mandate with missing consent evidence", owner: "Admin", slaBusinessDays: 2, severity: "high", resolutionCodes: ["gap_accepted_in_writing", "evidence_supplied", "mandate_reissued", "observation_only"] },
  mapping_needed: { title: "Failure code needs classification", trigger: "The provider returned a failure code that has not been classified", owner: "Valo Pay ops", slaBusinessDays: 2, severity: "low", resolutionCodes: ["mapped_to_code"] },
} as const satisfies Record<string, ExceptionDefinition>;

/** A catalogue exception type. */
export type ExceptionType = keyof typeof exceptionCatalogue;
/** Every catalogue type. */
export const exceptionTypes = Object.keys(exceptionCatalogue) as ExceptionType[];

/** Type spellings earlier builds wrote.  Read as the catalogue type, never written. */
export const exceptionTypeAliases: Readonly<Record<string, ExceptionType>> = {
  possible_duplicate: "suspected_duplicate",
  duplicate: "suspected_duplicate",
  unallocated: "unallocated_payment",
  final_attempt: "unpaid_after_final_attempt",
};

/** Reads a type from stored or input data, accepting earlier spellings; undefined when unknown. */
export function resolveExceptionType(raw: unknown): ExceptionType | undefined {
  const value = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (value in exceptionCatalogue) return value as ExceptionType;
  return exceptionTypeAliases[value];
}

/** Codes accepted for an exception whose type is not in the catalogue (legacy rows). */
export const genericResolutionCodes = ["no_action_required", "customer_contacted", "evidence_received", "ownership_corrected", "refunded_externally", "allocated", "duplicate_confirmed", "mandate_reissued"] as const;

/**
 * The code the platform records when it closes an exception whose condition
 * cleared: its payment was allocated in full, refunded or reversed, its
 * instalment was paid or left dispute, or its outcome became known. It is
 * never a person's resolution, so no type offers it.
 */
export const conditionClearedCode = "condition_cleared";

/** The controlled resolution codes for an exception's type, or the generic list for a type outside the catalogue. */
export function resolutionCodesFor(rawType: unknown): readonly string[] {
  const type = resolveExceptionType(rawType);
  return type ? exceptionCatalogue[type].resolutionCodes : genericResolutionCodes;
}
