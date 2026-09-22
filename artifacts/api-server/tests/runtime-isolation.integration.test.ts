import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { normaliseRuntimeDefinition, reviewedRuntimeHelpers, reviewedRuntimePolicies, reviewedRuntimeTrigger } from "../src/lib/runtime-isolation-policy";

if (process.env.VALOPAY_RUN_INTEGRATION !== "1") { console.log("Opt in on disposable PostgreSQL to run restricted runtime isolation checks."); process.exit(0); }
const { Pool } = createRequire(new URL("../../../lib/db/package.json", import.meta.url))("pg") as Pick<typeof import("@workspace/db"), "Pool">;
const original = { ...process.env }, admin = new Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomBytes(6).toString("hex"), schema = `valopay_runtime_test_${suffix}`, appRole = `runtime_app_${suffix}`, helperRole = `runtime_helper_${suffix}`, password = randomBytes(24).toString("hex");
const tables = ["valopay_workspaces", "valopay_merchants", "valopay_records", "valopay_idempotency", "valopay_operations", "valopay_teams", "valopay_staff_memberships", "valopay_staff_invitations", "valopay_staff_events", "valopay_staff_lender_access"];
let runtimePool: InstanceType<typeof Pool> | undefined;
const scopeMigration = await readFile(new URL("../../../lib/db/migrations/006_runtime_isolation_scope.sql", import.meta.url), "utf8");
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
    // 006 runs as its own explicit step: 005 clears the commissioning opt-in when it finishes.
    await assert.rejects(() => owner.query(scopeMigration), /explicit commissioning/, "006 needs its own explicit opt-in.");
    await owner.query("ROLLBACK");
    await owner.query(`ALTER ROLE "${appRole}" PASSWORD '${password}'`);
  } finally { owner.release(); }
  const url = new URL(original.DATABASE_URL!); url.username = appRole; url.password = password;
  process.env.DATABASE_URL = url.toString();
  Object.assign(process.env, { VALOPAY_RUNTIME_ISOLATION: "staging", VALOPAY_RUNTIME_SCHEMA: schema, VALOPAY_RUNTIME_ROLE: appRole, VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://identity.example", VALOPAY_STAFF_ORIGINS: "https://pilot.example", VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: "projects/synthetic-test/locations/global/keyRings/test/cryptoKeys/test", VALOPAY_RUNTIME_SERVICE_ORG: "org_runtimeA", VALOPAY_RUNTIME_SERVICE_USER: "user_serviceA", CLERK_SECRET_KEY: "sk_test_placeholder" });
  const { pool } = await import("@workspace/db"); runtimePool = pool;
  const isolation = await import("../src/lib/runtime-isolation"), store = await import("../src/lib/valopay-store");
  // With 005 alone every lender check runs per row; the application refuses that schema.
  const early = await pool.connect();
  try {
    await early.query("BEGIN");
    await assert.rejects(() => isolation.bindRuntimeIdentity(early, { organizationId: "org_runtimeA", userId: "user_financeA" }), /Apply lib\/db\/migrations\/006_runtime_isolation_scope\.sql/, "The application refuses row-by-row lender policies.");
    await early.query("ROLLBACK");
  } finally { early.release(); }
  const upgrade = await admin.connect();
  try {
    await upgrade.query(`SET search_path TO "${schema}", public`);
    await upgrade.query("SELECT set_config('valopay.runtime_migration','staging-only',false)");
    await upgrade.query(scopeMigration);
    await upgrade.query("SELECT set_config('valopay.runtime_migration','staging-only',false)");
    await assert.rejects(() => upgrade.query(scopeMigration), /already evaluates lender scope once per statement/, "006 applies once.");
    await upgrade.query("ROLLBACK");
    await upgrade.query("SELECT set_config('valopay.runtime_migration','',false)");
  } finally { upgrade.release(); }
  // The reviewed set in runtime-isolation-policy.ts is exactly what 005 and 006
  // install, as PostgreSQL renders it with the search path the self-check uses.
  // A migration, or a PostgreSQL major version, that changes it fails here with
  // the difference to review.
  const golden = await admin.connect();
  try {
    await golden.query(`SET search_path TO pg_catalog, "${schema}", pg_temp`);
    const scope = { schema, role: appRole };
    const policies = (await golden.query(`SELECT tablename,policyname,cmd,permissive,roles::text[] AS roles,qual,with_check FROM pg_policies WHERE schemaname=$1 AND tablename=ANY($2::text[])`, [schema, tables])).rows;
    assert.deepEqual(Object.fromEntries(policies.map(row => [`${row.tablename}:${row.policyname}:${row.cmd}`, { using: normaliseRuntimeDefinition(row.qual, scope), check: normaliseRuntimeDefinition(row.with_check, scope) }])), reviewedRuntimePolicies, "The reviewed policies are what 005 and 006 install.");
    assert.ok(policies.every(row => row.permissive === "PERMISSIVE" && row.roles.length === 1 && row.roles[0] === appRole), "Every installed policy is permissive and names only the runtime login.");
    const helpers = (await golden.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS result,p.provolatile::text AS volatility,l.lanname AS language,p.prosrc AS source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1`, [schema])).rows;
    assert.deepEqual(Object.fromEntries(helpers.map(row => [row.proname, { args: row.args, result: row.result, volatility: row.volatility, language: row.language, source: normaliseRuntimeDefinition(row.source, scope) }])), reviewedRuntimeHelpers, "The reviewed helpers are the schema's only functions, as 005 and 006 define them.");
    const triggers = (await golden.query(`SELECT t.tgname,c.relname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal`, [schema])).rows;
    assert.deepEqual(triggers.map(row => ({ name: row.tgname, table: row.relname, definition: normaliseRuntimeDefinition(row.definition, scope) })), [reviewedRuntimeTrigger], "The workspace guard is the only trigger, as 005 defines it.");
  } finally { await golden.query("RESET search_path"); golden.release(); }
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
    await client.query("SAVEPOINT workspace_role");
    await assert.rejects(() => client.query("UPDATE valopay_workspaces SET role='Admin' WHERE id='workspace-a'"), /never changes them/, "The application role can lock its workspace row but never rewrite it; staff roles come from memberships.");
    await client.query("ROLLBACK TO SAVEPOINT workspace_role");
    assert.equal((await client.query("SELECT id FROM valopay_workspaces WHERE id='workspace-a' FOR SHARE")).rowCount, 1, "Row locks, which the store takes on every staff request, still work.");
    await client.query("ROLLBACK TO SAVEPOINT workspace_role");
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
  // The self-check compares what each policy, helper and the workspace guard do,
  // not only their names. Every weakening below keeps the names and used to pass,
  // so the readiness page called the database verified while, for instance,
  // Finance A's SQL saw every workspace's lenders. Each is now refused with a 503
  // whose logged differences name it, and the restored set is accepted again.
  const readinessRoute = ((await import("../src/routes/access-readiness")).default as any).stack.find((layer: any) => layer.route?.path === "/v1/team/readiness" && layer.route.methods.get).route.stack[0].handle;
  const databaseReadiness = async () => { let body: any; const res: any = { cookie() {}, json(value: unknown) { body = value; return res; } }; await readinessRoute(req, res); return body.checks.find((check: any) => check.id === "database"); };
  const verified = await databaseReadiness();
  assert.equal(verified.state, "verified_this_request"); assert.match(verified.detail, /reviewed/, "Readiness says what this request verified.");
  const bindFinance = async () => { const probe = await pool.connect(); try { await probe.query("BEGIN"); await isolation.bindRuntimeIdentity(probe, { organizationId: "org_runtimeA", userId: "user_financeA" }); } finally { await probe.query("ROLLBACK"); probe.release(); } };
  const dba = await admin.connect();
  try {
    await dba.query(`SET search_path TO pg_catalog, "${schema}", pg_temp`);
    const rendered = async (table: string, policy: string, column: "qual" | "with_check") => (await dba.query(`SELECT ${column} AS expression FROM pg_policies WHERE schemaname=$1 AND tablename=$2 AND policyname=$3`, [schema, table, policy])).rows[0].expression as string;
    const merchantsScope = await rendered("valopay_merchants", "valopay_runtime_scope", "qual"), recordsScope = await rendered("valopay_records", "valopay_runtime_scope", "qual");
    const recordsInsert = await rendered("valopay_records", "valopay_runtime_insert", "with_check"), eventsInsert = await rendered("valopay_staff_events", "valopay_runtime_insert", "with_check");
    const lendersDefinition = (await dba.query("SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='valopay_runtime_lenders'", [schema])).rows[0].definition as string;
    const guard = "CREATE TRIGGER valopay_runtime_workspace_guard BEFORE UPDATE ON valopay_workspaces FOR EACH ROW EXECUTE FUNCTION valopay_runtime_guard_workspace()";
    const policyRefusal = /differ from the reviewed runtime policy set/, helperRefusal = /differs from the reviewed runtime helper set/;
    const weakenings = [
      { name: "a lender scope that admits every lender", apply: "ALTER POLICY valopay_runtime_scope ON valopay_merchants USING (true)", restore: `ALTER POLICY valopay_runtime_scope ON valopay_merchants USING (${merchantsScope})`, refusal: policyRefusal, differences: ["valopay_merchants:valopay_runtime_scope:SELECT: USING expression differs"] },
      { name: "an insert check that admits any lender", apply: "ALTER POLICY valopay_runtime_insert ON valopay_records WITH CHECK (true)", restore: `ALTER POLICY valopay_runtime_insert ON valopay_records WITH CHECK (${recordsInsert})`, refusal: policyRefusal, differences: ["valopay_records:valopay_runtime_insert:INSERT: WITH CHECK expression differs"] },
      { name: "a scope widened to every role", apply: "ALTER POLICY valopay_runtime_scope ON valopay_records TO public", restore: `ALTER POLICY valopay_runtime_scope ON valopay_records TO "${appRole}"`, refusal: policyRefusal, differences: ["valopay_records:valopay_runtime_scope:SELECT: applies to public instead of the runtime login"] },
      { name: "a scope recreated as restrictive", apply: `DROP POLICY valopay_runtime_scope ON valopay_records; CREATE POLICY valopay_runtime_scope ON valopay_records AS RESTRICTIVE FOR SELECT TO "${appRole}" USING (${recordsScope})`, restore: `DROP POLICY valopay_runtime_scope ON valopay_records; CREATE POLICY valopay_runtime_scope ON valopay_records FOR SELECT TO "${appRole}" USING (${recordsScope})`, refusal: policyRefusal, differences: ["valopay_records:valopay_runtime_scope:SELECT: restrictive instead of permissive"] },
      { name: "a lender helper that lists every lender", apply: `CREATE OR REPLACE FUNCTION "${schema}".valopay_runtime_lenders() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog,"${schema}",pg_temp AS $body$ SELECT id FROM "${schema}".valopay_merchants $body$`, restore: lendersDefinition, refusal: helperRefusal, differences: ["valopay_runtime_lenders: body differs"] },
      { name: "a disabled workspace guard", apply: "ALTER TABLE valopay_workspaces DISABLE TRIGGER valopay_runtime_workspace_guard", restore: "ALTER TABLE valopay_workspaces ENABLE TRIGGER valopay_runtime_workspace_guard", refusal: policyRefusal, differences: ["valopay_runtime_workspace_guard: disabled (state D)"] },
      { name: "a workspace guard narrowed to one column", apply: `DROP TRIGGER valopay_runtime_workspace_guard ON valopay_workspaces; ${guard.replace("UPDATE ON", "UPDATE OF principal_hash ON")}`, restore: `DROP TRIGGER valopay_runtime_workspace_guard ON valopay_workspaces; ${guard}`, refusal: policyRefusal, differences: ["valopay_runtime_workspace_guard: definition differs"] },
      // Read with the runtime schema first, this policy would render exactly as reviewed.
      { name: "a built-in shadowed from the runtime schema", apply: `CREATE FUNCTION "${schema}".current_setting(text, boolean) RETURNS text LANGUAGE sql STABLE AS $body$ SELECT pg_catalog.current_setting($1, $2) $body$; ALTER POLICY valopay_runtime_insert ON valopay_staff_events WITH CHECK (${eventsInsert.replace("current_setting(", `"${schema}".current_setting(`)})`, restore: `ALTER POLICY valopay_runtime_insert ON valopay_staff_events WITH CHECK (${eventsInsert}); DROP FUNCTION "${schema}".current_setting(text, boolean)`, refusal: policyRefusal, differences: ["valopay_staff_events:valopay_runtime_insert:INSERT: WITH CHECK expression differs"] },
    ];
    for (const weakening of weakenings) {
      await dba.query(weakening.apply);
      try {
        await assert.rejects(bindFinance, (error: any) => { assert.equal(error.status, 503, weakening.name); assert.match(error.message, weakening.refusal, weakening.name); assert.deepEqual(error.differences, weakening.differences, weakening.name); return true; }, `Refused: ${weakening.name}.`);
        if (weakening === weakenings[0]) {
          await assert.rejects(databaseReadiness, policyRefusal, "Readiness cannot call a weakened database verified.");
          await assert.rejects(() => store.inWorkspace(req, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read"), policyRefusal, "No staff request runs on a weakened database.");
        }
      } finally { await dba.query(weakening.restore); }
      await bindFinance();
    }
  } finally { await dba.query("RESET search_path"); dba.release(); }
  assert.equal((await databaseReadiness()).state, "verified_this_request", "The restored set is verified again.");
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
    // Revoked as the team page records it: the membership's change time moves.
    await admin.query(`UPDATE "${schema}".valopay_staff_memberships SET status='revoked',updated_at=clock_timestamp() WHERE id=$1`, [firstMembership.id]);
    await admin.query(`INSERT INTO "${schema}".valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES($1,'lender-a','fixture')`, [firstMembership.id]);
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-renewal"), /sent before your access was suspended or revoked/, "An invitation sent before the revocation cannot restore access.");
    assert.equal((await admin.query(`SELECT status FROM "${schema}".valopay_staff_memberships WHERE id=$1`, [firstMembership.id])).rows[0].status, "revoked");
    await admin.query(`INSERT INTO "${schema}".valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES('invite-renewal-2','workspace-a','workspace-a@example.test','Read-only',$1,'System',now()+interval '1 day')`, [createHash("sha256").update("token-renewal-2").digest("hex")]);
    const renewed = await store.acceptStaffInvitation(inviteeRequest, "token-renewal-2");
    assert.equal(renewed.role, "Read-only");
    const membershipRows = (await admin.query(`SELECT id,role,status FROM "${schema}".valopay_staff_memberships WHERE workspace_id='workspace-a' AND user_id='user_invitee'`)).rows;
    assert.deepEqual(membershipRows, [{ id: firstMembership.id, role: "Read-only", status: "active" }], "Renewal updates the original membership under the invitation policy.");
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM "${schema}".valopay_staff_lender_access WHERE membership_id=$1`, [firstMembership.id])).rows[0].count, 0, "The narrow renewal helper clears the revoked person's old grants.");
    assert.equal((await admin.query(`SELECT count(*)::int AS count FROM "${schema}".valopay_staff_events WHERE actor='Clerk:user_invitee' AND action='staff.accepted'`)).rows[0].count, 2, "Acceptance and renewal each preserve an audit event.");
    assert.deepEqual(await store.inWorkspace(inviteeRequest, { cookie() {} } as any, ctx => store.listMerchants(ctx), "read"), []);
    await assert.rejects(() => store.acceptStaffInvitation(inviteeRequest, "token-renewal-2"), /expired|used|revoked|invitation/i, "A consumed renewal token cannot be reused.");
  } finally { clerkClient.users.getUser = previousGetUser; }
  const result = await store.inWorkspace(req, { cookie() {} } as any, async ctx => ({ lenders: await store.listMerchants(ctx), state: await store.loadState(ctx, "lender-a", "share") }), "read");
  assert.deepEqual(result.lenders.map(lender => lender.id), ["lender-a"]); assert.equal(result.state.records[0]?.name, "Synthetic customer");
  const readerAuth = { ...auth, userId: "user_readerA", sessionClaims: { ...auth.sessionClaims, sub: "user_readerA" } };
  const readerRequest = { headers: {}, auth: Object.assign(() => readerAuth, { [Symbol.for("@clerk/express.auth")]: true }) } as any;
  const readerState = await store.inWorkspace(readerRequest, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a", "share"), "read");
  assert.equal(readerState.records[0]?.name, "Synthetic customer", "Restricted Read-only users can still inspect a consistent lender snapshot.");
  await assert.rejects(() => store.inWorkspace(req, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a-private", "share"), "read"), /not found/);
  // Pilot scale: a lender with 13,000 records loads through the policies in one
  // pass. The visible lenders are a hashed set built once per statement, never a
  // helper call per row (which took about ten seconds for this lender).
  await admin.query(`INSERT INTO "${schema}".valopay_records(id,merchant_id,kind,name,status,data) SELECT 'scale-'||g,'lender-a','customers','Synthetic customer '||g,'active','{"synthetic":true}' FROM generate_series(1,13000) g`);
  await admin.query(`ANALYZE "${schema}".valopay_records`);
  const scale = await pool.connect();
  try {
    await scale.query("BEGIN"); await isolation.bindRuntimeIdentity(scale, { organizationId: "org_runtimeA", userId: "user_financeA" });
    const plan = (await scale.query("EXPLAIN (COSTS OFF) SELECT * FROM valopay_records WHERE merchant_id='lender-a'")).rows.map(row => row["QUERY PLAN"]).join("\n");
    assert.match(plan, /hashed SubPlan/, `The lender policy is a hashed set, not a per-row helper call:\n${plan}`);
    assert.doesNotMatch(plan, /valopay_runtime_lender\(/, "No per-row lender helper remains in the records plan.");
    const started = performance.now();
    assert.equal((await scale.query("SELECT id FROM valopay_records WHERE merchant_id='lender-a'")).rowCount, 13001);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 3000, `A pilot-scale lender loads in ${Math.round(elapsed)} ms under row security.`);
    assert.equal((await scale.query("SELECT count(*)::int AS count FROM valopay_records WHERE merchant_id='lender-b'")).rows[0].count, 0, "Another workspace's lender stays invisible.");
    await scale.query("ROLLBACK");
  } finally { scale.release(); }
  const loaded = await store.inWorkspace(req, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a", "share"), "read");
  assert.equal(loaded.records.length, 13001, "The repository loads the whole pilot-scale lender under the restricted login.");
  await admin.query(`DELETE FROM "${schema}".valopay_staff_lender_access WHERE membership_id='finance-a'`);
  await assert.rejects(() => store.inWorkspace(req, { cookie() {} } as any, ctx => store.loadState(ctx, "lender-a", "share"), "read"), /not found/);
  const elevated = await admin.connect(); try { await elevated.query("BEGIN"); await assert.rejects(() => isolation.bindRuntimeIdentity(elevated, { organizationId: "org_runtimeA", userId: "user_adminA" }), /elevated/); await elevated.query("ROLLBACK"); } finally { elevated.release(); }
  const configured = process.env.VALOPAY_RUNTIME_SCHEMA; process.env.VALOPAY_RUNTIME_SCHEMA = "public"; assert.throws(() => isolation.runtimeIsolationConfiguration(), /public/); process.env.VALOPAY_RUNTIME_SCHEMA = configured;
  console.log("Runtime isolation passed: actual restricted login, ten forced-RLS tables, the reviewed policies, helpers and workspace guard compared by definition (eight weakenings refused), once-per-statement lender scope at pilot scale, pooled-scope reset, mixed-tenant denial, per-lender grants, concurrent invitation acceptance and renewal, service requester checks and real repository/MFA integration.");
} finally {
  if (runtimePool) await runtimePool.end();
  if (!/^valopay_runtime_test_[a-f0-9]+$/.test(schema) || !/^runtime_(app|helper)_[a-f0-9]+$/.test(appRole) || !/^runtime_(app|helper)_[a-f0-9]+$/.test(helperRole)) throw new Error("Unsafe generated test cleanup target.");
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  for (const role of [appRole, helperRole]) if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount) { await admin.query(`DROP OWNED BY "${role}"`); await admin.query(`DROP ROLE "${role}"`); }
  await admin.end();
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}
