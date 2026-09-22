import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  console.log(
    "Opt in on a disposable database to run the pilot workflow integration suite.",
  );
  process.exit(0);
}
const { pool } = await import("@workspace/db");
const { default: router } = await import("../src/routes/index");
const { errorHandler } = await import("../src/lib/error-handler");
const store = await import("../src/lib/valopay-store");
const { clerkClient } = await import("@clerk/express");

// Actual routes/repository/database, with a test-only verified identity adapter.
// No unverified identity header exists in the application server.
const identities = new Map<string, any>();
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  const auth = identities.get(String(req.header("X-Test-Identity"))) || {
    userId: null,
  };
  (req as any).auth = Object.assign(() => auth, {
    [Symbol.for("@clerk/express.auth")]: true,
  });
  (req as any).log = { info() {}, warn() {}, error() {} };
  next();
});
app.use("/api", router);
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
const cookie = `valopay_sandbox=${randomBytes(32).toString("hex")}`;
async function call(
  path: string,
  method = "GET",
  body?: any,
  key?: string,
  identity?: string,
  sandboxCookie = cookie,
) {
  const result = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: sandboxCookie,
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(identity ? { "X-Test-Identity": identity } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await result.json();
  return { status: result.status, data };
}
const ok = (result: { status: number; data: any }) => {
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
};
const reqFor = (id: string) =>
  ({
    headers: {},
    auth: Object.assign(() => identities.get(id), {
      [Symbol.for("@clerk/express.auth")]: true,
    }),
  }) as any;
const response = { cookie() {} } as any;
const savedEnv = {
  mode: process.env.VALOPAY_STAFF_ACCESS,
  issuer: process.env.VALOPAY_STAFF_ISSUER,
  origins: process.env.VALOPAY_STAFF_ORIGINS,
};
const oldGetUser = clerkClient.users.getUser;
const cleanupWorkspaces = new Set<string>();
try {
  // Apply the additive migration twice: fresh schema and repeat-run safety.
  const migration = await readFile(
    new URL(
      "../../../lib/db/migrations/003_pilot_workflow.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await pool.query(migration);
  await pool.query(migration);
  const workspace = ok(await call("/v1/workspace"));
  const lender = workspace.merchants[0].id,
    other = workspace.merchants[1].id;
  const owned = await pool.query(
    "SELECT workspace_id FROM valopay_merchants WHERE id=$1",
    [lender],
  );
  cleanupWorkspaces.add(owned.rows[0].workspace_id);
  const path = `/v1/records/customers?merchantId=${lender}`;
  const body = {
    name: "Recovery fixture",
    reference: `RECOVERY-${randomUUID()}`,
    data: { consentProvenance: "Synthetic fixture" },
  };
  const key = randomUUID();
  const first = ok(await call(path, "POST", body, key));
  const history = ok(await call(`/v1/operations?merchantId=${lender}`));
  assert.equal(history.total, 1);
  assert.equal(history.items[0].status, "completed");
  assert.equal(
    "request" in history.items[0],
    false,
    "List must not expose original request bodies.",
  );
  // A new HTTP request, with no browser payload/key, recovers the original ID.
  const recovered = ok(
    await call(
      `/v1/operations/${history.items[0].id}/retry?merchantId=${lender}`,
      "POST",
      {},
    ),
  );
  assert.equal(recovered.id, first.id);
  assert.equal(ok(await call(`${path}&search=${body.reference}`)).total, 1);
  assert.equal(
    (await call(path, "POST", { ...body, name: "Changed input" }, key)).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/v1/operations/${history.items[0].id}/retry?merchantId=${other}`,
        "POST",
        {},
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/v1/operations?merchantId=${lender}`,
        "GET",
        undefined,
        undefined,
        undefined,
        `valopay_sandbox=${randomBytes(32).toString("hex")}`,
      )
    ).status,
    404,
  );
  const raceKey = randomUUID(),
    raceBody = { ...body, reference: `RACE-${randomUUID()}` };
  const parallel = await Promise.all(
    Array.from({ length: 3 }, () => call(path, "POST", raceBody, raceKey)),
  );
  assert.equal(new Set(parallel.map((answer) => ok(answer).id)).size, 1);

  const rejectedKey = randomUUID();
  assert.equal(
    (
      await call(
        path,
        "POST",
        { name: "Missing required consent" },
        rejectedKey,
      )
    ).status,
    400,
  );
  const pending = ok(
    await call(`/v1/operations?merchantId=${lender}`),
  ).items.find((row: any) => row.status === "pending");
  assert.ok(pending);
  ok(
    await call(
      `/v1/operations/${pending.id}/cancel?merchantId=${lender}`,
      "POST",
      {},
    ),
  );
  assert.equal(
    (
      await call(
        path,
        "POST",
        { name: "Missing required consent" },
        rejectedKey,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/v1/operations/${pending.id}/retry?merchantId=${lender}`,
        "POST",
        {},
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/v1/operations/${history.items[0].id}/cancel?merchantId=${lender}`,
        "POST",
        {},
      )
    ).status,
    409,
  );

  const setupKey = randomUUID();
  const empty = ok(
    await call(
      "/v1/pilot/lenders",
      "POST",
      { name: "Empty pilot lender", segment: "Cooperative" },
      setupKey,
    ),
  );
  assert.equal(
    ok(
      await call(
        "/v1/pilot/lenders",
        "POST",
        { name: "Empty pilot lender", segment: "Cooperative" },
        setupKey,
      ),
    ).id,
    empty.id,
  );
  assert.equal(
    ok(await call(`/v1/records/customers?merchantId=${empty.id}`)).total,
    0,
  );
  const batchInput = {
    name: "Pilot customers",
    kind: "customers",
    source: "source-a",
    sourceBatchId: "batch-1",
    csv: "row_id,name,reference,consentProvenance\nr1,Pilot customer,PILOT-C001,Synthetic consent",
    mapping: {},
    amountUnit: "naira",
    identityColumn: "row_id",
    syntheticOnly: true,
  };
  let batch = ok(
    await call(
      `/v1/pilot/batches?merchantId=${empty.id}`,
      "POST",
      batchInput,
      randomUUID(),
    ),
  );
  assert.equal(batch.status, "ready");
  const commits = await Promise.all(
    Array.from({ length: 2 }, () =>
      call(
        `/v1/pilot/batches/${batch.id}/commit?merchantId=${empty.id}`,
        "POST",
        { expectedUpdatedAt: batch.updatedAt },
        randomUUID(),
      ),
    ),
  );
  assert.deepEqual(
    commits.map((r) => r.status).sort(),
    [200, 409],
    "Concurrent distinct commits cannot double import.",
  );
  batch = ok(
    await call(`/v1/pilot/batches/${batch.id}?merchantId=${empty.id}`),
  ).batch;
  assert.equal(batch.status, "committed");
  assert.equal(batch.data.check.imported, 1);
  const repeated = ok(
    await call(
      `/v1/pilot/batches?merchantId=${empty.id}`,
      "POST",
      { ...batchInput, sourceBatchId: "batch-2" },
      randomUUID(),
    ),
  );
  assert.equal(repeated.data.check.skipped, 1);
  assert.equal(
    ok(await call(`/v1/records/customers?merchantId=${empty.id}`)).total,
    1,
  );

  const exception = ok(
    await call(`/v1/records/exceptions?merchantId=${lender}`),
  ).items[0];
  const caseBody = {
    action: "claim",
    expectedUpdatedAt: exception.updatedAt,
    note: "Reviewing the receipt evidence.",
    nextAction: "Ask Finance to check the match",
    nextActionAt: new Date(Date.now() + 86400000).toISOString(),
    evidenceIds: [],
  };
  const claims = await Promise.all(
    Array.from({ length: 2 }, () =>
      call(
        `/v1/pilot/cases/${exception.id}?merchantId=${lender}`,
        "POST",
        caseBody,
        randomUUID(),
      ),
    ),
  );
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  const caseDetail = ok(
    await call(`/v1/pilot/cases/${exception.id}?merchantId=${lender}`),
  );
  assert.equal(caseDetail.events.length, 1);
  assert.equal(caseDetail.record.data.case.assignee, "Sandbox Admin");

  process.env.VALOPAY_STAFF_ACCESS = "staging";
  process.env.VALOPAY_STAFF_ISSUER = "https://identity.example";
  process.env.VALOPAY_STAFF_ORIGINS = "https://pilot.example";
  const organisation = `org_${randomUUID().replaceAll("-", "")}`,
    admin = `user_${randomUUID().replaceAll("-", "")}`,
    finance = `user_${randomUUID().replaceAll("-", "")}`;
  const staffAuth = (userId: string, orgId = organisation) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      userId,
      sessionId: `sess_${userId}`,
      orgId,
      tokenType: "session_token",
      sessionStatus: "active",
      factorVerificationAge: [0, 0],
      sessionClaims: {
        sub: userId,
        sid: `sess_${userId}`,
        iss: "https://identity.example",
        azp: "https://pilot.example",
        iat: now - 1,
        exp: now + 3600,
      },
    };
  };
  identities.set("admin", staffAuth(admin));
  identities.set("finance", staffAuth(finance));
  const provisioned = await store.provisionStaffWorkspace(
    organisation,
    admin,
    "Synthetic staff organisation",
  );
  cleanupWorkspaces.add(provisioned.workspaceId);
  assert.equal(
    (await call("/v1/workspace")).status,
    401,
    "Staff mode never falls back to an anonymous administrator.",
  );
  const staffWorkspace = ok(
    await call("/v1/workspace", "GET", undefined, undefined, "admin"),
  );
  assert.equal(staffWorkspace.accessMode, "staff");
  assert.equal(staffWorkspace.actor, `Clerk:${admin}`);
  assert.equal(staffWorkspace.merchants.length, 0);
  const pilot = ok(
    await call(
      "/v1/pilot/lenders",
      "POST",
      { name: "Staff pilot", segment: "Consumer lending" },
      randomUUID(),
      "admin",
    ),
  );
  assert.equal(
    (
      await call(
        `/v1/actions?merchantId=${pilot.id}`,
        "POST",
        { action: "set_role", data: { role: "Finance" } },
        randomUUID(),
        "admin",
      )
    ).status,
    403,
  );
  const invitation = ok(
    await call(
      "/v1/team/invitations",
      "POST",
      { email: "finance@example.test", role: "Finance" },
      undefined,
      "admin",
    ),
  );
  (clerkClient.users as any).getUser = async () => ({
    emailAddresses: [
      {
        emailAddress: "wrong@example.test",
        verification: { status: "verified" },
      },
    ],
  });
  assert.equal(
    (
      await call(
        "/v1/team/accept",
        "POST",
        { token: invitation.token },
        undefined,
        "finance",
      )
    ).status,
    403,
  );
  (clerkClient.users as any).getUser = async () => ({
    emailAddresses: [
      {
        emailAddress: "finance@example.test",
        verification: { status: "verified" },
      },
    ],
  });
  ok(
    await call(
      "/v1/team/accept",
      "POST",
      { token: invitation.token },
      undefined,
      "finance",
    ),
  );
  assert.equal(
    (
      await call(
        "/v1/team/accept",
        "POST",
        { token: invitation.token },
        undefined,
        "finance",
      )
    ).status,
    403,
    "Invitation tokens are single-use.",
  );
  const staff = ok(
    await call("/v1/workspace", "GET", undefined, undefined, "finance"),
  );
  assert.equal(staff.role, "Finance");
  assert.notEqual(staff.viewerScope, staffWorkspace.viewerScope);
  assert.equal(staff.merchants[0].id, pilot.id);
  assert.equal(
    (
      await call(
        `/v1/records/customers?merchantId=${lender}`,
        "GET",
        undefined,
        undefined,
        "finance",
      )
    ).status,
    404,
  );
  identities.set("no-mfa", {
    ...staffAuth(finance),
    factorVerificationAge: [0, -1],
  });
  assert.equal(
    (await call("/v1/workspace", "GET", undefined, undefined, "no-mfa")).status,
    403,
  );
  identities.set("old-mfa", {
    ...staffAuth(finance),
    factorVerificationAge: [11, 11],
  });
  assert.equal(
    (
      await call(
        `/v1/records/customers?merchantId=${pilot.id}`,
        "POST",
        body,
        randomUUID(),
        "old-mfa",
      )
    ).status,
    403,
  );

  // Hold a staff transaction. Revocation must wait for it, then immediately
  // refuse all subsequent reads/writes under the already-issued session.
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const work = store.inWorkspace(reqFor("finance"), response, async (ctx) => {
    await store.loadState(ctx, pilot.id);
    entered();
    await hold;
    return true;
  });
  await entry;
  const member = ok(
    await call("/v1/team", "GET", undefined, undefined, "admin"),
  ).members.find((row: any) => row.actor === `Clerk:${finance}`);
  let revoked = false;
  const revocation = call(
    `/v1/team/members/${member.id}`,
    "PATCH",
    {
      role: "Finance",
      status: "revoked",
      expectedUpdatedAt: member.updatedAt,
      reason: "Synthetic revocation rehearsal",
    },
    undefined,
    "admin",
  ).then((result) => {
    revoked = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(revoked, false);
  release();
  await work;
  ok(await revocation);
  assert.equal(
    (await call("/v1/workspace", "GET", undefined, undefined, "finance"))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        `/v1/records/customers?merchantId=${pilot.id}`,
        "POST",
        body,
        randomUUID(),
        "finance",
      )
    ).status,
    403,
  );
  console.log(
    "Pilot API/PostgreSQL checks passed: durable recovery, cancellation, concurrent imports/cases, empty onboarding, staff invitation, MFA, isolation and synchronised revocation.",
  );
} finally {
  (clerkClient.users as any).getUser = oldGetUser;
  for (const [key, value] of Object.entries({
    VALOPAY_STAFF_ACCESS: savedEnv.mode,
    VALOPAY_STAFF_ISSUER: savedEnv.issuer,
    VALOPAY_STAFF_ORIGINS: savedEnv.origins,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server.close();
  await once(server, "close");
  // Only the generated workspace IDs from this test are removed.
  for (const id of cleanupWorkspaces) {
    await pool.query("DELETE FROM valopay_staff_events WHERE workspace_id=$1", [
      id,
    ]);
    await pool.query(
      "DELETE FROM valopay_staff_invitations WHERE workspace_id=$1",
      [id],
    );
    await pool.query(
      "DELETE FROM valopay_staff_memberships WHERE workspace_id=$1",
      [id],
    );
    await pool.query("DELETE FROM valopay_teams WHERE workspace_id=$1", [id]);
    await pool.query(
      "DELETE FROM valopay_idempotency WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",
      [id],
    );
    await pool.query(
      "DELETE FROM valopay_records WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",
      [id],
    );
    await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1", [
      id,
    ]);
    await pool.query("DELETE FROM valopay_workspaces WHERE id=$1", [id]);
  }
  await pool.end();
}
