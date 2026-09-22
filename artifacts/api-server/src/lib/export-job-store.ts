import { pool, type PoolClient } from '@workspace/db';
import { randomUUID } from 'node:crypto';
import type { Context, DomainState, ValopayRecord } from '../domain/types';
import { canonical, digest, SYSTEM_ACTOR_PREFIX } from './valopay-store';
import { EXPORT_LEASE_MS, EXPORT_CONFIRM_LEASE_MS, exportIsClaimable, type ClaimedExport, type ExportArtifact, type ExportJobRepository, type ExportWriteResult } from './export-jobs';
import { bindRuntimeService, runtimeExportRequesterAllowed } from './runtime-isolation';
import { beginStatement, checkOut, databaseLimits } from './database-limits';

type Scope = { id: string; workspace_id: string; principal_hash: string; info: DomainState['merchant']; settings: DomainState['settings']; now: Date };
type Row = { id: string; merchant_id: string; kind: string; name: string; status: string; reference: string; amount_kobo: number | string; customer_id: string; data: Record<string, any>; created_at: Date; updated_at: Date };
const recordOf = (row: Row): ValopayRecord => ({ id: row.id, merchantId: row.merchant_id, kind: row.kind, name: row.name, status: row.status, reference: row.reference, amountKobo: Number(row.amount_kobo), customerId: row.customer_id, data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const ownership = 'EXISTS (SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE m.id=$1 AND m.workspace_id=$2 AND w.principal_hash=$3)';
const actor = `${SYSTEM_ACTOR_PREFIX}export worker`;

/** This capability is system-only: every transaction derives the workspace and principal from its locked merchant.
 * The pool's checkout wait bounds the checkout, so a late connection never starts a background transaction, and
 * the worker limits bound what runs. */
async function transaction<T>(merchantId: string, work: (client: PoolClient, scope: Scope) => Promise<T>): Promise<T | null> {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  try {
    await client.query(beginStatement(databaseLimits().worker, 'ISOLATION LEVEL REPEATABLE READ'));
    await bindRuntimeService(client);
    const scope = (await client.query<Scope>(`SELECT m.id,m.workspace_id,w.principal_hash,m.info,m.settings,now() AS now
      FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id WHERE m.id=$1 FOR UPDATE OF m SKIP LOCKED`, [merchantId])).rows[0];
    if (!scope) { await client.query('ROLLBACK'); return null; }
    const result = await work(client, scope);
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new Error('Export job transaction did not commit.');
    return result;
  } catch (error) { try { await client.query('ROLLBACK'); } catch { /* disconnected */ } throw error; }
  finally { guard.release(); }
}
async function audit(client: PoolClient, scope: Scope, job: ValopayRecord, action: string, summary: string) {
  const tail = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.merchant_id=$1 AND r.kind='audit' AND ${ownership}
    ORDER BY (r.data->>'sequence')::bigint DESC LIMIT 1`, [scope.id, scope.workspace_id, scope.principal_hash])).rows.map(recordOf);
  const previous=tail[0];
  const sequence=previous?Number(previous.data.sequence)+1:1;
  if(!Number.isSafeInteger(sequence)||sequence<1)throw new Error('Invalid audit sequence.');
  const now=scope.now.toISOString();
  const body={sequence,actor,action,objectId:job.id,summary,changeDigest:digest(canonical({status:job.status,attempt:job.data.attempts,checksum:job.data.checksum})),previousHash:previous?.data.hash??'GENESIS',timestamp:now};
  const entry:ValopayRecord={id:randomUUID(),merchantId:scope.id,kind:'audit',name:action,status:'recorded',reference:'',amountKobo:0,customerId:job.customerId,createdAt:now,updatedAt:now,data:{...body,hash:digest(canonical(body))}};
  await client.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
    SELECT $4,$1,'audit',$5,$6,$7,$8,$9,$10,$11,$12 WHERE ${ownership}`,
  [scope.id, scope.workspace_id, scope.principal_hash, entry.id, entry.name, entry.status, entry.reference, entry.amountKobo, entry.customerId, entry.data, entry.createdAt, entry.updatedAt]);
  return entry;
}
async function writeJob(client: PoolClient, scope: Scope, job: ValopayRecord) {
  const result = await client.query(`UPDATE valopay_records r SET status=$5,data=$6,updated_at=GREATEST($7::timestamptz,r.updated_at+interval '1 millisecond')
    WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership}`,
  [scope.id, scope.workspace_id, scope.principal_hash, job.id, job.status, job.data, scope.now.toISOString()]);
  if (result.rowCount !== 1) throw new Error('Export job no longer belongs to this lender.');
}
async function complete(claim: ClaimedExport, artifact?: ExportArtifact, message?: string): Promise<ExportWriteResult> {
  const intendedReady = !!artifact;
  return await transaction(claim.merchantId, async (client, scope) => {
    const row = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership}`,
      [scope.id, scope.workspace_id, scope.principal_hash, claim.id])).rows[0];
    if (!row || row.status !== 'running' || row.data.leaseToken !== claim.token) return 'lost';
    const job = recordOf(row);
    if (artifact && !await runtimeExportRequesterAllowed(client, scope.workspace_id, scope.id, job.data.requestedBy, job.data.requestedRole)) {
      artifact = undefined; message = 'The original requester authority changed during export generation. Request new evidence after access is reviewed.';
    }
    job.status = artifact ? 'ready' : 'failed';
    job.data.stage = job.status; job.data.lastProgressAt = scope.now.toISOString();
    if (artifact) Object.assign(job.data, artifact);
    else job.data.lastError = message;
    delete job.data.leaseToken; delete job.data.leaseExpiresAt;
    if (artifact) delete job.data.lastError;
    await writeJob(client, scope, job);
    await audit(client, scope, job, artifact ? 'export.ready' : 'export.failed', artifact ? 'Private synthetic export is ready; its checksum is recorded.' : 'Export generation failed; the saved job can be retried.');
    return intendedReady && !artifact ? 'lost' : 'saved';
  }) ?? 'busy';
}

export const exportJobRepository: ExportJobRepository = {
  async candidates(limit) {
    // Bound checkout and the read itself so a queue scan cannot occupy both
    // worker slots forever. Claims still recheck ownership under the lender lock.
    const guard = await checkOut(() => pool.connect()), client = guard.client;
    try {
      await client.query(beginStatement(databaseLimits().worker, 'READ ONLY'));
      await bindRuntimeService(client);
      const targets = (await client.query<{ merchantId: string; id: string }>(`SELECT merchant_id AS "merchantId",id FROM valopay_records
      WHERE kind='exports' AND (status='queued' OR (status='running' AND COALESCE(data->>'leaseExpiresAt','') <= to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      ORDER BY created_at,id LIMIT $1`, [Math.max(1, Math.min(20, limit))])).rows;
      await client.query('COMMIT');
      return targets;
    } catch (error) { try { await client.query('ROLLBACK'); } catch { /* disconnected */ } throw error; }
    finally { guard.release(); }
  },
  async claim(merchantId, id) {
    return transaction(merchantId, async (client, scope) => {
      const row = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership}`,
        [scope.id, scope.workspace_id, scope.principal_hash, id])).rows[0];
      if (!row) return null;
      const job = recordOf(row), now = scope.now.toISOString();
      if (!exportIsClaimable(job, now)) return null;
      if (!await runtimeExportRequesterAllowed(client, scope.workspace_id, scope.id, job.data.requestedBy, job.data.requestedRole)) {
        job.status = 'failed'; job.data.lastError = 'The original requester no longer has the required lender access or role. Request new evidence after access is reviewed.';
        job.data.stage = 'failed'; job.data.lastProgressAt = now;
        delete job.data.leaseToken; delete job.data.leaseExpiresAt;
        await writeJob(client, scope, job); await audit(client, scope, job, 'export.access_changed', 'Export refused because its original requester authority changed.');
        return null;
      }
      const token = randomUUID();
      job.status = 'running'; Object.assign(job.data, { leaseToken: token, leaseExpiresAt: new Date(scope.now.getTime() + EXPORT_LEASE_MS).toISOString(), startedAt: now, stage: 'checking', lastProgressAt: now, attempts: Number(job.data.attempts || 0) + 1 });
      delete job.data.lastError;
      await writeJob(client, scope, job);
      await audit(client, scope, job, 'export.started', 'Claimed a saved export job; generation runs outside this transaction.');
      const records = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.merchant_id=$1 AND ${ownership}`, [scope.id, scope.workspace_id, scope.principal_hash])).rows.map(recordOf);
      const context: Context = { actor: String(job.data.requestedBy || actor), role: String(job.data.requestedRole || 'Read-only'), now };
      return { merchantId, id, token, state: { merchant: scope.info, settings: scope.settings, records }, context,
        input: { kind: String(job.data.kind), customerId: job.customerId || undefined, closeReviewId:job.data.closeReviewId, format: String(job.data.format) as 'pdf' | 'json' | 'csv' },
        location: { bucket: String(job.data.bucket), objectName: String(job.data.objectName) } };
    });
  },
  async progress(claim, stage) {
    if (!['rendering','uploading','confirming'].includes(stage)) throw new Error('Invalid worker progress stage.');
    return await transaction(claim.merchantId, async (client, scope) => {
      const row = (await client.query<Row>(`SELECT r.* FROM valopay_records r WHERE r.id=$4 AND r.merchant_id=$1 AND r.kind='exports' AND ${ownership}`, [scope.id, scope.workspace_id, scope.principal_hash, claim.id])).rows[0];
      if (!row || row.status !== 'running' || row.data.leaseToken !== claim.token) return 'lost';
      const job = recordOf(row);
      job.data.stage = stage; job.data.lastProgressAt = scope.now.toISOString();
      // The file is already durable at this stage. A crashed confirmation can
      // be adopted shortly, with the same object/key, without waiting five minutes.
      if (stage === 'confirming') job.data.leaseExpiresAt = new Date(scope.now.getTime() + EXPORT_CONFIRM_LEASE_MS).toISOString();
      await writeJob(client, scope, job);
      return 'saved';
    }) ?? 'busy';
  },
  finish: (claim, artifact) => complete(claim, artifact),
  fail: (claim, message) => complete(claim, undefined, message),
};
