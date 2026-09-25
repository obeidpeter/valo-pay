import { z } from "zod";

/** An operations-journal entry's state: waiting for confirmation, saved, or closed without saving. */
export const operationStatuses = ["pending", "completed", "cancelled"] as const;
/**
 * What a journal entry asked, safe to show: the action or route in plain words, the record it names (its kind and ID)
 * and at most three short fields the request named (an action, a decision, a status, a kind, a format). Never a name,
 * reference, reason, amount or file, and never the body.
 */
export const operationSummarySchema = z.object({
  action: z.string(), targetKind: z.string().nullable(), targetId: z.string().nullable(),
  details: z.array(z.object({ name: z.string(), value: z.string() }).strict()).max(3),
}).strict();
/** An entry's summary. */
export type OperationSummary = z.infer<typeof operationSummarySchema>;
/** One journal entry: what was asked, by whom, in which role, and whether the service confirmed it; a completed entry
 * names the record it produced. `summary` is null when the request is sealed by payload encryption or its payload
 * expired under retention. */
export const operationViewSchema = z.object({
  id: z.string(), label: z.string(), actor: z.string(), role: z.string(), status: z.enum(operationStatuses),
  createdAt: z.string(), updatedAt: z.string(), message: z.string(), recordId: z.string().nullable(), recordKind: z.string().nullable(),
  summary: operationSummarySchema.nullable(),
}).strict();
/** One journal entry as the Operations page lists it. */
export type OperationView = z.infer<typeof operationViewSchema>;
/** The caller's journal for one lender, newest first, 25 rows a page. */
export const operationListSchema = z.object({ items: z.array(operationViewSchema).max(25), total: z.number().int().min(0), offset: z.number().int().min(0) }).strict();
/** How many of the caller's requests in one lender wait for confirmation. */
export const pendingOperationsSchema = z.object({ pending: z.number().int().min(0) }).strict();
/** A recovered or repeated journal entry's answer: the original route's own answer, whatever its shape. */
export const operationReplaySchema = z.record(z.unknown());
