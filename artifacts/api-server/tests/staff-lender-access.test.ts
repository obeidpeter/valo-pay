import assert from "node:assert/strict";
import { validateLenderAccessChange } from "../src/lib/staff-lender-access";

const now = "2026-09-22T10:00:00.000Z", member = { userId: "worker", role: "Finance", status: "active", updatedAt: now, expiresAt: "2026-12-01T10:00:00.000Z" };
const input = { expectedUpdatedAt: now, lenderIds: ["lender-a"], reason: "Assigned to the Cedar Finance pilot team." };
assert.deepEqual(validateLenderAccessChange(input, member, "admin", ["lender-a", "lender-b"], now).lenderIds, ["lender-a"]);
assert.deepEqual(validateLenderAccessChange({ ...input, lenderIds: [] }, member, "admin", ["lender-a"], now).lenderIds, [], "An administrator may remove all explicit lender access.");
assert.throws(() => validateLenderAccessChange(input, member, "worker", ["lender-a"], now), /another administrator/);
assert.throws(() => validateLenderAccessChange(input, { ...member, role: "Admin" }, "admin", ["lender-a"], now), /Administrators manage all/);
assert.throws(() => validateLenderAccessChange(input, { ...member, status: "revoked" }, "admin", ["lender-a"], now), /active, unexpired/);
assert.throws(() => validateLenderAccessChange(input, { ...member, expiresAt: now }, "admin", ["lender-a"], now), /active, unexpired/);
assert.throws(() => validateLenderAccessChange({ ...input, expectedUpdatedAt: "2026-09-21T10:00:00.000Z" }, member, "admin", ["lender-a"], now), /membership changed/);
assert.throws(() => validateLenderAccessChange({ ...input, lenderIds: ["foreign-lender"] }, member, "admin", ["lender-a"], now), /not available/);
assert.throws(() => validateLenderAccessChange({ ...input, lenderIds: ["lender-a", "lender-a"] }, member, "admin", ["lender-a"], now), /once/);
assert.throws(() => validateLenderAccessChange({ ...input, arbitraryAuthority: true } as any, member, "admin", ["lender-a"], now));
console.log("Staff lender access: explicit grants, self-escalation, tenant scope, stale changes, expiry and revocation policy passed.");
