import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") { console.log("Opt in on a disposable PostgreSQL database to test staff lender access."); process.exit(0); }
const { pool } = await import("@workspace/db"), store = await import("../src/lib/valopay-store"), { default: router } = await import("../src/routes/index"), { errorHandler } = await import("../src/lib/error-handler");
const saved = { VALOPAY_STAFF_ACCESS: process.env.VALOPAY_STAFF_ACCESS, VALOPAY_STAFF_ISSUER: process.env.VALOPAY_STAFF_ISSUER, VALOPAY_STAFF_ORIGINS: process.env.VALOPAY_STAFF_ORIGINS };
Object.assign(process.env, { VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://identity.example", VALOPAY_STAFF_ORIGINS: "https://pilot.example" });
const identities = new Map<string, any>(), app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).auth = Object.assign(() => identities.get(String(req.header("X-Test-Identity"))) || { userId: null }, { [Symbol.for("@clerk/express.auth")]: true }); (req as any).log = { info() {}, error() {}, warn() {} }; next(); });
app.use("/api", router); app.use(errorHandler);
const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`, owned: string[] = [];
async function call(path: string, who = "admin", method = "GET", body?: any, key = randomUUID()) { const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", "X-Test-Identity": who, "Idempotency-Key": key }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, data: await response.json() }; }
function ok(result: { status: number; data: any }) { assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; }
const requestFor = (id: string) => ({ headers: {}, auth: Object.assign(() => identities.get(id), { [Symbol.for("@clerk/express.auth")]: true }) }) as any;
const responseStub = { cookie() {} } as any;
try {
  for (const name of ["003_pilot_workflow.sql", "004_staff_lender_access.sql"]) { const sql = await readFile(new URL(`../../../lib/db/migrations/${name}`, import.meta.url), "utf8"); await pool.query(sql); await pool.query(sql); }
  const org = `org_${randomUUID().replaceAll("-", "")}`, admin = `user_${randomUUID().replaceAll("-", "")}`, finance = `user_${randomUUID().replaceAll("-", "")}`;
  const auth = (userId: string) => ({ userId, orgId: org, sessionId: `sess_${userId}`, tokenType: "session_token", sessionStatus: "active", factorVerificationAge: [0, 0], sessionClaims: { sub: userId, sid: `sess_${userId}`, iss: "https://identity.example", azp: "https://pilot.example", iat: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 3600 } });
  identities.set("admin", auth(admin)); identities.set("finance", auth(finance)); identities.set("old-mfa", { ...auth(admin), factorVerificationAge: [11, 11] });
  const workspace = await store.provisionStaffWorkspace(org, admin, "Lender access rehearsal"); owned.push(workspace.workspaceId);
  const a = ok(await call("/v1/pilot/lenders", "admin", "POST", { name: "Assigned lender", segment: "Consumer lending" })), b = ok(await call("/v1/pilot/lenders", "admin", "POST", { name: "Other lender", segment: "Consumer lending" }));
  const memberId = randomUUID(); await pool.query("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,'Synthetic Finance','Finance',now()+interval '30 days')", [memberId, workspace.workspaceId, finance]);
  assert.equal(ok(await call("/v1/workspace", "finance")).merchants.length, 0);
  assert.equal((await call(`/v1/records/customers?merchantId=${a.id}`, "finance")).status, 404);
  const team = ok(await call("/v1/team")), member = team.members.find((row: any) => row.id === memberId), adminMember = team.members.find((row: any) => row.actor === `Clerk:${admin}`);
  const grant = { expectedUpdatedAt: member.updatedAt, lenderIds: [a.id], reason: "Finance is assigned to the first pilot lender." };
  assert.equal((await call(`/v1/team/members/${memberId}/lenders`, "old-mfa", "PATCH", grant)).status, 403);
  assert.equal((await call(`/v1/team/members/${memberId}/lenders`, "finance", "PATCH", grant)).status, 403);
  assert.equal((await call(`/v1/team/members/${adminMember.id}/lenders`, "admin", "PATCH", { ...grant, expectedUpdatedAt: adminMember.updatedAt })).status, 403);
  const allowed = ok(await call(`/v1/team/members/${memberId}/lenders`, "admin", "PATCH", grant));
  assert.deepEqual(ok(await call("/v1/workspace", "finance")).merchants.map((m: any) => m.id), [a.id]);
  ok(await call(`/v1/records/customers?merchantId=${a.id}`, "finance"));
  assert.equal((await call(`/v1/records/customers?merchantId=${b.id}`, "finance")).status, 404);
  assert.equal((await call(`/v1/team/members/${memberId}/lenders`, "admin", "PATCH", grant)).status, 409);
  assert.equal((await call(`/v1/team/members/${memberId}/lenders`, "admin", "PATCH", { ...grant, expectedUpdatedAt: allowed.updatedAt, lenderIds: ["outside-this-workspace"] })).status, 404);
  assert.equal(ok(await call(`/v1/pilot/close-reviews?merchantId=${a.id}`)).reviewers.length, 1);
  assert.equal(ok(await call(`/v1/pilot/close-reviews?merchantId=${b.id}`)).reviewers.length, 0, "Finance cannot be assigned to a close for an unpermitted lender.");
  ok(await call(`/v1/actions?merchantId=${a.id}`, "admin", "POST", { action: "daily_close" }));
  const savedItem = ok(await call(`/v1/pilot/close-reviews?merchantId=${a.id}`)).closes[0], savedClose = savedItem.close;
  const review = ok(await call(`/v1/pilot/close-reviews/prepare?merchantId=${a.id}`, "admin", "POST", { closeId: savedClose.id, expectedUpdatedAt: savedClose.updatedAt, reviewer: `Clerk:${finance}`, preparationNote: "Verified the synthetic zero-activity close and its source scope.", discrepancyResponses: savedItem.issues.map((issue:any)=>({issueId:issue.id,explanation:"This synthetic access rehearsal has no external source deliveries."})), unresolvedAcceptance: "Finance will record the limited scope of this synthetic access rehearsal." }));
  const sourceExceptions = savedClose.data.reviewBasis.sourceCompleteness.issues.map((issue:any)=>({issueId:issue.id,reason:"The synthetic zero-activity access rehearsal has no external source deliveries.",evidence:"Access rehearsal scope TEST-1."}));
  const decisions = await Promise.all(["First independent check.", "Second concurrent check."].map(note => call(`/v1/pilot/close-reviews/${review.id}/decision?merchantId=${a.id}`, "finance", "POST", { action: "approve", expectedUpdatedAt: review.updatedAt, note, sourceExceptions })));
  assert.deepEqual(decisions.map(r => r.status).sort(), [200, 409], "The lender lock permits exactly one independent decision.");
  assert.equal(ok(await call(`/v1/pilot/progress?merchantId=${a.id}`, "finance")).steps.find((step: any) => step.id === "close").state, "completed");
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), entry = new Promise<void>(resolve => { entered = resolve; });
  const work = store.inWorkspace(requestFor("finance"), responseStub, async ctx => { await store.loadState(ctx, a.id); entered(); await hold; });
  await entry;
  let finished = false;
  const revoke = call(`/v1/team/members/${memberId}/lenders`, "admin", "PATCH", { expectedUpdatedAt: allowed.updatedAt, lenderIds: [], reason: "The pilot work is reassigned to another team." }).then(result => { finished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(finished, false, "Grant revocation must wait for in-flight authorised work.");
  release(); await work; ok(await revoke);
  assert.equal((await call(`/v1/records/customers?merchantId=${a.id}`, "finance")).status, 404, "An existing session cannot read after its lender grant is removed.");
  assert.equal((await call(`/v1/pilot/close-reviews?merchantId=${a.id}`, "finance")).status, 404);
  console.log("Staff lender API/PostgreSQL checks passed: default denial, explicit grants, MFA, lender-filtered reviewers, independent concurrent close approval and synchronised access removal.");
} finally {
  server.close(); await once(server, "close");
  for (const id of owned) { await pool.query("DELETE FROM valopay_staff_events WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_staff_invitations WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_staff_memberships WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_teams WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_idempotency WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [id]); await pool.query("DELETE FROM valopay_records WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)", [id]); await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [id]); await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [id]); }
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await pool.end();
}
