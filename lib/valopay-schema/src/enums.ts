/** Controlled vocabularies shared by the API validator, the engine and the console. */
export const roles = ["Admin", "Operations", "Finance", "Compliance reviewer", "Read-only"] as const;
export type Role = (typeof roles)[number];

/**
 * Execution owner of a due item (SCH-08).  The TRD spells the platform owner
 * "valo"; the platform stores "valopay" and accepts either on input.
 */
export const executionOwners = ["valopay", "lms", "merchant_manual", "provider_auto"] as const;
export type ExecutionOwner = (typeof executionOwners)[number];
export const PLATFORM_OWNER: ExecutionOwner = "valopay";
export const handBackOwners = ["lms", "merchant_manual", "provider_auto"] as const;
export function normaliseOwner(raw: unknown): ExecutionOwner | undefined {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "valo" || value === "valopay" || value === "valo_pay") return "valopay";
  return (executionOwners as readonly string[]).includes(value) ? (value as ExecutionOwner) : undefined;
}

/** MAN-15 activation workflow registry types. */
export const activationWorkflows = ["transfer_to_activate", "hosted_consent"] as const;
export type ActivationWorkflow = (typeof activationWorkflows)[number];

export const mandateFrequencies = ["weekly", "fortnightly", "monthly", "quarterly", "custom"] as const;
export const mandateOrigins = ["created", "imported", "reissued"] as const;

/** ING-01 observation sources. */
export const observationSources = ["webhook", "settlement", "statement", "transfer", "card", "manual"] as const;
export type ObservationSource = (typeof observationSources)[number];

export const paymentChannels = ["direct_debit", "transfer", "card", "statement", "manual", "webhook", "settlement"] as const;

/** DEB-02 authorisation modes. */
export const authorisationModes = ["batch", "standing"] as const;
export type AuthorisationMode = (typeof authorisationModes)[number];

/** DEB-10 merchant modes. */
export const merchantModes = ["observation", "instruction"] as const;

export const experimentArms = ["engine", "holdout"] as const;
export type ExperimentArm = (typeof experimentArms)[number];

/** TRD 6.3 decision outcomes recorded on every retry decision (RET-03). */
export const retryDecisionKinds = ["stop", "blocked", "give_up", "not_eligible", "holdout", "observation_only", "defer", "would_schedule"] as const;
export type RetryDecisionKind = (typeof retryDecisionKinds)[number];

export const exceptionSeverities = ["low", "medium", "high"] as const;
export type ExceptionSeverity = (typeof exceptionSeverities)[number];

export const attemptSources = ["valo", "external"] as const;

/**
 * TRD 4.2: a Payment carries four independent status dimensions.  These are
 * the only spellings the platform writes; readers normalise legacy values.
 */
export const collectionStatuses = ["received", "succeeded", "failed", "unknown"] as const;
export const settlementStatuses = ["unsettled", "settled", "variance"] as const;
export const reversalStatuses = ["none", "reversed"] as const;
export const refundStatuses = ["none", "requested", "refunded"] as const;

export function normaliseReversalStatus(raw: unknown): (typeof reversalStatuses)[number] {
  return raw === "reversed" ? "reversed" : "none";
}
export function normaliseRefundStatus(raw: unknown): (typeof refundStatuses)[number] {
  if (raw === "refunded" || raw === "recorded_externally") return "refunded";
  if (raw === "requested") return "requested";
  return "none";
}

export const notificationPurposes = ["activation_reminder", "pre_debit", "failed_debit", "confirmation", "final_attempt", "policy_change"] as const;

/** NFR-OBS-02 alert severities, most urgent first. */
export const alertSeverities = ["critical", "high", "medium", "info"] as const;
export type AlertSeverity = (typeof alertSeverities)[number];
export const notificationChannels = ["sms", "whatsapp", "email"] as const;

/** REC-01: whether a daily close was started by the scheduler at the configured time or by a person. */
export const closeTriggers = ["scheduled", "manual"] as const;
export type CloseTrigger = (typeof closeTriggers)[number];

/** BIL-07: why a billed collection carries a credit or debit line on a later invoice. */
export const adjustmentReasons = ["reversal", "refund", "confirmed_duplicate", "wrong_allocation", "re_allocation"] as const;
export type AdjustmentReason = (typeof adjustmentReasons)[number];
