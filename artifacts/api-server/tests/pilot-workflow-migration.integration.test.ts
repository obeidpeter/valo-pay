// Rehearses lib/db/migrations/003_pilot_workflow.sql, 004_staff_lender_access.sql and
// 007_journal_and_lender_indexes.sql on a throwaway database, the way a host applies
// them: on a schema that does not carry the tables yet. The other database-backed suites run them after drizzle-kit push, where
// CREATE TABLE IF NOT EXISTS finds every table and the SQL is never exercised. The
// result must match the pushed schema exactly (columns, constraints, indexes), so a
// database built by either route behaves the same; the files must be repeatable; and
// the rules they declare must hold.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

if (process.env.VALOPAY_RUN_INTEGRATION !== '1') {
  console.log('Pilot workflow migration rehearsal requires a disposable local PostgreSQL instance.'); process.exit(0);
}
const connection = new URL(process.env.DATABASE_URL || '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname), 'migration rehearsal refuses remote hosts');
assert.equal(connection.pathname, '/valopay', 'use the disposable CI database named valopay, which carries the pushed schema to compare with');
const { pool, Pool } = await import('@workspace/db');
const database = `valopay_pilot_rehearsal_${randomUUID().replaceAll('-', '')}`;
assert.match(database, /^valopay_pilot_rehearsal_[a-f0-9]{32}$/);
const targetUrl = new URL(connection); targetUrl.pathname = `/${database}`;
const migrations = await Promise.all(['003_pilot_workflow.sql', '004_staff_lender_access.sql', '007_journal_and_lender_indexes.sql'].map((name) => readFile(new URL(`../../../lib/db/migrations/${name}`, import.meta.url), 'utf8')));
const tables = ['valopay_operations', 'valopay_teams', 'valopay_staff_memberships', 'valopay_staff_invitations', 'valopay_staff_events', 'valopay_staff_lender_access'];
type Client = Pick<InstanceType<typeof Pool>, 'query'>;
/** Everything that decides how a table behaves: its columns, constraints and indexes, named. */
async function shape(client: Client, table: string) {
  const columns = (await client.query('SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', ['public', table])).rows;
  const constraints = (await client.query('SELECT conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=($1)::regclass ORDER BY conname', [`public.${table}`])).rows;
  const indexes = (await client.query('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname', ['public', table])).rows;
  return { columns, constraints, indexes };
}
/** The lender table is created below as the earlier schema left it, so only its indexes are compared: 007 adds one. */
const lenderIndexes = async (client: Client) => (await client.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='valopay_merchants' AND indexname<>'valopay_merchants_pkey' ORDER BY indexname")).rows;
let target: InstanceType<typeof Pool> | undefined, created = false, checks = 0;
try {
  const pushed = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await shape(pool, table)]))), pushedLenderIndexes = await lenderIndexes(pool);
  for (const table of tables) assert.ok(pushed[table].columns.length, `${table} is missing from the pushed schema; run drizzle-kit push before this rehearsal`);
  await pool.query(`CREATE DATABASE "${database}"`); created = true;
  target = new Pool({ connectionString: targetUrl.toString() });
  // The tables the migrations reference, as the earlier schema left them.
  await target.query('CREATE TABLE public.valopay_workspaces (id text PRIMARY KEY, principal_hash text NOT NULL, role text NOT NULL)');
  await target.query('CREATE TABLE public.valopay_merchants (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES public.valopay_workspaces(id), info jsonb NOT NULL, settings jsonb NOT NULL)');
  for (const migration of migrations) await target.query(migration);
  for (const table of tables) { assert.deepEqual(await shape(target, table), pushed[table], `${table} built by the migration differs from the pushed schema`); checks++; }
  assert.deepEqual(await lenderIndexes(target), pushedLenderIndexes, 'the lender indexes built by the migration differ from the pushed schema'); checks++;
  // Rows survive a repeat application, and the schema does not change.
  await target.query("INSERT INTO public.valopay_workspaces VALUES('workspace-a','hash-a','Admin')");
  await target.query(`INSERT INTO public.valopay_merchants VALUES('lender-a','workspace-a','{}','{}')`);
  await target.query("INSERT INTO public.valopay_teams VALUES('workspace-a','org_synthetic','Synthetic team')");
  await target.query("INSERT INTO public.valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES('member-a','workspace-a','user_a','Synthetic member','Finance',now()+interval '30 days')");
  await target.query("INSERT INTO public.valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES('member-a','lender-a','fixture')");
  await target.query("INSERT INTO public.valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) VALUES('operation-a','lender-a','owner','Clerk:user_a','Finance','key','hash','{}','Save records customers')");
  const before = (await target.query('SELECT status,receipt FROM public.valopay_operations WHERE id=$1', ['operation-a'])).rows;
  for (const migration of migrations) await target.query(migration);
  for (const table of tables) { assert.deepEqual(await shape(target, table), pushed[table], `${table} changed on a repeat application`); checks++; }
  assert.deepEqual(await lenderIndexes(target), pushedLenderIndexes, 'the lender indexes changed on a repeat application'); checks++;
  assert.deepEqual((await target.query('SELECT status,receipt FROM public.valopay_operations WHERE id=$1', ['operation-a'])).rows, before, 'a repeat application keeps existing rows'); checks++;
  assert.deepEqual(before, [{ status: 'pending', receipt: null }]); checks++;
  // The rules the tables declare hold, under the names the application's conflict handling and the Drizzle schema use.
  const refused = async (sql: string, code: string, constraint?: string) => {
    await assert.rejects(() => target!.query(sql), (error: { code?: string; constraint?: string }) => { assert.equal(error.code, code); if (constraint) assert.equal(error.constraint, constraint); return true; });
    checks++;
  };
  await refused("INSERT INTO public.valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,status) VALUES('operation-b','lender-a','owner','Clerk:user_a','Finance','key-b','hash','{}','x','done')", '23514', 'valopay_operation_status');
  await refused("INSERT INTO public.valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES('member-b','workspace-a','user_b','Synthetic member','Owner',now())", '23514', 'valopay_staff_role');
  await refused("INSERT INTO public.valopay_staff_memberships(id,workspace_id,user_id,display_name,role,status,expires_at) VALUES('member-b','workspace-a','user_b','Synthetic member','Finance','gone',now())", '23514', 'valopay_staff_status');
  await refused("INSERT INTO public.valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES('member-b','workspace-a','user_a','Duplicate person','Finance',now())", '23505', 'valopay_staff_workspace_user');
  await refused("INSERT INTO public.valopay_teams VALUES('workspace-b','org_synthetic','Same organisation twice')", '23505', 'valopay_teams_organization_id_unique');
  await refused("INSERT INTO public.valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,status,expires_at) VALUES('invite-a','workspace-a','person@example.test','Finance','token','System','sent',now())", '23514', 'valopay_invitation_status');
  await refused("INSERT INTO public.valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) VALUES('operation-c','no-such-lender','owner','actor','Finance','key-c','hash','{}','x')", '23503', 'valopay_operations_merchant_id_valopay_merchants_id_fk');
  // Removing a lender removes its journal and its access grants, never a membership.
  await target.query("DELETE FROM public.valopay_merchants WHERE id='lender-a'");
  assert.equal((await target.query('SELECT count(*)::int AS count FROM public.valopay_operations')).rows[0].count, 0); checks++;
  assert.equal((await target.query('SELECT count(*)::int AS count FROM public.valopay_staff_lender_access')).rows[0].count, 0); checks++;
  assert.equal((await target.query('SELECT count(*)::int AS count FROM public.valopay_staff_memberships')).rows[0].count, 1); checks++;
  console.log(`Pilot workflow migration rehearsal passed (${checks} checks): fresh application matches the pushed schema, repeat application changes nothing, named checks, uniqueness and references hold, and removing a lender cascades to its journal and grants only.`);
} finally {
  await target?.end();
  if (created) await pool.query(`DROP DATABASE "${database}"`);
  await pool.end();
}
