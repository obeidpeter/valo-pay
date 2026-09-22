import { z } from "zod";
import { importKinds } from "./kinds";

const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A real calendar date, interpreted as the lender's WAT business date. */
export const businessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; }, "Use a valid business date.");
/** An expected original source file, independently declared for one business date. */
export const expectedSourceFileSchema = z.object({ source: z.string().trim().min(1).max(100), sourceBatchId: z.string().trim().min(1).max(120), kind: z.enum(importKinds), expectedRows: safeCount.max(500), expectedAmountKobo: safeCount }).strict();
/** Each revision preserves its predecessor; missing expectations never mean complete. */
export const sourceManifestInputSchema = z.object({ businessDate: businessDateSchema, files: z.array(expectedSourceFileSchema).max(100), noFilesExpected: z.boolean(), reason: z.string().trim().min(10).max(3000), evidence: z.string().trim().min(5).max(1000), previousManifestId: z.string().min(1).max(100).optional(), expectedUpdatedAt: z.string().datetime().optional(), syntheticOnly: z.literal(true) }).strict().superRefine((value, context) => { if (value.noFilesExpected === Boolean(value.files.length)) context.addIssue({ code: z.ZodIssueCode.custom, message: "List the expected files, or explicitly declare that no files are expected." }); });
/** Validated date-specific source declaration. */
export type SourceManifestInput = z.infer<typeof sourceManifestInputSchema>;
/** Date-specific completeness evidence exposed to operators and frozen in a close. */
export const sourceCompletenessSchema = z.object({
  businessDate: businessDateSchema, manifest: z.object({ id: z.string(), updatedAt: z.string().datetime(), data: z.record(z.unknown()) }).nullable(),
  files: z.array(expectedSourceFileSchema.extend({ id: z.string(), batchId: z.string().nullable(), batchStatus: z.string(), businessDate: businessDateSchema.nullable(), receivedRows: safeCount.nullable(), receivedAmountKobo: safeCount.nullable(), status: z.enum(["complete", "incomplete"]), problems: z.array(z.string()) })),
  activeProfiles: z.array(z.object({ id: z.string(), source: z.string(), kind: z.string() })),
  undeclared: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), source: z.string(), sourceBatchId: z.string(), kind: z.string() })),
  status: z.enum(["complete", "incomplete"]), issues: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string() })), basisDigest: z.string().regex(/^[a-f0-9]{64}$/), expectedFiles: safeCount, completeFiles: safeCount,
});
/** Reusable synthetic import contract; cadence uses elapsed UTC hours, not browser time. */
export const sourceProfileInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  source: z.string().trim().min(1).max(100),
  kind: z.enum(importKinds),
  mapping: z.record(z.string().max(100)).default({}),
  identityColumn: z.string().trim().min(1).max(100),
  amountUnit: z.enum(["naira", "kobo"]),
  firstExpectedAt: z.string().datetime(),
  cadenceHours: z.number().int().min(1).max(8760),
  graceMinutes: z.number().int().min(0).max(10080),
  expectedRows: safeCount.max(500).nullable().default(null),
  expectedAmountKobo: safeCount.nullable().default(null),
  status: z.enum(["active", "paused"]).default("active"),
  syntheticOnly: z.literal(true),
  expectedUpdatedAt: z.string().datetime().optional(),
}).strict();
/** Validated reusable mapping and delivery expectation. */
export type SourceProfileInput = z.infer<typeof sourceProfileInputSchema>;
/** Quality totals preserve the distinction between source rows and newly imported rows. */
export const sourceBatchQualitySchema = z.object({
  profileId: z.string().nullable(), profileVersion: z.string().nullable(),
  sourceRows: safeCount, sourceAmountKobo: safeCount.nullable(),
  importedRows: safeCount, importedAmountKobo: safeCount.nullable(),
  duplicateRows: safeCount, conflictRows: safeCount, invalidRows: safeCount,
  status: z.enum(["checked", "needs_review", "unavailable"]),
  issues: z.array(z.string()),
});
/** Checked, safe-integer source and ingestion totals. */
export type SourceBatchQuality = z.infer<typeof sourceBatchQualitySchema>;
/** Fixed fixtures exercise ordering and conflicts without accepting caller-crafted provider data. */
export const paystackFixtureInputSchema = z.object({
  scenario: z.enum(["payment", "duplicate", "amount_mismatch", "out_of_order", "tampered"]),
  syntheticOnly: z.literal(true),
}).strict();
/** Explicit replay never overwrites evidence or bypasses quarantine. */
export const providerReplayInputSchema = z.object({
  expectedUpdatedAt: z.string().datetime(), reason: z.string().trim().min(3).max(500),
}).strict();
