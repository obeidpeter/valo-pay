import { z } from "zod";

const id = z.string().trim().min(1).max(100);
const note = z.string().trim().min(10).max(3000);
/** Strict preparation request for one immutable close and named independent reviewer. */
export const prepareCloseReviewSchema = z.object({
  closeId: id,
  expectedUpdatedAt: z.string().datetime(),
  reviewer: z.string().trim().min(1).max(200),
  preparationNote: note,
  discrepancyResponses: z.array(z.object({ issueId: id, explanation: note }).strict()).max(500),
  unresolvedAcceptance: z.string().trim().max(3000).default(""),
}).strict();
/** A Finance decision always names the version the reviewer inspected. */
export const decideCloseReviewSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  action: z.enum(["approve", "return"]),
  note,
  sourceExceptions: z.array(z.object({ issueId: z.string().min(1).max(200), reason: note, evidence: z.string().trim().min(5).max(1000) }).strict()).max(500).default([]),
}).strict();
/** Validated close preparation fields. */
export type PrepareCloseReviewInput = z.infer<typeof prepareCloseReviewSchema>;
/** Validated approval or request-for-changes fields. */
export type DecideCloseReviewInput = z.input<typeof decideCloseReviewSchema>;

/** Progress states distinguish evidence, missing work and blocked decisions. */
export const pilotProgressStates = ["not_started", "in_progress", "awaiting_review", "completed", "blocked"] as const;
/** A status supported by the evidence-led pilot journey. */
export type PilotProgressState = typeof pilotProgressStates[number];
/** One pilot stage with the evidence and remaining requirements behind it. */
export interface PilotProgressStep {
  id: string;
  name: string;
  href: string;
  state: PilotProgressState;
  evidence: string[];
  missing: string[];
}
