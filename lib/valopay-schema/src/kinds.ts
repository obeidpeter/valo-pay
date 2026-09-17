/**
 * Record kinds, their status vocabularies and the state machines the TRD
 * (section 4.2) allows.  This is the single source for the API validator and
 * the console; neither may hard-code a status string of its own.
 */
export const recordKinds = [
  "customers", "mandates", "due-items", "attempts", "observations", "payments", "allocations",
  "settlement-batches", "exceptions", "policies", "templates", "notifications", "cutovers", "audit",
  "closes", "exports", "commercial", "reviews", "evidence", "experiments", "costs", "calendar",
  "integrations", "members", "retry-decisions", "invoices",
] as const;
export type RecordKind = (typeof recordKinds)[number];

/** Kinds a merchant user may create or edit through the generic record API. */
export const editableKinds = [
  "customers", "mandates", "due-items", "attempts", "observations", "exceptions", "policies", "templates",
  "cutovers", "commercial", "reviews", "evidence", "experiments", "costs", "calendar", "settlement-batches",
] as const;
export type EditableKind = (typeof editableKinds)[number];

/** Kinds accepted by the synthetic CSV importer. */
export const importKinds = ["customers", "mandates", "due-items", "attempts", "observations"] as const;

export const recordStatuses = {
  customers: ["active", "inactive"],
  mandates: ["draft", "submitted", "pending_activation", "active", "suspended", "expired", "cancelled", "failed"],
  "due-items": ["scheduled", "in_collection", "partially_paid", "paid", "unpaid_final", "in_dispute", "cancelled", "closed"],
  attempts: ["scheduled", "sent", "succeeded", "failed", "unknown", "cancelled", "reversed"],
  observations: ["unresolved", "resolved"],
  "settlement-batches": ["pending", "reconciled", "variance"],
  payments: ["unallocated", "proposed", "allocated", "partial", "overpaid", "possible_duplicate"],
  allocations: ["proposed", "confirmed", "superseded"],
  exceptions: ["open", "assigned", "in_progress", "resolved", "closed"],
  policies: ["draft", "submitted", "approved", "rejected"],
  templates: ["draft", "submitted", "approved", "rejected"],
  experiments: ["draft", "preregistered", "closed"],
  cutovers: ["draft", "ready", "handed_back"],
  evidence: ["pending", "recorded"],
  notifications: ["simulated", "blocked", "accepted", "delivered", "failed"],
  "retry-decisions": ["recorded"],
  closes: ["completed"],
  exports: ["ready"],
  invoices: ["issued"],
} as const satisfies Partial<Record<RecordKind, readonly string[]>>;
export type StatusOf<K extends keyof typeof recordStatuses> = (typeof recordStatuses)[K][number];
export type MandateStatus = StatusOf<"mandates">;
export type DueItemStatus = StatusOf<"due-items">;
export type ExceptionStatus = StatusOf<"exceptions">;

/** Status a record starts in when the caller does not supply one. */
export const defaultStatus: Partial<Record<RecordKind, string>> = {
  customers: "active", mandates: "pending_activation", "due-items": "scheduled", attempts: "failed",
  observations: "unresolved", exceptions: "open", evidence: "pending", calendar: "active", commercial: "discovery",
  reviews: "recorded", costs: "recorded", cutovers: "draft", experiments: "draft", policies: "draft",
  templates: "draft", "settlement-batches": "pending",
};

/** TRD 4.2 mandate state machine.  Terminal states have no exits. */
export const mandateTransitions: Record<MandateStatus, readonly MandateStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["pending_activation", "failed"],
  pending_activation: ["active", "expired", "cancelled"],
  active: ["cancelled", "suspended", "expired"],
  suspended: ["active", "cancelled"],
  expired: [],
  cancelled: [],
  failed: [],
};

/**
 * TRD 4.2 exception machine.  "resolved" is reached only through the
 * resolve action with a controlled code (EXC-03); "closed" follows resolution.
 */
export const exceptionTransitions: Record<ExceptionStatus, readonly ExceptionStatus[]> = {
  open: ["assigned", "in_progress"],
  assigned: ["in_progress", "open"],
  in_progress: ["assigned"],
  resolved: ["closed"],
  closed: [],
};

/** Statuses per kind that only a domain action may set; a generic create or update is refused. */
export const actionOnlyStatuses: Partial<Record<RecordKind, readonly string[]>> = {
  "due-items": ["in_collection", "partially_paid", "paid", "unpaid_final", "in_dispute", "closed"],
  exceptions: ["resolved", "closed"],
  policies: ["submitted", "approved", "rejected"],
  templates: ["submitted", "approved", "rejected"],
  experiments: ["preregistered", "closed"],
  cutovers: ["handed_back"],
  "settlement-batches": ["reconciled", "variance"],
};
export const isActionOnlyStatus = (kind: string, status: string): boolean => (actionOnlyStatuses[kind as RecordKind] ?? []).includes(status);

export const openExceptionStatuses = ["open", "assigned", "in_progress"] as const;
export const isOpenException = (status: string): boolean => (openExceptionStatuses as readonly string[]).includes(status);
