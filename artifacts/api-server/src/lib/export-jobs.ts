import { randomUUID } from 'node:crypto';
import type { Context, DomainState, ValopayRecord } from '../domain/types';
import { makeRecord } from '../domain/records';
import type { ExportInput } from './valopay-exports';

export const EXPORT_LEASE_MS = 5 * 60_000;
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
export const EXPORT_CONCURRENCY = 2;
export interface ExportLocation { bucket: string; objectName: string }
export interface ExportArtifact {
  checksum: string; contentType: string; byteLength: number; generationMs: number; generatedAt: string;
  events?: number; customerReference?: string;
}
export type ExportJobStatus = 'queued' | 'running' | 'ready' | 'failed';
export interface ExportJobView {
  id: string; status: ExportJobStatus; kind: string; format: string; customerId: string; requestedAt: string;
  attempts: number; downloadUrl: string; checksum?: string; generatedAt?: string; byteLength?: number; generationMs?: number; error?: string;
}
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };

export function findExportJob(state: DomainState, id: string): ValopayRecord {
  return state.records.find(record => record.kind === 'exports' && record.id === id) ?? fail('Export not found in this lender.', 404);
}
/** Internal storage identifiers and lease credentials are never sent to the console or exported as data. */
export function publicExportRecord(record: ValopayRecord): ValopayRecord {
  const { bucket: _bucket, objectName: _objectName, leaseToken: _token, leaseExpiresAt: _expiry, requestedRole: _role, ...data } = record.data;
  return { ...record, data };
}
export function exportJobView(record: ValopayRecord): ExportJobView {
  const ready = record.status === 'ready';
  return {
    id: record.id, status: record.status as ExportJobStatus, kind: String(record.data.kind), format: String(record.data.format), customerId: record.customerId,
    requestedAt: record.createdAt, attempts: Number(record.data.attempts || 0),
    downloadUrl: `/api/v1/exports/${record.id}/download?merchantId=${encodeURIComponent(record.merchantId)}`,
    ...(ready ? { checksum: String(record.data.checksum), generatedAt: String(record.data.generatedAt || record.createdAt), byteLength: Number(record.data.byteLength || 0), generationMs: Number(record.data.generationMs || 0) } : {}),
    ...(record.status === 'failed' ? { error: String(record.data.lastError || 'Export generation could not finish. Retry this export.') } : {}),
  };
}
/** Queueing writes metadata only; no rendering, object-storage calls or credentials belong in this transaction. */
export function queueExport(state: DomainState, ctx: Context, input: ExportInput, privateDirectory: string): ExportJobView {
  if (!privateDirectory || !/^\/?[^/]+\/.+/.test(privateDirectory)) fail('Private export storage is not configured. Contact the workspace administrator.', 503);
  if (input.customerId && !state.records.some(record => record.kind === 'customers' && record.id === input.customerId)) fail('Customer not found in this lender.', 404);
  if (state.records.filter(record => record.kind === 'exports' && ['queued', 'running'].includes(record.status)).length >= 10) fail('Ten exports are already waiting or running for this lender. Wait for one to finish before starting another.', 429);
  const id = randomUUID(), parts = privateDirectory.replace(/^\//, '').replace(/\/+$/, '').split('/'), bucket = parts.shift()!;
  const objectName = `${parts.join('/')}/exports/${state.merchant.id}/${id}.${input.format}`;
  return exportJobView(makeRecord(state, 'exports', { id, name: `${input.kind} · ${input.format.toUpperCase()}`, status: 'queued', customerId: input.customerId || '', createdAt: ctx.now, updatedAt: ctx.now,
    data: { kind: input.kind, format: input.format, usedInRealCase: false, requestedBy: ctx.actor, requestedRole: ctx.role, attempts: 0, bucket, objectName } }));
}
export function exportIsClaimable(record: ValopayRecord, now: string): boolean {
  return record.status === 'queued' || (record.status === 'running' && (!record.data.leaseExpiresAt || Date.parse(record.data.leaseExpiresAt) <= Date.parse(now)));
}
export function retryExport(state: DomainState, ctx: Context, id: string): ExportJobView {
  const record = findExportJob(state, id);
  if (record.status === 'ready' || record.status === 'queued') return exportJobView(record);
  if (record.status === 'running' && !exportIsClaimable(record, ctx.now)) return exportJobView(record);
  record.status = 'queued'; record.updatedAt = ctx.now;
  delete record.data.leaseToken; delete record.data.leaseExpiresAt; delete record.data.lastError;
  return exportJobView(record);
}

export interface ClaimedExport {
  merchantId: string; id: string; token: string; state: DomainState; context: Context; input: ExportInput; location: ExportLocation;
}
export interface ExportJobRepository {
  candidates(limit: number): Promise<Array<{ merchantId: string; id: string }>>;
  claim(merchantId: string, id: string): Promise<ClaimedExport | null>;
  finish(claim: ClaimedExport, artifact: ExportArtifact): Promise<boolean>;
  fail(claim: ClaimedExport, message: string): Promise<boolean>;
}
export interface ExportJobStorage {
  existing(claim: ClaimedExport): Promise<ExportArtifact | null>;
  put(claim: ClaimedExport, bytes: Buffer, artifact: ExportArtifact): Promise<void>;
}
/** The durable claim commits before rendering/upload; all outcomes are fenced by the claim's lease token. */
export async function processExportJob(repository: ExportJobRepository, storage: ExportJobStorage, generate: (claim: ClaimedExport) => Promise<{ bytes: Buffer; artifact: ExportArtifact }>, target: { merchantId: string; id: string }): Promise<'ready' | 'failed' | 'skipped'> {
  const claim = await repository.claim(target.merchantId, target.id);
  if (!claim) return 'skipped';
  try {
    let artifact = await storage.existing(claim);
    if (!artifact) {
      const generated = await generate(claim);
      if (generated.bytes.length > MAX_EXPORT_BYTES) throw Object.assign(new Error('Export exceeds the 32 MB file limit. Export a customer pack or a smaller record category.'), { exportTooLarge: true });
      try { await storage.put(claim, generated.bytes, generated.artifact); artifact = generated.artifact; }
      catch (error) {
        // An upload can commit while its acknowledgement is lost, or another expired lease can finish first.
        artifact = await storage.existing(claim);
        if (!artifact) throw error;
      }
    }
    return await repository.finish(claim, artifact) ? 'ready' : 'skipped';
  } catch (error) {
    const message = (error as { exportTooLarge?: boolean })?.exportTooLarge
      ? 'Export exceeds the 32 MB file limit. Export a customer pack or a smaller record category.'
      : 'Export generation could not finish. Retry this export. If it fails again, contact the workspace administrator.';
    // If the database is unavailable, leave the durable running lease to expire and recover on a later poll.
    try { await repository.fail(claim, message); } catch { /* durable lease recovery */ }
    return 'failed';
  }
}
