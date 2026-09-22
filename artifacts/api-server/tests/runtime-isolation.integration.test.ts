import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") { console.log("Opt in on disposable PostgreSQL to run restricted runtime isolation checks."); process.exit(0); }
const { Pool } = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg") as Pick<typeof import("@workspace/db"), "Pool">;
const original = { ...process.env }, admin = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomBytes(6).toString("hex"), schema = `valopay_runtime_test_${suffix}`, appRole = `runtime_app_${suffix}`, helperRole = `runtime_helper_${suffix}`, password = randomBytes(24).toString("hex");
const tables = ["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency", "valopay_operations", "valopay_teams", "valopay_staff_memberships", "valopay_staff_invitations", "valopay_staff_events", "valopay_staff_lender_access"];
let runtimePool: InstanceType<typeof Pool> | undefined;
try {
  const owner = await admin.connect();
  try {
    // All destructive cleanup later is restricted to these generated names.
    await owner.query(`CREATE SCHEMA "${schema}"`);
    for (const table of tables) await owner.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    for (const [workspace, org, user] of [["workspace-a", "org_runtimeA", "user_adminA"], ["workspace-b", "org_runtimeB", "user_adminB"]]) {
      await owner.query(`INSERT INTO "${schema}".valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Read-only')`, [workspace, createHash("sha256").update(`staff-org:${org}`).digest("hex")]);
      await owner.query(`INSERT INTO "${schema}".valopay_teams(workspace_id,organization_id,name) VALUES($1,$2,'Synthetic isolation rehearsal')`, [workspace, org]);
      await owner.query(`INSERT INTO "${schema}".valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,'Synthetic administrator','Admin',now()+interval '30 days')`, [`member-${workspace}`, workspace, user]);
      await owner.query(`INSERT INTO "${schema}".valopay_staff_events(id,workspace_id,actor,action,subject,detail) VALUES($1,$2,'System','fixture','fixture','{}')`, [`event-${workspace}`, workspace]);
      await owner.query(`INSERT INTO "${schema}".valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,'Finance',$4,'System',now()+interval '1 day')`, [`invite-${workspace}`, workspace, `${workspace}@example.test`, createHash("sha256").update(`token-${workspace}`).digest("hex")]);
    }
    for (const [id, workspace] of [["lender-a", "workspace-a"], ["lender-a-private", "workspace-a"], ["lender-b", "workspace-b"]]) {
      const info = { id, name: id, shortName: id, segment: "Consumer lending", mode: "observation", status: "onboarding", provider: "Paystack", monthlyVolume: 0, killSwitch: true, preDataReady: false, preLiveReady: false };
      await owner.query(`INSERT INTO "${schema}".valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,'{}')`, [id, workspace, info]);
      await owner.query(`INSERT INTO "${schema}".valopay_records(id,merchant_id,kind,name,status,data) VALUES($1,$2,'customers','Synthetic customer','active','{"synthetic":true}')`, [`record-${id}`, id]);
      await owner.query(`INSERT INTO "${schema}".valopay_idempotency(id,merchant_id,request_hash,response) VALUES($1,$2,'fixture','{}')`, [`key-${id}`, id]);
      await owner.query(`INSERT INTO "${schema}".valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) VALUES($1,$2,'fixture','fixture','Admin','fixture','fixture','{}','fixture')`, [`operation-${id}`, id]);
    }
    for (const [id, user, role] of [["finance-a", "user_financeA", "Finance"], ["service-a", "user_serviceA", "Operations"], ["reader-a", "user_readerA", "Read-only"]]) {
      await owner.query(`INSERT INTO "${schema}".valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,'workspace-a',$2,'Synthetic member',$3,now()+interval '30 days')`, [id, user, role]);
      await owner.query(`INSERT INTO "${schema}".valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES($1,'lender-a','fixture')`, [id]);
    }
    await owner.query(`SET search_path TO "${schema}", public`);
    await owner.query("SELECT set_config('valopay.runtime_migration','staging-only',false),set_config('valopay.runtime_app_role',$1,false),set_config('valopay.runtime_helper_role',$2,false)", [appRole, helperRole]);
    const migration = await readFile(new URL("../../../lib/db/migrations/005_runtime_isolation.sql", import.meta.url), "utf8");
    await owner.query(migration);
    await owner.query(`ALTER ROLE "${appRole}" PASSWORD '${password}'`);
  } finally { owner.release(); }
  const url = new URL(original.DATABASE_URL!); url.username = appRole; url.password = password;
  process.env.DATABASE_URL = url.toString();
  Object.assign(process.env, { VALOPAY_RUNTIME_ISOLATION: "staging", VALOPAY_RUNTIME_SCHEMA: schema, VALOPAY_RUNTIME_ROLE: appRole, VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://identity.example", VALOPAY_STAFF_ORIGINS: "https://pilot.example", VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: "projects/synthetic-test/locations/global/keyRings/test/cryptoKeys/test", VALOPAY_RUNTIME_SERVICE_ORG: "org_runtimeA", VALOPAY_RUNTIME_SERVICE_USER: "user_serviceA", CLERK_SECRET_KEY: "sk_test_placeholder" });
  const { pool } = await import("@workspace/db"); runtimePool = pool;
  const isolation = await import("../src/lib/runtime-isolation"), store = await import("../src/lib/valopay-store");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_financeA" });
    assert.deepEqual((await client.query("SELECT id FROM valopay_merchants ORDER BY id")).rows.map(row => row.id), ["lender-a"]);
    for (const table of ["valopay_records", "valopay_idempotency", "valopay_operations"]) assert.deepEqual((await client.query(`SELECT DISTINCT merchant_id FROM ${table}`)).rows.map(row => row.merchant_id), ["lender-a"]);
    for (const table of ["valopay_teams", "valopay_staff_memberships", "valopay_staff_events"]) assert.deepEqual((await client.query(`SELECT DISTINCT workspace_id FROM ${table}`)).rows.map(row => row.workspace_id), ["workspace-a"]);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM valopay_staff_invitations")).rows[0].count, 0, "A non-admin staff request cannot inspect invitation tokens or other invitees.");
    assert.deepEqual((await client.query("SELECT DISTINCT merchant_id FROM valopay_staff_lender_access")).rows.map(row => row.merchant_id), ["lender-a"]);
    assert.equal((await client.query("UPDATE valopay_records SET name='forbidden' WHERE merchant_id='lender-b'")).rowCount, 0);
    assert.equal((await client.query("UPDATE valopay_records SET name='forbidden' WHERE merchant_id='lender-a-private'")).rowCount, 0);
    await client.query("SAVEPOINT escalation");
    await assert.rejects(() => client.query("UPDATE valopay_staff_memberships SET role='Admin' WHERE id='finance-a'"), /row-level security/);
    await client.query("ROLLBACK TO SAVEPOINT escalation");
    await assert.rejects(() => client.query("INSERT INTO valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES('member-workspace-a','lender-a','forbidden')"), /row-level security/);
    await client.query("ROLLBACK TO SAVEPOINT escalation");
    assert.equal((await client.query("DELETE FROM valopay_staff_lender_access WHERE membership_id='service-a'")).rowCount, 0, "A worker cannot revoke another person's grants with raw SQL.");
    await assert.rejects(() => client.query("SELECT valopay_runtime_clear_invitee_grants()"), /verified-email invitation/);
    await client.query("ROLLBACK TO SAVEPOINT escalation");
    await client.query("COMMIT");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_readerA" });
    for (const [table, column, value] of [["valopay_merchants", "info", "info"], ["valopay_records", "name", "'forbidden'"], ["valopay_idempotency", "response", "'{}'::jsonb"], ["valopay_operations", "request", "'{}'::jsonb"]]) assert.equal((await client.query(`UPDATE ${table} SET ${column}=${value}`)).rowCount, 0, `Read-only SQL cannot update ${table}.`);
    const blockedInserts = [
      "INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES('blocked-new','workspace-a','{}','{}')",
      "INSERT INTO valopay_records(id,merchant_id,kind,name,status,data) VALUES('blocked-new','lender-a','customers','Forbidden','active','{}')",
      "INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES('blocked-new','lender-a','blocked','{}')",
      "INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) VALUES('blocked-new','lender-a','fixture','fixture','Read-only','fixture','fixture','{}','fixture')",
    ];
    await client.query("SAVEPOINT reader_write");
    for (const sql of blockedInserts) { await assert.rejects(() => client.query(sql), /row-level security/); await client.query("ROLLBACK TO SAVEPOINT reader_write"); }
    await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_adminA" });
    assert.equal((await client.query("UPDATE valopay_idempotency SET response='{}'::jsonb WHERE merchant_id='lender-a'")).rowCount, 1, "Admin lifecycle redaction can replace the scoped idempotency response."); await client.query("ROLLBACK");
    await client.query("BEGIN"); await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
    for (const table of tables) assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, `${table}: transaction scope does not leak through the pool.`);
    await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeB", userId: "user_financeA" });
    assert.equal((await client.query("SELECT count(*)::int AS count FROM valopay_records")).rows[0].count, 0, "User/organisation mixing produces no authorised rows."); await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_invitee" }, { token: "token-workspace-a", verifiedEmails: ["workspace-a@example.test"] });
    assert.equal((await client.query("SELECT id FROM valopay_staff_invitations")).rows[0].id, "invite-workspace-a");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM valopay_merchants")).rows[0].count, 0, "An invitation scope has no lender grants."); await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeIdentity(client, { organizationId: "org_runtimeA", userId: "user_invitee" }, { token: "token-workspace-a", verifiedEmails: ["wrong@example.test"] });
    assert.equal((await client.query("SELECT count(*)::int AS count FROM valopay_staff_invitations")).rows[0].count, 0); await client.query("ROLLBACK");
    await client.query("BEGIN"); await isolation.bindRuntimeService(client);
    assert.equal(await isolation.runtimeExportRequesterAllowed(client, "workspace-a", "lender-a", "Clerk:user_financeA", "Finance"), true);
    assert.equal(await isolation.runtimeExportRequesterAllowed(client, "workspace-a", "lender-a-private", "Clerk:user_financeA", "Finance"), false);
    assert.equal(await isolation.runtimeExportRequesterAllowed(client, "workspace-a", "lender-a", "Clerk:user_financeA", "Admin"), false);
    assert.equal(await isolation.runtimeExportRequesterAllowed(client, "workspace-a", "lender-a", "Clerk:user_financeA", "invented-role"), false); await client.query("ROLLBACK");
  } finally { client.release(); }
  // Exercise the actual repository entry point under the restricted LOGIN,
  // including staff/MFA verification. No KMS call is needed to read this masked
  // synthetic fixture; encryption has its own injected-adapter acceptance suite.
  const now = Math.floor(Date.now() / 1000), auth = { userId: "user_financeA", orgId: "org_runtimeA", sessionId: "sess_runtime", tokenType: "session_token", sessionStatus: "active", factorVerificationAge: [0, 0], sessionClaims: { sub: "user_financeA", sid: "sess_runtime", iss: "https://identity.example", azp: "https://pilot.example", iat: now - 1, exp: now + 3600 } };
  const req = { headers: {}, auth: Object.assign(() => auth, { [Symbol.for("@clerk/express.auth")]: true }) } as any;
  // Actual acceptance and ON CONFLICT renewal under the restricted LOGIN.
  // Only Clerk's verified-email lookup is replaced; no external call is made.
  const { clerkClient } = await import("@clerk/express"), previousGetUser = clerkClient.users.getUser;
  const inviteeAuth = { ...auth, userId: "user_invitee", sessionClaims: { ...auth.sessionClaims, sub: "user_invitee" } };
  const inviteeRequest = { headers: {}, auth: Object.assign(() => inviteeAuth, { [Symbol.for("@clerk/express.auth")]: true }) } as any;
  let verifiedEmail = "wrong@example.test";
  clerkClient.users.getUser = (async () => ({ id: "user_invitee", emailAddresses: [{ emailAddress: verifiedEmail, verification: { status: "verified" } }] })) as any;
  try {
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-workspace-a"), /organisation|invitation/i, "A verified but different email cannot accept the invitation.");
    verifiedEmail = "workspace-a@example.test";
    const accepted = await Promise.allSettled([store.acceptStaffInvitation(inviteeRequest, "token-workspace-a"), store.acceptStaffInvitation(inviteeRequest, "token-workspace-a")]);
    assert.equal(accepted.filter(result => result.status === "fulfilled").length, 1, "Concurrent invitation acceptance commits exactly once.");
    assert.equal(accepted.filter(result => result.status === "rejected").length, 1);
    const firstMembership = (await admin.query(`SELECT id,role,status FROM "${schema}".valopay_staff_memberships WHERE workspace_id='workspace-a' AND user_id='user_invitee'`)).rows[0];
    assert.equal(firstMembership.role, "Finance"); assert.equal(firstMembership.status, "active");
    assert.equal((await admin.query(`SELECT status FROM "${schema}".valopay_staff_invitations WHERE id='invite-workspace-a'`)).rows[0].status, "accepted");
    assert.deepEqual(await store.inWorkspace(inviteeRequest, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read"), [], "Accepting an invitation grants no lenders.");
    await admin.query(`INSERT INTO "${schema}".valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES('invite-renewal','workspace-a','workspace-a@example.test','Read-only',$1,'System',now()+interval '1 day')`, [createHash("sha256").update("token-renewal").digest("hex")]);
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-renewal"), /already have an active membership/, "An active member cannot use renewal to change their own role.");
    await admin.query(`UPDATE "${schema}".valopay_staff_memberships SET status='revoked' WHERE id=$1`, [firstMembership.id]);
    await admin.query(`INSERT INTO "${schema}".valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES($1,'lender-a','fixture')`, [firstMembership.id]);
    const renewed = await store.acceptStaffInvitation(inviteeRequest, "token-renewal");
    assert.equal(renewed.role, "Read-only");
    const membershipRows = (await admin.query(`SELECT id,role,status FROM "${schema}".valopay_staff_memberships WHERE workspace_id='workspace-a' AND user_id='user_invitee'`)).rows;
    assert.deepEqual(membershipRows, [{ id: firstMembership.id, role: "Read-only", status: "active" }], "Renewal updates the original membership under the invitation policy.");
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM "${schema}".valopay_staff_lender_access WHERE membership_id=$1`, [firstMembership.id])).rows[0].count, 0, "The narrow renewal helper clears the revoked person's old grants.");
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM "${schema}".valopay_staff_events WHERE actor='Clerk:user_invitee' AND action='staff.accepted'`)).rows[0].count, 2, "Acceptance and renewal each preserve an audit event.");
    assert.deepEqual(await store.inWorkspace(inviteeRequest, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read"), []);
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-renewal"), /expired|used|revoked|invitation/i, "A consumed renewal token cannot be reused.");
  } finally { clerkClient.users.getUser = previousGetUser; }
  const result = await store.inWorkspace(req, { cookie() {} } as any, async ctx => ({ lenders: await store.listMerchants(ctx), state: await store.loadState(ctx, "lender-a", "share") }), "read");
  assert.deepEqual(result.lenders.map(lender => lender.id), ["lender-a"]); assert.equal(result.state.records[0]?.name, "Synthetic customer");
  const readerAuth = { ...auth, userId: "user_readerA", sessionClaims: { ...auth.sessionClaims, sub: "user_readerA" } };
  const readerRequest = { headers: {}, auth: Object.assign(() => readerAuth, { [Symbol.for("@clerk/express.auth")]: true }) } as any;
  const readerState = await store.inWorkspace(readerRequest, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a", "share"), "read");
  assert.equal(readerState.records[0]?.name, "Synthetic customer", "Restricted Read-only users can still inspect a consistent lender snapshot.");
  await assert.rejects(() => store.inWorkspace(req, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a-private", "share"), "read"), /not found/);
  await admin.query(`DELETE FROM "${schema}".valopay_staff_lender_access WHERE membership_id='finance-a'`);
  await assert.rejects(() => store.inWorkspace(req, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a", "share"), "read"), /not found/);
  const elevated = await admin.connect(); try { await elevated.query("BEGIN"); await assert.rejects(() => isolation.bindRuntimeIdentity(elevated, { organizationId: "org_runtimeA", userId: "user_adminA" }), /elevated/); await elevated.query("ROLLBACK"); } finally { elevated.release(); }
  const configured = process.env.VALOPAY_RUNTIME_SCHEMA; process.env.VALOPAY_RUNTIME_SCHEMA = "public"; assert.throws(() => isolation.runtimeIsolationConfiguration(), /public/); process.env.VALOPAY_RUNTIME_SCHEMA = configured;
  console.log("Runtime isolation passed: actual restricted login, ten forced-RLS tables, pooled-scope reset, mixed-tenant denial, per-lender grants, concurrent invitation acceptance and renewal, service requester checks and real repository/MFA integration.");
} finally {
  if (runtimePool) await runtimePool.end();
  if (!/^valopay_runtime_test_[a-f0-9]+$/.test(schema) || !/^runtime_(app|helper)_[a-f0-9]+$/.test(appRole) || !/^runtime_(app|helper)_[a-f0-9]+$/.test(helperRole)) throw new Error("Unsafe generated test cleanup target.");
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  for (const role of [appRole, helperRole]) if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
  await admin.end();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}
