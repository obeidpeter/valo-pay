import type { PoolClient } from '@workspace/db';
import { randomUUID } from 'node:crypto';
import { encryptField, decryptField, type FieldKeyRing } from './field-encryption';
import { sha256Hex as digest, requestFingerprint, auditEntryData } from './digests';

export interface PilotStagingScope { workspaceId: string; principalHash: string; tenantId: string; actor: string }
export interface StagingPool { connect(): Promise<PoolClient> }
export interface ProtectedNoteInput { recordId: string; note: string; expectedUpdatedAt: string; requestKey: string }
const refusal = (message: string, status = 403): never => { throw Object.assign(new Error(message), { status }); };

/** Isolated rehearsal repository. Never uses the sandbox pool or changes schema/grants. */
export function createPilotStagingStore(pool: StagingPool, schema: string, keyProvider: () => Promise<FieldKeyRing>) {
  if (!/^valopay_pilot_(?:test|staging)_[a-z0-9_]+$/.test(schema)) throw new Error('A dedicated pilot rehearsal schema is required.');
  const table = (name: string) => `"${schema}"."${name}"`;
  async function transaction<T>(scope: PilotStagingScope, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!scope.workspaceId || !scope.tenantId || !/^[a-f0-9]{64}$/.test(scope.principalHash) || !scope.actor) refusal('Provisioned database scope is required.');
    const client = await pool.connect(); let broken = false;
    try {
      await client.query('BEGIN');
      const login = (await client.query('SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=session_user')).rows[0];
      if (!login || login.rolsuper || login.rolbypassrls || login.rolcreaterole || login.rolcreatedb) refusal('The staging pool must use a restricted login.');
      await client.query('SET LOCAL ROLE valopay_pilot_app');
      const flags = (await client.query('SELECT c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname=$1 AND c.relname=ANY($2::text[])', [schema, ['valopay_workspaces', 'valopay_merchants', 'valopay_records', 'valopay_idempotency']])).rows;
      if (flags.length !== 4 || flags.some(row => !row.relrowsecurity || !row.relforcerowsecurity || row.owner === 'valopay_pilot_app' || row.owner === login.rolname)) refusal('Forced staging isolation requires tables owned outside the application login and role.');
      await client.query("SELECT set_config('valopay.workspace_id',$1,true),set_config('valopay.principal_hash',$2,true)", [scope.workspaceId, scope.principalHash]);
      const merchant = await client.query(`SELECT id FROM ${table('valopay_merchants')} WHERE id=$1 AND workspace_id=$2 FOR UPDATE`, [scope.tenantId, scope.workspaceId]);
      if (merchant.rowCount !== 1) refusal('This lender is not available.', 404);
      const result = await work(client);
      const commit = await client.query('COMMIT');
      if (commit.command !== 'COMMIT') throw new Error('Staging transaction was rolled back.');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }
  const readRecord = async (client: PoolClient, scope: PilotStagingScope, id: string) => {
    const row = (await client.query(`SELECT id,name,data,updated_at FROM ${table('valopay_records')} WHERE id=$1 AND merchant_id=$2 AND kind='customers'`, [id, scope.tenantId])).rows[0];
    if (!row) refusal('This customer is not available.', 404);
    return row;
  };
  const project = async (row: any, scope: PilotStagingScope) => {
    const protectedNote = row.data?.protectedStagingNote;
    if (protectedNote) {
      const note = decryptField(protectedNote, { tenantId: scope.tenantId, recordId: row.id, field: 'protectedStagingNote' }, await keyProvider());
      if (!note.startsWith('SYNTHETIC:')) refusal('The rehearsal record is invalid.');
    }
    return { id: row.id, name: row.name, updatedAt: new Date(row.updated_at).toISOString(), hasProtectedNote: !!protectedNote, note: protectedNote ? '[Protected synthetic note]' : null, syntheticOnly: true, liveOperationsAllowed: false };
  };
  return {
    read: (scope: PilotStagingScope, id: string) => transaction(scope, async client => project(await readRecord(client, scope, id), scope)),
    write: (scope: PilotStagingScope, input: ProtectedNoteInput) => transaction(scope, async client => {
      if (!input.note?.startsWith('SYNTHETIC:') || input.note.length > 2000 || !/^[A-Za-z0-9._:-]{16,200}$/.test(input.requestKey)) refusal('Use a synthetic note and a valid request key.', 400);
      const requestId = digest(`${scope.tenantId}:${scope.actor}:${input.requestKey}`);
      const fingerprint = requestFingerprint(input);
      const previous = (await client.query(`SELECT request_hash,response FROM ${table('valopay_idempotency')} WHERE id=$1 AND merchant_id=$2`, [requestId, scope.tenantId])).rows[0];
      if (previous) {
        if (previous.request_hash !== fingerprint) refusal('The request key was used with different input.', 409);
        return previous.response;
      }
      const row = await readRecord(client, scope, input.recordId);
      if (new Date(row.updated_at).toISOString() !== input.expectedUpdatedAt) refusal('The record changed. Reload it before editing.', 409);
      const envelope = encryptField(input.note, { tenantId: scope.tenantId, recordId: row.id, field: 'protectedStagingNote' }, await keyProvider());
      const updated = (await client.query(`UPDATE ${table('valopay_records')} SET data=jsonb_set(data,'{protectedStagingNote}',$1::jsonb),updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 millisecond') WHERE id=$2 AND merchant_id=$3 RETURNING id,name,data,updated_at`, [JSON.stringify(envelope), row.id, scope.tenantId])).rows[0];
      const previousAudit = (await client.query(`SELECT data FROM ${table('valopay_records')} WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::bigint DESC LIMIT 1`, [scope.tenantId])).rows[0]?.data;
      const now = new Date(updated.updated_at).toISOString();
      const entry = auditEntryData({ sequence: Number(previousAudit?.sequence || 0) + 1, actor: scope.actor, action: 'staging.protected_note', objectId: row.id, summary: 'Synthetic protected note saved', changes: envelope, previousHash: previousAudit?.hash || 'GENESIS', timestamp: now });
      await client.query(`INSERT INTO ${table('valopay_records')}(id,merchant_id,kind,name,status,customer_id,data,created_at,updated_at) VALUES($1,$2,'audit','staging.protected_note','recorded',$3,$4,$5,$5)`, [randomUUID(), scope.tenantId, row.id, entry, now]);
      const result = await project(updated, scope);
      await client.query(`INSERT INTO ${table('valopay_idempotency')}(id,merchant_id,request_hash,response) VALUES($1,$2,$3,$4)`, [requestId, scope.tenantId, fingerprint, result]);
      return result;
    }),
  };
}
export type PilotStagingStore = ReturnType<typeof createPilotStagingStore>;
