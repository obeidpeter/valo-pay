import { z } from "zod";

/** Explicit non-administrator lender grants, tied to the inspected membership revision. */
export const staffLenderAccessInputSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  lenderIds: z.array(z.string().trim().min(1).max(100)).max(250).refine(ids => new Set(ids).size === ids.length, "Choose each lender only once."),
  reason: z.string().trim().min(10).max(1000),
}).strict();
/** Validated replacement set of lenders a staff member may access. */
export type StaffLenderAccessInput = z.infer<typeof staffLenderAccessInputSchema>;
