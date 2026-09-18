import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from '@workspace/db';
import express from 'express';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createPilotStagingStore } from '../src/lib/pilot-staging-store';
import { createPilotStagingRouter } from '../src/routes/pilot-staging';

// Separate from the runtime repository suites: this creates and destroys its
// own schema and a temporary NOLOGIN role in a disposable PostgreSQL instance.
// It never migrates the application's existing public tables.
if (process.env.VALOPAY_RUN_INTEGRATION !== '1' || process.env.VALOPAY_RUN_PILOT_RLS !== '1') {
  console.log('Set VALOPAY_RUN_INTEGRATION=1 and VALOPAY_RUN_PILOT_RLS=1 on a disposable PostgreSQL instance to rehearse pilot RLS.');
  process.exit(0);
}

const { pool, Pool } = await import('@workspace/db');
const client = await pool.connect();
const schema = `valopay_pilot_test_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^valopay_pilot_test_[a-f0-9]{32}$/);
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const tables = ['valopay_workspaces', 'valopay_merchants', 'valopay_records', 'valopay_idempotency'];
const principalA = 'a'.repeat(64), principalB = 'b'.repeat(64);
let createdSchema = false, createdRole = false;
const restrictedLogin = `valopay_rehearsal_${randomUUID().replaceAll('-', '')}`;
let createdLogin = false;
let restrictedPool: InstanceType<typeof Pool> | undefined;
const denied = (error: unknown) => (error as { code?: string }).code === '42501';

async function scoped<T>(workspace: string | undefined, principal: string | undefined, run: (connection: PoolClient) => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE valopay_pilot_app');
    if (workspace !== undefined) await client.query("SELECT set_config('valopay.workspace_id', $1, true)", [workspace]);
    if (principal !== undefined) await client.query("SELECT set_config('valopay.principal_hash', $1, true)", [principal]);
    const result = await run(client);
    const commit = await client.query('COMMIT');
    assert.equal(commit.command, 'COMMIT', 'an aborted transaction cannot report success');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const count = async (connection: PoolClient, table: string) => Number((await connection.query(`SELECT count(*) AS n FROM ${quote(table)}`)).rows[0].n);
const insertRecord = (connection: PoolClient, id: string, merchant = 'merchant-a') => connection.query(
  "INSERT INTO valopay_records(id, merchant_id, kind, name, status, data) VALUES ($1,$2,'customers','Synthetic fixture','active','{}')", [id, merchant],
);

try {
  assert.equal((await client.query("SELECT 1 FROM pg_roles WHERE rolname='valopay_pilot_app'")).rowCount, 0,
    'use a disposable PostgreSQL instance without an existing valopay_pilot_app role');
  const sourceSchema = String((await client.query('SELECT current_schema() AS name')).rows[0].name);
  await client.query(`CREATE SCHEMA ${quote(schema)}`);
  createdSchema = true;
  for (const table of tables) await client.query(`CREATE TABLE ${quote(schema)}.${quote(table)} (LIKE ${quote(sourceSchema)}.${quote(table)} INCLUDING ALL)`);
  await client.query(`SET search_path TO ${quote(schema)}, pg_catalog`);
  await client.query('ALTER TABLE valopay_merchants ADD FOREIGN KEY (workspace_id) REFERENCES valopay_workspaces(id)');
  await client.query('ALTER TABLE valopay_records ADD FOREIGN KEY (merchant_id) REFERENCES valopay_merchants(id)');
  await client.query('ALTER TABLE valopay_idempotency ADD FOREIGN KEY (merchant_id) REFERENCES valopay_merchants(id)');
  await client.query("INSERT INTO valopay_workspaces(id, principal_hash) VALUES ('workspace-a',$1),('workspace-b',$2)", [principalA, principalB]);
  await client.query("INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES ('merchant-a','workspace-a','{}','{}'),('merchant-a2','workspace-a','{}','{}'),('merchant-b','workspace-b','{}','{}')");
  await insertRecord(client, 'record-a');
  await insertRecord(client, 'record-b', 'merchant-b');
  await client.query("INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES ('request-a','merchant-a','hash-a','{}'),('request-b','merchant-b','hash-b','{}')");

  const migration = await readFile(new URL('../../../lib/db/migrations/001_pilot_rls.sql', import.meta.url), 'utf8');
  await assert.rejects(() => client.query(migration), /staging-only/);
  await client.query('ROLLBACK');
  assert.equal((await client.query("SELECT 1 FROM pg_roles WHERE rolname='valopay_pilot_app'")).rowCount, 0, 'missing opt-in creates no role');

  // Even an explicit opt-in cannot modify the application's public schema.
  const flagsForSchema = async (name: string) => (await client.query(
    'SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname', [name, tables],
  )).rows;
  const originalFlags = await flagsForSchema(sourceSchema);
  await client.query('SET search_path TO public, pg_catalog');
  await client.query("SELECT set_config('valopay.pilot_migration', 'staging-only', false)");
  await assert.rejects(() => client.query(migration), /Existing application schemas are refused/);
  await client.query('ROLLBACK');
  assert.deepEqual(await flagsForSchema(sourceSchema), originalFlags, 'the original tables keep their existing isolation settings');
  assert.equal((await client.query("SELECT 1 FROM pg_roles WHERE rolname='valopay_pilot_app'")).rowCount, 0, 'a refused application schema creates no role');
  await client.query(`SET search_path TO ${quote(schema)}, pg_catalog`);
  await client.query("SELECT set_config('valopay.pilot_migration', 'staging-only', false)");
  await client.query(migration);
  createdRole = true;

  const role = (await client.query("SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname='valopay_pilot_app'")).rows[0];
  assert.deepEqual(role, { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
  const relationFlags = (await client.query('SELECT c.relrowsecurity, c.relforcerowsecurity, r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND c.relname=ANY($2::text[])', [schema, tables])).rows;
  assert.equal(relationFlags.length, 4);
  for (const flags of relationFlags) {
    assert.equal(flags.relrowsecurity, true);
    assert.equal(flags.relforcerowsecurity, true);
    assert.notEqual(flags.owner, 'valopay_pilot_app');
  }

  // Neither an unscoped query nor one with only a guessed workspace ID sees data.
  for (const [workspace, principal] of [[undefined, undefined], ['workspace-a', undefined], [undefined, principalA], ['workspace-a', principalB], ['workspace-b', principalA], ['', '']] as const) {
    await scoped(workspace, principal, async connection => {
      for (const table of tables) assert.equal(await count(connection, table), 0, `${table} must hide rows with missing or mismatched context`);
    });
  }
  await assert.rejects(() => scoped(undefined, undefined, connection => insertRecord(connection, 'unscoped-record')), denied);

  await scoped('workspace-a', principalA, async connection => {
    assert.deepEqual((await connection.query('SELECT id FROM valopay_workspaces')).rows, [{ id: 'workspace-a' }]);
    assert.deepEqual((await connection.query('SELECT id FROM valopay_merchants ORDER BY id')).rows, [{ id: 'merchant-a' }, { id: 'merchant-a2' }]);
    assert.deepEqual((await connection.query('SELECT id FROM valopay_records')).rows, [{ id: 'record-a' }]);
    assert.deepEqual((await connection.query('SELECT id FROM valopay_idempotency')).rows, [{ id: 'request-a' }]);
    assert.equal((await connection.query("UPDATE valopay_records SET name='cross-workspace edit' WHERE id='record-b'")).rowCount, 0);
    assert.equal((await connection.query("UPDATE valopay_merchants SET info='{}' WHERE id='merchant-b'")).rowCount, 0);
    await connection.query("UPDATE valopay_records SET name='Committed own edit' WHERE id='record-a'");
    await insertRecord(connection, 'record-a-new');
    await connection.query("INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES ('request-a-new','merchant-a','hash-new','{}')");
  });

  // Cross-workspace inserts are rejected, and scope/identity columns cannot be moved.
  const refusedStatements = [
    "INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES ('foreign-new','workspace-b','{}','{}')",
    "INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES ('foreign-request','merchant-b','hash','{}')",
    "INSERT INTO valopay_workspaces(id,principal_hash) VALUES ('unprovisioned','new-principal')",
    "UPDATE valopay_workspaces SET principal_hash='spoofed' WHERE id='workspace-a'",
    "UPDATE valopay_merchants SET workspace_id='workspace-b' WHERE id='merchant-a'",
    "UPDATE valopay_records SET merchant_id='merchant-b' WHERE id='record-a'",
    "UPDATE valopay_records SET merchant_id='merchant-a2' WHERE id='record-a'",
    "UPDATE valopay_records SET id='new-id' WHERE id='record-a'",
    "UPDATE valopay_idempotency SET response='{\"changed\":true}' WHERE id='request-a'",
    "DELETE FROM valopay_records WHERE id='record-b'",
    "ALTER TABLE valopay_records DISABLE ROW LEVEL SECURITY",
    "ALTER TABLE valopay_records NO FORCE ROW LEVEL SECURITY",
    "ALTER ROLE valopay_pilot_app BYPASSRLS",
    "DROP POLICY valopay_pilot_merchant_scope ON valopay_records",
  ];
  for (const sql of refusedStatements) await assert.rejects(() => scoped('workspace-a', principalA, connection => connection.query(sql)), denied, sql);
  await assert.rejects(() => scoped('workspace-a', principalA, connection => insertRecord(connection, 'foreign-record', 'merchant-b')), denied);
  await assert.rejects(() => scoped('workspace-a', principalA, async connection => {
    await connection.query('SET LOCAL row_security=off');
    await connection.query('SELECT * FROM valopay_records');
  }), denied, 'row_security=off must fail, never bypass a policy');

  await assert.rejects(() => scoped('workspace-a', principalA, async connection => {
    await connection.query("UPDATE valopay_records SET name='Rolled back edit' WHERE id='record-a'");
    await insertRecord(connection, 'rolled-back-record');
    throw new Error('intentional rollback');
  }), /intentional rollback/);
  await scoped('workspace-a', principalA, async connection => {
    assert.equal((await connection.query("SELECT name FROM valopay_records WHERE id='record-a'")).rows[0].name, 'Committed own edit');
    assert.equal((await connection.query("SELECT 1 FROM valopay_records WHERE id='record-a-new'")).rowCount, 1);
    assert.equal((await connection.query("SELECT 1 FROM valopay_records WHERE id='rolled-back-record'")).rowCount, 0);
  });

  // Same physical connection, next tenant: no workspace, principal or role is
  // retained from the prior transaction, including after a rollback.
  const settings = (await client.query("SELECT current_setting('valopay.workspace_id', true) AS workspace, current_setting('valopay.principal_hash', true) AS principal, current_user AS role")).rows[0];
  assert.ok(!settings.workspace);
  assert.ok(!settings.principal);
  assert.notEqual(settings.role, 'valopay_pilot_app');
  await scoped(undefined, undefined, async connection => {
    for (const table of tables) assert.equal(await count(connection, table), 0);
  });
  await scoped('workspace-b', principalB, async connection => {
    assert.deepEqual((await connection.query('SELECT id FROM valopay_records')).rows, [{ id: 'record-b' }]);
    assert.equal((await connection.query("SELECT 1 FROM valopay_records WHERE id='record-a-new'")).rowCount, 0);
  });
  // Complete HTTP requests through access + MFA + fresh provisioning + a
  // genuinely restricted login + RLS + encrypted persistence. Only the test
  // injects verified-session fixtures; deployed staging uses Clerk middleware.
  assert.match(restrictedLogin, /^valopay_rehearsal_[a-f0-9]{32}$/);
  const testPassword = randomBytes(24).toString('hex');
  await client.query(`CREATE ROLE ${quote(restrictedLogin)} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${testPassword}'`);
  createdLogin = true;
  await client.query(`GRANT valopay_pilot_app TO ${quote(restrictedLogin)}`);
  const restrictedUrl = new URL(process.env.DATABASE_URL!);
  restrictedUrl.username = restrictedLogin; restrictedUrl.password = testPassword;
  restrictedPool = new Pool({ connectionString: restrictedUrl.toString(), max: 1 });
  const encryptionKey = randomBytes(32);
  const ring = { activeKeyId: 'staging-test-v1', keys: new Map([['staging-test-v1', encryptionKey]]) };
  const store = createPilotStagingStore(restrictedPool, schema, async () => ring);
  const now = Math.floor(Date.now() / 1000);
  const auth = { userId: 'fixture-user', sessionId: 'fixture-session', orgId: 'fixture-org', tokenType: 'session_token', sessionStatus: 'active', factorVerificationAge: [0, 0] as [number, number], sessionClaims: { sub: 'fixture-user', sid: 'fixture-session', iss: 'https://staging-identity.example.com', azp: 'https://staging.example.com', iat: now, exp: now + 3600 } };
  let provisioned = true;
  const membership = { id: 'fixture-membership', userId: auth.userId, organizationId: auth.orgId, tenantId: 'merchant-a', role: 'Operations', status: 'active' as const, validFrom: new Date((now - 60) * 1000).toISOString(), expiresAt: new Date((now + 3600) * 1000).toISOString() };
  const app = express(); app.use(express.json());
  app.use('/staging', createPilotStagingRouter({ store, policy: { enabled: true, environment: 'staging', issuer: auth.sessionClaims.iss, authorisedParties: [auth.sessionClaims.azp], maxFactorAgeMinutes: 30, maxSensitiveFactorAgeMinutes: 5 }, loadProvisioning: async (user, org, tenant) => provisioned && user === auth.userId && org === auth.orgId && tenant === membership.tenantId ? { membership, workspaceId: 'workspace-a', principalHash: principalA } : null }, request => request.get('Authorization') === 'Bearer synthetic-session' ? auth : null));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/staging/lenders`;
  const headers = { Authorization: 'Bearer synthetic-session', Origin: auth.sessionClaims.azp, 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-rehearsal-request-001' };
  try {
    assert.equal((await fetch(`${base}/merchant-a/records/record-a`)).status, 401);
    const initialResponse = await fetch(`${base}/merchant-a/records/record-a`, { headers });
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as { updatedAt: string };
    const body = JSON.stringify({ syntheticOnly: true, note: 'SYNTHETIC: private rehearsal note', expectedUpdatedAt: initial.updatedAt });
    const write = () => fetch(`${base}/merchant-a/records/record-a`, { method: 'PATCH', headers, body });
    const savedResponse = await write(); assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as { hasProtectedNote: boolean; liveOperationsAllowed: boolean };
    assert.equal(saved.hasProtectedNote, true); assert.equal(saved.liveOperationsAllowed, false);
    assert.ok(!JSON.stringify(saved).includes('private rehearsal note'));
    const raw = (await client.query("SELECT data FROM valopay_records WHERE id='record-a'")).rows[0].data;
    assert.ok(!JSON.stringify(raw).includes('private rehearsal note')); assert.equal(raw.protectedStagingNote.algorithm, 'A256GCM');
    assert.deepEqual(await (await write()).json(), saved, 'replay returns the first committed answer despite changed updatedAt');
    assert.equal(Number((await client.query("SELECT count(*) AS n FROM valopay_records WHERE kind='audit' AND name='staging.protected_note'")).rows[0].n), 1);
    const stale = await fetch(`${base}/merchant-a/records/record-a`, { method: 'PATCH', headers: { ...headers, 'Idempotency-Key': 'synthetic-rehearsal-request-002' }, body });
    assert.equal(stale.status, 409);
    auth.factorVerificationAge = [0, 20]; assert.equal((await write()).status, 403, 'replay still requires fresh authorisation'); auth.factorVerificationAge = [0, 0];
    provisioned = false; assert.equal((await fetch(`${base}/merchant-a/records/record-a`, { headers })).status, 403); provisioned = true;
    assert.equal((await fetch(`${base}/merchant-b/records/record-b`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/merchant-a/records/record-b`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/merchant-a/records/record-a`, { method: 'PATCH', headers: { ...headers, Origin: 'https://wrong.example.com' }, body })).status, 403);
    const nextClient = await restrictedPool.connect();
    try {
      const cleared = (await nextClient.query("SELECT current_setting('valopay.workspace_id',true) AS workspace,current_setting('valopay.principal_hash',true) AS principal,current_user AS role")).rows[0];
      assert.ok(!cleared.workspace); assert.ok(!cleared.principal); assert.equal(cleared.role, restrictedLogin);
    } finally { nextClient.release(); }
    await assert.rejects(() => createPilotStagingStore(pool, schema, async () => ring).read({ workspaceId: 'workspace-a', principalHash: principalA, tenantId: 'merchant-a', actor: 'fixture-user' }, 'record-a'), /restricted login/);
    // A non-superuser login that owns a table can later remove FORCE RLS.
    // Refuse it even though the role we SET LOCAL to does not own that table.
    const originalOwner = relationFlags[0].owner;
    await client.query(`ALTER TABLE ${quote(schema)}.valopay_records OWNER TO ${quote(restrictedLogin)}`);
    try {
      await assert.rejects(() => store.read({ workspaceId: 'workspace-a', principalHash: principalA, tenantId: 'merchant-a', actor: 'fixture-user' }, 'record-a'), /owned outside the application login and role/);
    } finally {
      await client.query(`ALTER TABLE ${quote(schema)}.valopay_records OWNER TO ${quote(originalOwner)}`);
    }
    console.log('Staging HTTP rehearsal passed: fresh membership, MFA, restricted login, forced RLS, encrypted persistence, masked reads, atomic audit and replay, stale edit refusal, connection reuse. JWT verification uses the dedicated Clerk deployment when configured; fixtures do not certify that deployment.');
  } finally { encryptionKey.fill(0); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.deepEqual(await flagsForSchema(sourceSchema), originalFlags, 'the completed rehearsal leaves original application RLS flags unchanged');
  console.log('Pilot RLS isolation rehearsal passed: explicit opt-in; four forced policies; missing/mismatched scopes; cross-workspace reads/writes; immutable scope columns; restricted role; transaction cleanup; rollback and persistence.');
} finally {
  await client.query('ROLLBACK');
  await client.query('RESET ROLE');
  await client.query('RESET search_path');
  await restrictedPool?.end();
  if (createdLogin) await client.query(`DROP ROLE ${quote(restrictedLogin)}`);
  if (createdSchema) await client.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
  if (createdRole) await client.query('DROP ROLE valopay_pilot_app');
  client.release();
  await pool.end();
}
