import { staffLenderAccessInputSchema, type StaffLenderAccessInput } from "@workspace/valopay-schema";

function refuse(message: string, status: number): never { throw Object.assign(new Error(message), { status }); }
/** Pure policy shared by the transactional repository and focused tests. */
export function validateLenderAccessChange(input: StaffLenderAccessInput, target: { userId: string; role: string; status: string; updatedAt: string; expiresAt: string }, actorUserId: string, availableLenderIds: string[], now: string) {
  const parsed = staffLenderAccessInputSchema.parse(input);
  if (target.userId === actorUserId) refuse("Ask another administrator to change your lender access.", 403);
  if (target.role === "Admin") refuse("Administrators manage all lenders in this workspace. Assign a non-administrator role before restricting lender access.", 409);
  if (target.status !== "active" || Date.parse(target.expiresAt) <= Date.parse(now)) refuse("Only an active, unexpired member can receive lender access.", 409);
  if (target.updatedAt !== parsed.expectedUpdatedAt) refuse("This membership changed. Refresh the team and review its lender access again.", 409);
  if (parsed.lenderIds.some(id => !availableLenderIds.includes(id))) refuse("One or more lenders are not available in this workspace.", 404);
  return parsed;
}
