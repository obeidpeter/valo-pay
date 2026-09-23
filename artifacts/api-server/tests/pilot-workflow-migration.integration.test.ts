// Rehearses lib/db/migrations/003_pilot_workflow.sql, 004_staff_lender_access.sql and
// 007_journal_and_lender_indexes.sql on a throwaway database, the way a host applies
// them: on a schema that does not carry the tables yet. The other database-backed suites run them after drizzle-kit push, where
// CREATE TABLE IF NOT EXISTS finds every table and the SQL is never exercised. The
// result must match the pushed schema exactly (columns, constraints, indexes), so a
// database built by either route behaves the same; the files must be repeatable and wait
// only so long for a lock; and the rules they declare must hold.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { requireCreateDatabase, requireLoopback, throwawayDatabaseName } from './throwaway-database';

if (process.env.VALOPAY_RUN_INTEGRATION !== '1') {
  console.log('Pilot workflow migration rehearsal requires a disposable local PostgreSQL instance.'); process.exit(0);
}
// Any loopback database whose login can create databases, carrying the pushed schema to compare with: the
// rehearsal builds its own throwaway database beside it.
const suite = 'Pilot workflow migration rehearsal';
const connection = new URL(process.env.DATABASE_URL || '');
requireLoopback(suite, connection);
const { pool, Pool } = await import('@workspace/db');
await requireCreateDatabase(suite, pool);
const database = throwawayDatabaseName(connection, 'pilot_rehearsal');
const targetUrl = new URL(connection); targetUrl.pathname = `/${database}`;
const files = ['003_pilot_workflow.sql', '004_staff_lender_access.sql', '007_journal_and_lender_indexes.sql'];
const migrations = await Promise.all(files.map((name) => readFile(new URL(`../../../lib/db/migrations/${name}`, import.meta.url), 'utf8')));
const [pilotWorkflow, lenderAccess] = migrations as [string, string, string];
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
/**
 * Runs a migration on a connection of its own, as psql does. A statement that fails leaves the file's transaction
 * aborted on that connection, so it is rolled back before the connection is used again; psql ends the session instead.
 */
async function apply(sql: string) {
  const client = await target!.connect();
  try { await client.query(sql); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
/**
 * Applies a migration while another transaction holds a write the migration's locks conflict with, as a request's
 * write transaction does: the migration gives up within its 5 s lock limit with nothing changed, instead of waiting
 * for the write and holding every later write on that table in the queue behind its own request.
 */
async function refusedWhileHeld(hold: string, sql: string, what: string) {
  const holder = await target!.connect();
  let timer: NodeJS.Timeout | undefined;
  try {
    await holder.query('BEGIN'); await holder.query(hold);
    const started = Date.now();
    const outcome = await Promise.race([
      apply(sql).then(() => 'applied', (error: { code?: string }) => error.code),
      new Promise<string>((resolve) => { timer = setTimeout(resolve, 20_000, 'still waiting'); }),
    ]);
    const waited = Date.now() - started;
    clearTimeout(timer);
    await holder.query('ROLLBACK');
    assert.equal(outcome, '55P03', `${what} gives up on a held lock (lock_not_available) instead of waiting for it`);
    assert.ok(waited >= 4_000 && waited < 15_000, `${what} waited ${waited} ms, its 5 s lock limit`);
    checks += 2;
  } finally { holder.release(); }
}
try {
  const pushed = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await shape(pool, table)]))), pushedLenderIndexes = await lenderIndexes(pool);
  for (const table of tables) assert.ok(pushed[table].columns.length, `${table} is missing from the pushed schema; run drizzle-kit push before this rehearsal`);
  // Each file limits how long it waits for a lock and how long a statement runs, first thing in its transaction.
  for (const [position, sql] of migrations.entries()) { assert.match(sql, /^BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';$/m, `${files[position]} sets its lock and statement limits`); checks++; }
  await pool.query(`CREATE DATABASE "${database}"`); created = true;
  target = new Pool({ connectionString: targetUrl.toString() });
  // The tables the migrations reference, as the earlier schema left them.
  await target.query('CREATE TABLE public.valopay_workspaces (id text PRIMARY KEY, principal_hash text NOT NULL, role text NOT NULL)');
  await target.query('CREATE TABLE public.valopay_merchants (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES public.valopay_workspaces(id), info jsonb NOT NULL, settings jsonb NOT NULL)');
  await target.query("INSERT INTO public.valopay_workspaces VALUES('workspace-a','hash-a','Admin')");
  await target.query(`INSERT INTO public.valopay_merchants VALUES('lender-a','workspace-a','{}','{}')`);
  // An open write on a lender used to hold 003 back until it committed, and every later write on a lender queued behind 003.
  await refusedWhileHeld(`UPDATE public.valopay_merchants SET settings='{"held":true}' WHERE id='lender-a'`, pilotWorkflow, '003');
  assert.equal((await target.query("SELECT to_regclass('public.valopay_operations') AS found")).rows[0].found, null, '003 refused changes nothing'); checks++;
  await apply(pilotWorkflow);
  await target.query("INSERT INTO public.valopay_teams VALUES('workspace-a','org_synthetic','Synthetic team')");
  await target.query("INSERT INTO public.valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES('member-a','workspace-a','user_a','Synthetic member','Finance',now()+interval '30 days')");
  await refusedWhileHeld("UPDATE public.valopay_staff_memberships SET display_name='Held member' WHERE id='member-a'", lenderAccess, '004');
  assert.equal((await target.query("SELECT to_regclass('public.valopay_staff_lender_access') AS found")).rows[0].found, null, '004 refused changes nothing'); checks++;
  for (const migration of migrations) await apply(migration);
  for (const table of tables) { assert.deepEqual(await shape(target, table), pushed[table], `${table} built by the migration differs from the pushed schema`); checks++; }
  assert.deepEqual(await lenderIndexes(target), pushedLenderIndexes, 'the lender indexes built by the migration differ from the pushed schema'); checks++;
  // Rows survive a repeat application, and the schema does not change.
  await target.query("INSERT INTO public.valopay_staff_lender_access(membership_id,merchant_id,granted_by) VALUES('member-a','lender-a','fixture')");
  await target.query("INSERT INTO public.valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) VALUES('operation-a','lender-a','owner','Clerk:user_a','Finance','key','hash','{}','Save records customers')");
  const before = (await target.query('SELECT status,receipt FROM public.valopay_operations WHERE id=$1', ['operation-a'])).rows;
  for (const migration of migrations) await apply(migration);
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
  console.log(`Pilot workflow migration rehearsal passed (${checks} checks): each file limits its lock wait and statements, and 003 and 004 give up on a held lock with nothing changed; fresh application matches the pushed schema, repeat application changes nothing, named checks, uniqueness and references hold, and removing a lender cascades to its journal and grants only.`);
} finally {
  await target?.end();
  if (created) await pool.query(`DROP DATABASE "${database}"`);
  await pool.end();
}
