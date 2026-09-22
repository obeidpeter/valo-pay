import { z } from 'zod';
const id = z.string().min(1).max(200), hash = z.string().regex(/^[a-f0-9]{64}$/), at = z.string().datetime();
/** Source artifact categories that can be retained or deleted; excludes financial records. */
export const lifecycleKindSchema = z.enum(['raw_csv', 'journal_payload', 'export_file']);
/** Explicit minimum retention ages, disabled by default, with audit permanently retained. */
export const retentionPolicySchema = z.object({ rawCsvDays: z.number().int().min(1).max(3650).nullable(), journalPayloadDays: z.number().int().min(1).max(3650).nullable(), exportFileDays: z.number().int().min(1).max(3650).nullable(), auditTrail: z.literal('retain') }).strict();
/** Configured retention ages for eligible source artifacts. */
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
/** Version-protected administrator policy decision and accountable reason. */
export const retentionPolicyInputSchema = z.object({ policy: retentionPolicySchema, expectedRevision: hash, reason: z.string().trim().min(10).max(500) }).strict();
/** Version-protected hold or release for one exact artifact. */
export const retentionHoldInputSchema = z.object({ kind: lifecycleKindSchema, sourceId: id, held: z.boolean(), expectedHoldRevision: hash, reason: z.string().trim().min(10).max(500) }).strict();
/** Public-safe artifact identity, terminal retention start and exact version digest. */
export const lifecycleCandidateSchema = z.object({ kind: lifecycleKindSchema, merchantId: id, sourceId: id, version: id, createdAt: at, label: z.string().min(1).max(200), digest: hash, status: z.enum(['committed', 'completed', 'cancelled', 'ready', 'failed']) }).strict();
/** One exact source artifact eligible for retention evaluation. */
export type LifecycleCandidate = z.infer<typeof lifecycleCandidateSchema>;
/** Terminal request payload or export artifact supplied by the scoped storage service. */
export type LifecycleExternalCandidate = LifecycleCandidate & { kind: 'journal_payload' | 'export_file' };
/** Policy revision to use when saving a bounded deletion preview. */
export const lifecyclePreviewInputSchema = z.object({ expectedPolicyRevision: hash }).strict();
/** Fresh approval of one exact unexpired deletion preview. */
export const lifecycleApproveInputSchema = z.object({ expectedUpdatedAt: at, previewDigest: hash, reason: z.string().trim().min(10).max(500) }).strict();
/** Immutable preview identity for executing or resuming an approved run. */
export const lifecycleExecuteInputSchema = z.object({ previewDigest: hash }).strict();
/** Verified executor result; blocked and failed candidates remain resumable. */
export const lifecycleReceiptStatusSchema = z.enum(['deleted', 'already_absent', 'blocked', 'failed']);
/** Durable deletion receipt with source identity and accountable actor. */
export const lifecycleReceiptViewSchema = z.object({ id, kind: lifecycleKindSchema, sourceId: id, status: lifecycleReceiptStatusSchema, at, detail: z.string(), actor: id }).strict();
/** Exact reviewed manifest and bounded execution progress for one retention run. */
export const lifecycleRunViewSchema = z.object({ id, merchantId: id, status: z.enum(['preview', 'approved', 'running', 'completed', 'attention']), updatedAt: at, createdAt: at, expiresAt: at, previewDigest: hash, policyRevision: hash, candidates: z.array(lifecycleCandidateSchema).max(100), candidateCount: z.number().int().nonnegative(), moreEligible: z.number().int().nonnegative(), approvedBy: z.string().nullable(), approvedAt: at.nullable(), receipts: z.array(lifecycleReceiptViewSchema).max(100), successful: z.number().int().nonnegative(), remaining: z.number().int().nonnegative(), auditRetained: z.literal(true), financialRecordsRetained: z.literal(true), syntheticOnly: z.literal(true) }).strict();
/** Validated retention preview, approval and receipt read model. */
export type LifecycleRunView = z.infer<typeof lifecycleRunViewSchema>;
/** Administrator-only policy, holds, bounded inventory and saved retention runs. */
export const lifecycleViewSchema = z.object({ merchantId: id, lenderName: z.string(), actor: id, asOf: at, policy: retentionPolicySchema, policyRevision: hash, holdRevision: hash, eligibleCount: z.number().int().nonnegative(), targets: z.array(lifecycleCandidateSchema.extend({ held: z.boolean() }).strict()).max(100), targetTotal: z.number().int().nonnegative(), targetOffset: z.number().int().nonnegative(), holds: z.array(z.object({ kind: lifecycleKindSchema, sourceId: id, reason: z.string(), actor: id, at }).strict()).max(100), holdTotal: z.number().int().nonnegative(), runs: z.array(lifecycleRunViewSchema).max(10), auditRetained: z.literal(true), financialRecordsRetained: z.literal(true), syntheticOnly: z.literal(true) }).strict();
/** Validated retention control response for one lender. */
export type LifecycleView = z.infer<typeof lifecycleViewSchema>;
