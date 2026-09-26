// Owner-only rehearsal in an isolated schema of a disposable loopback database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { requireLoopback } from './throwaway-database';
if (process.env.VALOPAY_RUN_INTEGRATION !== '1') { console.log('Record identity migration requires disposable local PostgreSQL.'); process.exit(0); }
requireLoopback('Record identity migration', new URL(process.env.DATABASE_URL || ''));
const { pool } = await import('@workspace/db');
const { integrityGuards } = await import('../src/lib/valopay-store');
const migration = await readFile(new URL('../../../lib/db/migrations/009_record_identity_guards.sql', import.meta.url), 'utf8');
const schema = `valopay_identity_${randomBytes(8).toString('hex')}`;
const client = await pool.connect();
let checks = 0;
const insert = (id: string, kind: string, reference: string, data: Record<string, unknown> = {}, lender = 'lender-a') => client.query('INSERT INTO valopay_records VALUES ($1,$2,$3,$4,$5)', [id,lender,kind,reference,data]);
const indexRows = async () => (await client.query<{ name: string; definition: string }>(`SELECT c.relname AS name,regexp_replace(pg_get_indexdef(i.indexrelid), '^CREATE (UNIQUE )?INDEX \\S+ ON (ONLY )?\\S+ ', '') AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='valopay_records'::regclass ORDER BY c.relname`)).rows;
const refusedMigration = async (message: RegExp) => {
 const before = await indexRows(), rows = (await client.query('SELECT * FROM valopay_records ORDER BY id')).rows;
 await assert.rejects(client.query(migration), message);
 await client.query('ROLLBACK');
 assert.deepEqual(await indexRows(), before, 'a failed migration preserves all indexes');
 assert.deepEqual((await client.query('SELECT * FROM valopay_records ORDER BY id')).rows, rows, 'a failed migration preserves every source row'); checks++;
};
try {
 await client.query(`CREATE SCHEMA "${schema}"`);
 await client.query(`SET search_path TO "${schema}", pg_catalog`);
 await client.query('CREATE TABLE valopay_records (id text PRIMARY KEY,merchant_id text NOT NULL,kind text NOT NULL,reference text NOT NULL,data jsonb NOT NULL)');
 await client.query("CREATE UNIQUE INDEX valopay_unique_observation ON valopay_records (merchant_id,(data->>'source'),(data->>'eventId')) WHERE kind='observations' AND data->>'eventId' IS NOT NULL");
 await insert('customer-a','customers','SHARED'); await insert('customer-b','customers','SHARED');
 await refusedMigration(/Duplicate customer references/);
 await client.query("UPDATE valopay_records SET reference='OTHER' WHERE id='customer-b'");
 await insert('long-provider','observations','LONG',{provider:'x'.repeat(201),source:'webhook',eventId:'evt-long'});
 await refusedMigration(/exceeds 200 characters/);
 await client.query("UPDATE valopay_records SET data=jsonb_set(data,'{provider}','\"short-provider\"') WHERE id='long-provider'");
 await client.query(migration); checks++;
 const guards = integrityGuards.filter(guard => ['valopay_unique_customer_reference','valopay_unique_provider_event'].includes(guard.name));
 assert.deepEqual((await indexRows()).filter(row => guards.some(guard => guard.name === row.name)), guards.map(guard => ({name:guard.name,definition:guard.definition})).sort((a,b)=>a.name.localeCompare(b.name))); checks++;
 assert.ok(!(await indexRows()).some(row => row.name === 'valopay_unique_observation')); checks++;
 const first = await indexRows(); await client.query(migration); assert.deepEqual(await indexRows(), first); checks++;
 await assert.rejects(insert('customer-c','customers','SHARED'), (error: any) => error.code === '23505'); checks++;
 await insert('customer-other-lender','customers','SHARED',{},'lender-b'); checks++;
 await insert('event-a','observations','PA',{provider:'Provider A',source:'webhook',eventId:'evt-1'});
 await insert('event-b','observations','PB',{provider:'Provider B',source:'webhook',eventId:'evt-1'}); checks++;
 await assert.rejects(insert('event-a-duplicate','observations','PAD',{providerConnection:' PROVIDER A ',source:'webhook',eventId:'evt-1'}), (error: any) => error.code === '23505'); checks++;
 await insert('event-a-settlement','observations','PAS',{provider:'Provider A',source:'settlement',eventId:'evt-1'}); checks++;
 // Simulate an older database lacking a guard: duplicates must be refused, not silently removed by migration.
 await client.query('DROP INDEX valopay_unique_provider_event');
 await insert('event-conflict','observations','CONFLICT',{providerConnection:'provider a',source:'webhook',eventId:'evt-1'});
 await refusedMigration(/Duplicate provider delivery identities/);
 // A conflicting same-name index must not be accepted by IF NOT EXISTS.
 await client.query("UPDATE valopay_records SET data=jsonb_set(data,'{eventId}','\"evt-other\"') WHERE id='event-conflict'");
 await client.query('CREATE UNIQUE INDEX valopay_unique_provider_event ON valopay_records(id)');
 await refusedMigration(/not the reviewed definition/);
 console.log(`Record identity migration passed (${checks} checks): duplicate preflight, atomic rollback, scope/case equivalence, unchanged rows, exact definitions and repeat application.`);
} finally {
 await client.query('ROLLBACK').catch(()=>{});
 await client.query('RESET search_path');
 await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
 client.release(); await pool.end();
}
