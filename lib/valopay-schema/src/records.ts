import { z } from "zod";
import { activationWorkflows, attemptSources, exceptionSeverities, executionOwners, experimentArms, handBackOwners, mandateFrequencies, mandateOrigins, observationSources } from "./enums";

/** ISO date (YYYY-MM-DD) or a UTC ISO timestamp with millisecond precision or less. */
export const isoDateOrTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/, "must be an ISO date or UTC ISO timestamp").refine((value) => !Number.isNaN(Date.parse(value)), "must be a real date");
export const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").refine((value) => !Number.isNaN(Date.parse(value)), "must be a real date");
export const kobo = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const versionNumber = z.coerce.number().int().min(1);

/**
 * Per-kind data schemas.  Known fields are typed; unknown fields pass through so
 * connectors and imports can attach provider-specific detail beside the record.
 */
export const recordDataSchemas = {
  customers: z.object({
    bankName: z.string().optional(),
    accountMasked: z.string().optional(),
    phoneMasked: z.string().optional(),
    consentProvenance: z.string().min(1),
    payDay: z.number().int().min(1).max(31).optional(),
  }).passthrough(),
  mandates: z.object({
    workflow: z.enum(activationWorkflows),
    frequency: z.enum(mandateFrequencies).optional(),
    activationDeadline: isoDateOrTimestamp.optional(),
    consentEvidence: z.string().min(1),
    consentGaps: z.array(z.string()).optional(),
    consentGiven: z.boolean().optional(),
    policyId: z.string().optional(),
    origin: z.enum(mandateOrigins).optional(),
    reminderCount: z.number().int().min(0).optional(),
    reissuedFrom: z.string().optional(),
    providerReference: z.string().optional(),
  }).passthrough(),
  "due-items": z.object({
    dueDate: isoDateOrTimestamp,
    mandateId: z.string().optional(),
    owner: z.enum(executionOwners),
    outstandingKobo: kobo.optional(),
    overrideReason: z.string().optional(),
    adminOverrideReason: z.string().optional(),
    policyId: z.string().optional(),
    instalmentId: z.string().optional(),
    experimentId: z.string().optional(),
    experimentArm: z.enum(experimentArms).optional(),
    firstFailureAt: isoDateOrTimestamp.optional(),
    amendedAt: isoDateOrTimestamp.optional(),
  }).passthrough(),
  attempts: z.object({
    dueItemId: z.string().min(1),
    number: z.number().int().min(1).optional(),
    source: z.enum(attemptSources),
    failureCode: z.string().optional(),
    occurredAt: isoDateOrTimestamp.optional(),
    providerReference: z.string().optional(),
    noticeId: z.string().optional(),
    simulated: z.boolean().optional(),
  }).passthrough(),
  observations: z.object({
    source: z.enum(observationSources),
    dueItemId: z.string().optional(),
    provider: z.string().optional(),
    eventId: z.string().optional(),
    narration: z.string().optional(),
    batchReference: z.string().optional(),
    feeKobo: kobo.optional(),
    grossAmountKobo: kobo.optional(),
    occurredAt: isoDateOrTimestamp.optional(),
    reversed: z.boolean().optional(),
    virtualAccountCustomerId: z.string().optional(),
  }).passthrough(),
  "settlement-batches": z.object({
    provider: z.string().optional(),
    batchReference: z.string().min(1),
    grossKobo: kobo,
    feeKobo: kobo,
    netKobo: kobo,
    lineObservationIds: z.array(z.string()).optional(),
  }).passthrough(),
  exceptions: z.object({
    type: z.string().min(1),
    severity: z.enum(exceptionSeverities).optional(),
    owner: z.string().optional(),
    dueBy: isoDateOrTimestamp.optional(),
    resolutionCode: z.string().optional(),
    notes: z.string().optional(),
    linkedRecordId: z.string().optional(),
  }).passthrough(),
  policies: z.object({
    version: versionNumber.optional(),
    maxAttempts: z.number().int().optional(),
    spacingHours: z.number().int().optional(),
    firstNoticeHours: z.number().int().optional(),
    retryNoticeHours: z.number().int().optional(),
    partialAllowed: z.boolean().optional(),
    author: z.string().optional(),
    reviewer: z.string().optional(),
    approvedAt: isoDateOrTimestamp.optional(),
    complianceMapping: z.string().optional(),
  }).passthrough(),
  templates: z.object({
    purpose: z.string().optional(),
    text: z.string().min(1),
    version: versionNumber.optional(),
    author: z.string().optional(),
    reviewer: z.string().optional(),
  }).passthrough(),
  experiments: z.object({
    baselineRate: z.number().min(0).max(1),
    holdoutShare: z.number(),
    minPerArm: z.number().int().min(0),
    analysisDate: isoDateOrTimestamp,
    enrolmentClose: isoDateOrTimestamp,
    seed: z.string().min(1),
    policyId: z.string().min(1),
  }).passthrough(),
  cutovers: z.object({
    inventory: z.string().optional(),
    incumbentDisabled: z.boolean().optional(),
    externalAttemptsImported: z.boolean().optional(),
    dualRunComplete: z.boolean().optional(),
    accountableUser: z.string().optional(),
    fallbackOwner: z.enum(handBackOwners).optional(),
    confirmation: z.string().optional(),
  }).passthrough(),
  commercial: z.object({
    monthlyVolume: z.number().int().min(0).optional(),
    averageTicketKobo: kobo.optional(),
    implementationKobo: kobo.optional(),
    licenceKobo: kobo.optional(),
    usageBps: z.number().int().min(0).optional(),
    usageCapKobo: kobo.optional(),
    signed: z.boolean().optional(),
    signedFullPriceTerms: z.boolean().optional(),
    effectiveDate: isoDateOrTimestamp.optional(),
    startCondition: z.string().optional(),
    conversationComplete: z.boolean().optional(),
    designPartner: z.boolean().optional(),
  }).passthrough(),
  reviews: z.object({
    reviewer: z.string().optional(),
    reviewedAt: isoDateOrTimestamp.optional(),
    confirmedJobs: z.union([z.number().int().min(0), z.array(z.string())]).optional(),
    note: z.string().optional(),
  }).passthrough(),
  evidence: z.object({
    gateId: z.string().optional(),
    reference: z.string().optional(),
    notes: z.string().optional(),
  }).passthrough(),
  costs: z.object({ period: z.string().optional() }).passthrough(),
  calendar: z.object({ date: isoDay }).passthrough(),
} as const;

export type RecordDataSchemas = typeof recordDataSchemas;
export type DataOf<K extends keyof RecordDataSchemas> = z.infer<RecordDataSchemas[K]>;

/** Human-readable zod failure for API error bodies and import row reports. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "data"}: ${issue.message}`).join("; ");
}

/** Fields the CSV importer coerces to numbers and booleans, derived from the schemas above. */
export const importNumericFields = new Set(["amountKobo", "maxAttempts", "spacingHours", "firstNoticeHours", "retryNoticeHours", "number", "outstandingKobo", "monthlyVolume", "grossKobo", "feeKobo", "netKobo", "grossAmountKobo", "baselineRate", "holdoutShare", "minPerArm", "reminderCount", "payDay", "version"]);
export const importBooleanFields = new Set(["simulated", "partialAllowed", "reversed", "consentGiven", "signed", "signedFullPriceTerms", "designPartner", "incumbentDisabled", "externalAttemptsImported", "dualRunComplete"]);
