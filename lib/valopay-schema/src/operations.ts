import { z } from "zod";

/** An operations-journal entry's state: waiting for confirmation, saved, or closed without saving. */
export const operationStatuses = ["pending", "completed", "cancelled"] as const;
/** One journal entry: what was asked, by whom, in which role, and whether the service confirmed it; a completed entry names the record it produced. */
export const operationViewSchema = z.object({
  id: z.string(), label: z.string(), actor: z.string(), role: z.string(), status: z.enum(operationStatuses),
  createdAt: z.string(), updatedAt: z.string(), message: z.string(), recordId: z.string().nullable(), recordKind: z.string().nullable(),
}).strict();
/** One journal entry as the Operations page lists it. */
export type OperationView = z.infer<typeof operationViewSchema>;
/** The caller's journal for one lender, newest first, 25 rows a page. */
export const operationListSchema = z.object({ items: z.array(operationViewSchema).max(25), total: z.number().int().min(0), offset: z.number().int().min(0) }).strict();
/** A recovered or repeated journal entry's answer: the original route's own answer, whatever its shape. */
export const operationReplaySchema = z.record(z.unknown());
