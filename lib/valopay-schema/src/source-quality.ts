import { z } from "zod";
import { importKinds } from "./kinds";

const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
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
