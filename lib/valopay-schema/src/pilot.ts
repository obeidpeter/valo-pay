import { z } from "zod";
import { importKinds } from "./kinds";
import { businessDateSchema } from "./source-quality";

/** HTTP statuses the service treats as a definitive refusal: the same request would be refused again, so its operations-journal entry is cancelled and its key cannot run again. */
export const definitiveRefusalStatuses = [400, 403, 404, 409, 410, 413, 415, 422] as const;
/** Roles granted by a provisioned pilot administrator, never a browser persona. */
export const pilotRoleSchema = z.enum([
  "Admin",
  "Operations",
  "Finance",
  "Compliance reviewer",
  "Read-only",
]);
/** Saved synthetic source batch, including the current revision for corrections. */
export const batchInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(importKinds),
    source: z.string().trim().min(1).max(100),
    sourceBatchId: z.string().trim().min(1).max(120),
    businessDate: businessDateSchema.optional(),
    sourceExpectationId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    csv: z.string().min(1).max(1_500_000),
    mapping: z.record(z.string().max(100)).default({}),
    amountUnit: z.enum(["naira", "kobo"]),
    identityColumn: z.string().trim().min(1).max(100),
    syntheticOnly: z.literal(true),
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .strict();
/** Validated saved-batch input. */
export type BatchInput = z.infer<typeof batchInputSchema>;
/** Named case coordination, with a reviewed version and linked lender evidence. */
export const caseInputSchema = z
  .object({
    action: z.enum(["claim", "handover", "update"]),
    expectedUpdatedAt: z.string().datetime(),
    assignee: z.string().max(256).optional(),
    note: z.string().trim().min(3).max(2000),
    nextAction: z.string().trim().min(3).max(240),
    nextActionAt: z.string().datetime(),
    evidenceIds: z.array(z.string().min(1).max(100)).max(20).default([]),
  })
  .strict();
/** Validated case handover input. */
export type CaseInput = z.infer<typeof caseInputSchema>;
/** Empty synthetic lender setup; financial gates stay closed. */
export const lenderInputSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    segment: z.enum([
      "Consumer lending",
      "Cooperative",
      "Asset finance",
      "Business finance",
    ]),
  })
  .strict();
/** A manually shared, email-bound invitation for an existing organisation. */
export const invitationInputSchema = z
  .object({
    email: z
      .string()
      .email()
      .max(254)
      .transform((v) => v.trim().toLowerCase()),
    role: pilotRoleSchema,
  })
  .strict();
/** Versioned role or access change, with an accountable reason. */
export const membershipInputSchema = z
  .object({
    role: pilotRoleSchema,
    status: z.enum(["active", "suspended", "revoked"]),
    expectedUpdatedAt: z.string().datetime(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
