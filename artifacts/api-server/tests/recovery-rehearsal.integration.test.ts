import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { DomainState } from '../src/domain/types';

if (process.env.VALOPAY_RUN_INTEGRATION !== '1' || process.env.VALOPAY_RUN_RECOVERY !== '1') {
  console.log('Recovery rehearsal requires two opt-ins and a disposable local PostgreSQL instance.'); process.exit(0);
}
const connection = new URL(process.env.DATABASE_URL || '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname), 'recovery automation refuses remote database hosts');
assert.equal(connection.pathname, '/valopay', 'use the disposable CI database named valopay');
const { pool, Pool } = await import('@workspace/db');
const { seedMerchant } = await import('../src/lib/valopay-seed');
const { appendAudit, verifyAudit, canonical } = await import('../src/lib/valopay-store');
const { encryptField, decryptField, rotateField } = await import('../src/lib/field-encryption');
const { runDailyClose } = await import('../src/domain/actions');
const suffix = randomUUID().replaceAll('-', '');
const sourceName = `valopay_source_rehearsal_${suffix}`;
const targetName = `valopay_restore_rehearsal_${suffix}`;
const identifier = (value: string) => { assert.match(value, /^valopay_(?:source|restore)_rehearsal_[a-f0-9]{32}$/); return `"${value}"`; };
const forDatabase = (database: string) => { const url = new URL(connection); url.pathname = `/${database}`; return url.toString(); };
const pgEnv = (database: string) => ({ ...process.env, PGHOST: connection.hostname, PGPORT: connection.port || '5432', PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password), PGDATABASE: database });
const runPg = (command: string, args: string[], database: string) => {
  const result = spawnSync(command, args, { env: pgEnv(database), encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed during the disposable recovery rehearsal; no connection details are logged.`);
};
const tables = ['valopay_workspaces', 'valopay_merchants', 'valopay_records', 'valopay_idempotency'];
let source: InstanceType<typeof Pool> | undefined, target: InstanceType<typeof Pool> | undefined;
let sourceCreated = false, targetCreated = false;
const directory = await mkdtemp(join(tmpdir(), 'valopay-recovery-'));
const started = performance.now();
const oldKey = randomBytes(32), newKey = randomBytes(32);
try {
  await pool.query(`CREATE DATABASE ${identifier(sourceName)}`); sourceCreated = true;
  await pool.query(`CREATE DATABASE ${identifier(targetName)}`); targetCreated = true;
  source = new Pool({ connectionString: forDatabase(sourceName) });
  target = new Pool({ connectionString: forDatabase(targetName) });
  const schemaDump = join(directory, 'schema.dump');
  runPg('pg_dump', ['--format=custom', '--schema-only', '--no-owner', ...tables.map(table => `--table=public.${table}`), `--file=${schemaDump}`], 'valopay');
  runPg('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${sourceName}`, schemaDump], sourceName);
  const snapshotAt = new Date().toISOString();
  const expectedStates: DomainState[] = [];
  for (const index of [1, 2]) {
    const merchant = { id: `restore-merchant-${index}`, name: `Synthetic lender ${index}`, shortName: `L${index}`, segment: 'cooperative', mode: 'observation', status: 'sandbox', provider: 'Sandbox Rail', monthlyVolume: 10, killSwitch: false, preDataReady: false, preLiveReady: false };
    const state = seedMerchant(merchant.id, index === 2);
    state.merchant = merchant;
    const ctx = { role: 'Admin', actor: 'Synthetic recovery operator', now: snapshotAt };
    runDailyClose(state, ctx, 'manual');
    appendAudit(state, ctx, 'recovery.fixture', merchant.id, 'Synthetic recovery fixture');
    const record = state.records.find(item => item.kind === 'customers')!;
    record.data.protectedTest = encryptField(`SYNTHETIC: protected lender ${index}`, { tenantId: merchant.id, recordId: record.id, field: 'protectedTest' }, { activeKeyId: 'rehearsal-v1', keys: new Map([['rehearsal-v1', oldKey]]) });
    await source.query('INSERT INTO valopay_workspaces(id,principal_hash) VALUES($1,$2)', [`workspace-${index}`, `principal-${index}`]);
    await source.query('INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,$4)', [merchant.id, `workspace-${index}`, merchant, state.settings]);
    for (const item of state.records) await source.query('INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [item.id, merchant.id, item.kind, item.name, item.status, item.reference, item.amountKobo, item.customerId, item.data, item.createdAt, item.updatedAt]);
    await source.query('INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response) VALUES($1,$2,$3,$4)', [`key-${index}`, merchant.id, 'synthetic-fingerprint', { completed: true, recordId: record.id }]);
    expectedStates.push(state);
  }
  const sourceExport = Buffer.from('Synthetic export\nNo customer data\n');
  await writeFile(join(directory, 'export.source'), sourceExport);
  const dump = join(directory, 'synthetic.dump');
  const backupStart = performance.now();
  runPg('pg_dump', ['--format=custom', '--no-owner', `--file=${dump}`], sourceName);
  const backupMs = Math.round(performance.now() - backupStart);
  assert.equal(Number((await target.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n), 0, 'restore target is empty');
  const restoreStart = performance.now();
  runPg('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${targetName}`, dump], targetName);
  const restoreMs = Math.round(performance.now() - restoreStart);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const sourceRows: Record<string, any>[] = (await source.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    const restoredRows: Record<string, any>[] = (await target.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    assert.deepEqual(restoredRows, sourceRows, `${table}: every restored value matches the snapshot`);
    counts[table] = restoredRows.length;
  }
  for (const expected of expectedStates) {
    const rows: Record<string, any>[] = (await target.query('SELECT * FROM valopay_records WHERE merchant_id=$1 ORDER BY created_at,id', [expected.merchant.id])).rows;
    const restored: DomainState = { ...expected, records: rows.map(row => ({ id: row.id, merchantId: row.merchant_id, kind: row.kind, name: row.name, status: row.status, reference: row.reference, amountKobo: Number(row.amount_kobo), customerId: row.customer_id, data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() })) };
    assert.equal(verifyAudit(restored).valid, true);
    for (const kind of ['allocations', 'due-items', 'closes']) assert.equal(canonical(restored.records.filter(item => item.kind === kind).sort((a,b) => a.id.localeCompare(b.id))), canonical(expected.records.filter(item => item.kind === kind).sort((a,b) => a.id.localeCompare(b.id))));
    const customer = restored.records.find(item => item.kind === 'customers' && item.data.protectedTest)!;
    const scope = { tenantId: expected.merchant.id, recordId: customer.id, field: 'protectedTest' };
    const ring = { activeKeyId: 'rehearsal-v2', keys: new Map([['rehearsal-v1', oldKey], ['rehearsal-v2', newKey]]) };
    assert.match(decryptField(customer.data.protectedTest, scope, ring), /^SYNTHETIC:/);
    const rotated = rotateField(customer.data.protectedTest, scope, ring);
    assert.equal(decryptField(rotated, scope, ring), decryptField(customer.data.protectedTest, scope, ring));
    assert.throws(() => decryptField(customer.data.protectedTest, { ...scope, tenantId: 'wrong-lender' }, ring));
    assert.throws(() => decryptField(customer.data.protectedTest, scope, { activeKeyId: 'rehearsal-v2', keys: new Map([['rehearsal-v2', newKey]]) }));
  }
  await writeFile(join(directory, 'export.restored'), await readFile(join(directory, 'export.source')));
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(join(directory, 'export.restored'))), hash(sourceExport));
  const evidence = { version: 1, scope: 'disposable synthetic PostgreSQL and local export/key fixtures', snapshotAt, backupMs, restoreMs, totalMs: Math.round(performance.now() - started), counts, checks: ['all rows and settings', 'outstanding amounts and allocations', 'close snapshots', 'idempotency responses', 'audit chains', 'restored encrypted fields', 'key rotation and missing-key refusal', 'synthetic export checksum'], externalObjectStorageVerified: false, productionRestoreVerified: false };
  if (process.env.VALOPAY_REHEARSAL_REPORT) await writeFile(resolve(process.env.VALOPAY_REHEARSAL_REPORT), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  oldKey.fill(0); newKey.fill(0);
  await source?.end(); await target?.end();
  if (targetCreated) await pool.query(`DROP DATABASE ${identifier(targetName)}`);
  if (sourceCreated) await pool.query(`DROP DATABASE ${identifier(sourceName)}`);
  await pool.end();
  assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('valopay-recovery-'));
  await rm(directory, { recursive: true, force: true });
}
