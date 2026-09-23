import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context, DomainState, ValopayRecord } from '../domain/types';
import { makeRecord } from '../domain/records';
import type { ExportInput } from './valopay-exports';
import { reviewedCloseEvidence } from '../domain/close-review';
import { sensitiveExportKinds, sensitiveExportRefusal } from '@workspace/valopay-schema';
import { rolePermits } from './pilot-access';

export const EXPORT_LEASE_MS = 5 * 60_000;
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
export const EXPORT_CONCURRENCY = 2;
export const EXPORT_STALL_MS = 2 * 60_000;
export const EXPORT_ATTEMPT_MS = 4 * 60_000;
export const EXPORT_CONFIRM_LEASE_MS = 30_000;
export const EXPORT_WRITE_ATTEMPTS = 6;
export const EXPORT_WRITE_BACKOFF_MS = 200;
/** Exports one lender may have waiting or running at once. */
export const EXPORT_QUEUE_LIMIT = 10;
/**
 * The seconds a request refused at the queue limit is told to wait
 * (Retry-After): the worker looks every 1.5 s and runs two exports at once, so
 * one of ten normally finishes well within this, and a stalled one is flagged
 * after two minutes rather than holding every caller for that long.
 */
export const EXPORT_QUEUE_RETRY_AFTER_SECONDS = 30;
export type ExportStage = 'queued' | 'checking' | 'rendering' | 'uploading' | 'confirming' | 'ready' | 'failed';
export type ExportWriteResult = 'saved' | 'busy' | 'lost';
export interface ExportLocation { bucket: string; objectName: string }
export interface ExportArtifact {
  checksum: string; contentType: string; byteLength: number; generationMs: number; generatedAt: string;
  events?: number; customerReference?: string;
}
export type ExportJobStatus = 'queued' | 'running' | 'ready' | 'failed';
export interface ExportJobView {
  expiredAt?: string;
  id: string; status: ExportJobStatus; kind: string; format: string; customerId: string; requestedAt: string;
  attempts: number; downloadUrl: string; checksum?: string; generatedAt?: string; byteLength?: number; generationMs?: number; error?: string;
  stage: ExportStage; lastProgressAt: string; stalled: boolean; retryAllowed: boolean; recoveryAt?: string;
}
const fail = (message: string, status: number, details: { retryAfterSeconds?: number } = {}): never => { throw Object.assign(new Error(message), { status }, details); };

/** export_sensitive (lib/pilot-access.ts): a dispute pack, the customer register or the audit trail is queued, retried and downloaded only by an Admin, Finance or Compliance reviewer; anyone else is refused (403) in plain words. */
export function assertExportPermitted(role: string, kind: unknown): void {
  if ((sensitiveExportKinds as readonly unknown[]).includes(kind) && !rolePermits(role, 'export_sensitive')) fail(sensitiveExportRefusal, 403);
}
export function findExportJob(state: DomainState, id: string): ValopayRecord {
  return state.records.find(record => record.kind === 'exports' && record.id === id) ?? fail('Export not found in this lender.', 404);
}
/** Internal storage identifiers and lease credentials are never sent to the console or exported as data. */
export function publicExportRecord(record: ValopayRecord): ValopayRecord {
  const { bucket: _bucket, objectName: _objectName, leaseToken: _token, leaseExpiresAt: _expiry, requestedRole: _role, ...data } = record.data;
  return { ...record, data };
}
export function exportHealth(record: ValopayRecord, now: string) {
  const active = record.status === 'queued' || record.status === 'running';
  const lastProgressAt = String(record.data.lastProgressAt || record.data.startedAt || record.updatedAt);
  const expired = record.status === 'running' && (!record.data.leaseExpiresAt || Date.parse(record.data.leaseExpiresAt) <= Date.parse(now));
  return { lastProgressAt, stalled: active && (expired || Date.parse(now) - Date.parse(lastProgressAt) >= EXPORT_STALL_MS), retryAllowed: !record.data.fileDeletedAt && (record.status === 'failed' || expired), ...(record.status === 'running' && record.data.leaseExpiresAt ? { recoveryAt: String(record.data.leaseExpiresAt) } : {}) };
}
export function exportJobView(record: ValopayRecord, now = new Date().toISOString()): ExportJobView {
  const ready = record.status === 'ready';
  return {
    id: record.id, status: record.status as ExportJobStatus, kind: String(record.data.kind), format: String(record.data.format), customerId: record.customerId,
    requestedAt: record.createdAt, attempts: Number(record.data.attempts || 0),
    stage: ['queued','ready','failed'].includes(record.status) ? record.status as ExportStage : ['checking','rendering','uploading','confirming'].includes(record.data.stage) ? record.data.stage : 'checking',
    ...exportHealth(record, now),
    ...(record.data.fileDeletedAt ? {expiredAt:String(record.data.fileDeletedAt)} : {}),
    downloadUrl: `/api/v1/exports/${record.id}/download?merchantId=${encodeURIComponent(record.merchantId)}`,
    ...(ready ? { checksum: String(record.data.checksum), generatedAt: String(record.data.generatedAt || record.createdAt), byteLength: Number(record.data.byteLength || 0), generationMs: Number(record.data.generationMs || 0) } : {}),
    ...(record.status === 'failed' ? { error: String(record.data.lastError || 'Export generation could not finish. Retry this export.') } : {}),
  };
}
/** Queueing writes metadata only; no rendering, object-storage calls or credentials belong in this transaction. */
export function queueExport(state: DomainState, ctx: Context, input: ExportInput, privateDirectory: string): ExportJobView {
  // A sensitive kind is refused first, so a Read-only person is not told they may download it.
  assertExportPermitted(ctx.role, input.kind);
  if (ctx.role === 'Read-only') fail('Your read-only role may download existing exports. Ask a colleague to generate new evidence.', 403);
  const review = input.kind === 'reviewed-close' ? reviewedCloseEvidence(state, input.closeReviewId || '', true) : undefined;
  if (!privateDirectory || !/^\/?[^/]+\/.+/.test(privateDirectory)) fail('Private export storage is not configured. Contact the workspace administrator.', 503);
  if (input.customerId && !state.records.some(record => record.kind === 'customers' && record.id === input.customerId)) fail('Customer not found in this lender.', 404);
  if (state.records.filter(record => record.kind === 'exports' && ['queued', 'running'].includes(record.status)).length >= EXPORT_QUEUE_LIMIT) fail('Ten exports are already waiting or running for this lender. Wait for one to finish before starting another.', 429, { retryAfterSeconds: EXPORT_QUEUE_RETRY_AFTER_SECONDS });
  const id = randomUUID(), parts = privateDirectory.replace(/^\//, '').replace(/\/+$/, '').split('/'), bucket = parts.shift()!;
  const objectName = `${parts.join('/')}/exports/${state.merchant.id}/${id}.${input.format}`;
  return exportJobView(makeRecord(state, 'exports', { id, name: `${input.kind} · ${input.format.toUpperCase()}`, status: 'queued', customerId: input.customerId || '', createdAt: ctx.now, updatedAt: ctx.now,
    data: { kind: input.kind, format: input.format, usedInRealCase: false, requestedBy: ctx.actor, requestedRole: ctx.role, attempts: 0, bucket, objectName, stage: 'queued', lastProgressAt: ctx.now,
      ...(review ? {closeReviewId:review.id,closeSnapshotDigest:review.data.snapshotDigest} : {}) } }), ctx.now);
}
export function exportIsClaimable(record: ValopayRecord, now: string): boolean {
  return record.status === 'queued' || (record.status === 'running' && (!record.data.leaseExpiresAt || Date.parse(record.data.leaseExpiresAt) <= Date.parse(now)));
}
export function retryExport(state: DomainState, ctx: Context, id: string): ExportJobView {
  const record = findExportJob(state, id);
  assertExportPermitted(ctx.role, record.data.kind);
  if (ctx.role === 'Read-only') fail('Your read-only role may download existing exports. Ask a colleague to retry evidence generation.', 403);
  if(record.data.fileDeletedAt)fail('This export file expired under the retention policy. Start a new export if current evidence is needed.',410);
  if (record.status === 'ready' || record.status === 'queued') return exportJobView(record, ctx.now);
  if (record.status === 'running' && !exportIsClaimable(record, ctx.now)) return exportJobView(record, ctx.now);
  returnExportToQueue(record, ctx.now);
  return exportJobView(record, ctx.now);
}
/** Back to the queue with the same request, attempts and private object identity; only the lease and last error are cleared. */
export function returnExportToQueue(record: ValopayRecord, now: string): void {
  record.status = 'queued'; record.updatedAt = now;
  record.data.stage = 'queued'; record.data.lastProgressAt = now;
  delete record.data.leaseToken; delete record.data.leaseExpiresAt; delete record.data.lastError;
}

export interface ClaimedExport {
  merchantId: string; id: string; token: string; state: DomainState; context: Context; input: ExportInput; location: ExportLocation;
}
export interface ExportJobRepository {
  candidates(limit: number): Promise<Array<{ merchantId: string; id: string }>>;
  claim(merchantId: string, id: string): Promise<ClaimedExport | null>;
  progress?(claim: ClaimedExport, stage: ExportStage): Promise<ExportWriteResult>;
  finish(claim: ClaimedExport, artifact: ExportArtifact): Promise<ExportWriteResult>;
  fail(claim: ClaimedExport, message: string): Promise<ExportWriteResult>;
  /** A stopping worker hands its claim back: queued again, fenced by the lease token, never marked failed. */
  release(claim: ClaimedExport): Promise<ExportWriteResult>;
}
/** 'released': a stopping worker returned the job to the queue. 'interrupted': it stopped and could not, so the job
 * keeps its lease and a later poll recovers it once the lease expires. */
export type ExportAttemptResult = 'ready' | 'failed' | 'skipped' | 'released' | 'interrupted';
export interface ExportJobStorage {
  existing(claim: ClaimedExport, signal?: AbortSignal): Promise<ExportArtifact | null>;
  put(claim: ClaimedExport, bytes: Buffer, artifact: ExportArtifact, signal?: AbortSignal): Promise<void>;
}
/** Await every write, retry only lock contention and stop on a superseding lease. */
export async function retryExportWrite(write: () => Promise<ExportWriteResult>, signal?: AbortSignal, backoffMs = EXPORT_WRITE_BACKOFF_MS): Promise<ExportWriteResult> {
  for (let attempt = 0; attempt < EXPORT_WRITE_ATTEMPTS; attempt++) {
    signal?.throwIfAborted();
    const result = await write();
    if (result !== 'busy' || attempt === EXPORT_WRITE_ATTEMPTS - 1) return result;
    await delay(backoffMs * (attempt + 1), undefined, { signal });
  }
  return 'busy';
}
/** The durable claim commits before rendering/upload; all outcomes are fenced by the claim's lease token. */
export async function processExportJob(repository: ExportJobRepository, storage: ExportJobStorage, generate: (claim: ClaimedExport, signal?: AbortSignal) => Promise<{ bytes: Buffer; artifact: ExportArtifact }>, target: { merchantId: string; id: string }, options: { signal?: AbortSignal; timeoutMs?: number; backoffMs?: number } = {}): Promise<ExportAttemptResult> {
  options.signal?.throwIfAborted();
  const claim = await repository.claim(target.merchantId, target.id);
  if (!claim) return 'skipped';
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(new Error('Export attempt timed out.')), options.timeoutMs ?? EXPORT_ATTEMPT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  const write = (fn: () => Promise<ExportWriteResult>) => retryExportWrite(fn, signal, options.backoffMs);
  const progress = async (stage: ExportStage) => !repository.progress || await write(() => repository.progress!(claim, stage)) === 'saved';
  try {
    signal.throwIfAborted();
    let artifact = await storage.existing(claim, signal);
    if (!artifact) {
      if (!await progress('rendering')) return 'skipped';
      const generated = await generate(claim, signal);
      signal.throwIfAborted();
      if (generated.bytes.length > MAX_EXPORT_BYTES) throw Object.assign(new Error('Export exceeds the 32 MB file limit. Export a customer pack or a smaller record category.'), { exportTooLarge: true });
      if (!await progress('uploading')) return 'skipped';
      try { await storage.put(claim, generated.bytes, generated.artifact, signal); artifact = generated.artifact; }
      catch (error) {
        // An upload can commit while its acknowledgement is lost, or another expired lease can finish first.
        signal.throwIfAborted();
        artifact = await storage.existing(claim, signal);
        if (!artifact) throw error;
      }
    }
    signal.throwIfAborted();
    if (!await progress('confirming')) return 'skipped';
    return await write(() => repository.finish(claim, artifact!)) === 'saved' ? 'ready' : 'skipped';
  } catch (error) {
    // The worker is stopping (options.signal, not the attempt's own timeout), which says nothing about the export:
    // hand the claim back for the next worker. If that write cannot be made, the lease expires and a later poll recovers it.
    if (options.signal?.aborted) {
      try {
        const released = await retryExportWrite(() => repository.release(claim), undefined, options.backoffMs);
        return released === 'saved' ? 'released' : released === 'lost' ? 'skipped' : 'interrupted';
      } catch { return 'interrupted'; }
    }
    const message = (error as { exportPdfFieldTooLarge?: boolean })?.exportPdfFieldTooLarge
      ? 'A field is too long to lay out safely in PDF. Choose JSON or CSV to preserve the complete record.'
      : (error as { exportTooLarge?: boolean })?.exportTooLarge
      ? 'Export exceeds the 32 MB file limit. Export a customer pack or a smaller record category.'
      : 'Export generation could not finish. Retry this export. If it fails again, contact the workspace administrator.';
    // A stop is handled above. If the database is unavailable, leave the durable running lease to expire and recover on a later poll.
    try { await retryExportWrite(() => repository.fail(claim, message), undefined, options.backoffMs); } catch { /* durable lease recovery */ }
    return 'failed';
  } finally { clearTimeout(timer); }
}
