import { historySections, historyKind, positionNote, type CustomerHistoryQuery, type HistorySection } from './customer-history';
import { pool, Pool, poolSize, type PoolClient } from "@workspace/db";
import * as tables from "@workspace/db/schema";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getAuth, clerkClient } from "@clerk/express";
import { signedInUser, staffMode, verifyStaff } from './staff-access';
import { validateLenderAccessChange } from './staff-lender-access';
import { bindRuntimeIdentity, bindRuntimeService, clearRuntimeInviteeGrants, runtimeIsolationConfiguration, runtimeIsolationEnabled, runtimeServiceRead } from './runtime-isolation';
import type { StaffLenderAccessInput } from '@workspace/valopay-schema';
import type { VerifiedClerkSession } from './pilot-access';
import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { approvalRoles, closeTimeOf, definitiveRefusalStatuses, grantNeedsApproval, invitationAcceptedSchema, nextCloseInstant, sameJson } from "@workspace/valopay-schema";
import { sha256Hex, canonicalDigest, requestFingerprint, auditEntryData, verifyAuditChain } from "./digests";
import { recordChanged, nextRecordVersion } from "./edit-versions";
import { contractAnswer } from './contract';
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { recordsOf } from "../domain/records";
import { nextCloseRetry, type CloseRetry } from "../domain/close";
import { seedMerchant } from "./valopay-seed";
import { createSandboxCreationLimits, creationRefusalMessage, WORKSPACE_CREATION_RETRY_AFTER_SECONDS } from "./creation-limit";
import { readSandboxCookie, sandboxPrincipal, secureRequest, writeSandboxCookie } from "./sandbox-cookie";
import { rememberSandbox } from "./request-limits";
import { foldForSearch, LIST_PAGE_CEILING, type ListQuery } from "./valopay-list";
import { queueView, queueViews, type QueueName, type QueueQuery } from './valopay-queues';
import { validateCloseRange, pageOffset, type ReadPageQuery, type ReconciliationQueue } from './console-read-models';
import { precisionAudit } from '../domain/reports';
import { periodBounds, previousMonth } from '../domain/billing';
import { measurementRules } from '@workspace/valopay-schema';
import { protectStored, revealStored, protectRecordData, revealRecordsData, payloadEncryptionKey, isProtectedPayload, PROTECTED_IMPORT_FIELDS, type ProtectedImportField } from './protected-payloads';
import { markRolledBack } from './transaction-outcome';
import { markOperationClosed, markOperationState, type OperationState } from './refused-operations';
import { beginStatement, checkOut, databaseLimits, failedTransaction, DatabaseLimitError, type Checkout } from './database-limits';
import { createLenderGate } from './lender-gate';
import { assertImportedCorrectionChange } from '../domain/import-corrections';
import type { LifecycleExternalCandidate, LifecycleCandidate } from '@workspace/valopay-schema';
import { lifecycleCandidateCheck, eraseLifecycleRawCsv, recordLifecycleReceipt, lifecycleRunView } from '../domain/lifecycle';
import { deleteRetainedExport } from './export-download';
import { objectStorageClient } from './objectStorage';
import { assertProviderEventChange } from '../providers/paystack-inbox';

/** The demo persona roles, the same list as the shared schema's. */
export const roles = ["Admin", "Operations", "Finance", "Compliance reviewer", "Read-only"];
/** SHA-256 of a string, as hex. */
export const digest = sha256Hex;

type WorkspaceRow = { id: string; principal_hash: string; role: string };
/**
 * The lender as a write transaction loaded it, one JSON string per record.
 * A save serialises the lender once more and compares strings: whatever is
 * identical is untouched, so checks, versions, audit digests and writes look
 * only at what the request changed.
 */
type StateSnapshot = { merchant: string; settings: string; records: Map<string, string> };
const snapshotOf = (state: DomainState): StateSnapshot => ({
  merchant: JSON.stringify(state.merchant), settings: JSON.stringify(state.settings),
  records: new Map(state.records.map((record) => [record.id, JSON.stringify(record)])),
});
/**
 * One JSON pass: the records added or changed since the lender was loaded,
 * and the IDs left untouched. Only a record whose JSON differs is compared in
 * canonical form (recordChanged), so a reordering of keys is not a change.
 */
function changesSince(snapshot: StateSnapshot, state: DomainState): { changed: ValopayRecord[]; unchanged: Set<string> } {
  const changed: ValopayRecord[] = [], unchanged = new Set<string>();
  for (const record of state.records) {
    const loaded = snapshot.records.get(record.id);
    if (loaded !== undefined && !recordChanged(loaded, record)) unchanged.add(record.id);
    else changed.push(record);
  }
  return { changed, unchanged };
}
/** Every changed stored record gets a strictly newer version, even when two actions share a millisecond. */
function advanceChanged(snapshot: StateSnapshot, changed: ValopayRecord[], now: string): void {
  for (const record of changed) {
    const original = snapshot.records.get(record.id);
    if (original === undefined) continue;
    record.updatedAt = nextRecordVersion(record, (JSON.parse(original) as ValopayRecord).updatedAt, now);
  }
}
type MerchantRow = { id: string; info: DomainState["merchant"]; settings: Record<string, any> };
type RecordRow = {
  id: string; merchant_id: string; kind: string; name: string; status: string; reference: string;
  amount_kobo: string | number; customer_id: string; data: Record<string, any>; created_at: Date; updated_at: Date;
};
type Session = {
  client: PoolClient; workspace: WorkspaceRow; principal: string; active: boolean;
  access: WorkspaceAccess;
  lockedMerchantId?: string; snapshot?: StateSnapshot; summarised?: Set<string>;
  owner?: string; operationId?: string; userId?: string; organizationId?: string;
  /** This transaction passed the restricted-database self-check (runtime isolation). */
  isolationVerified?: boolean;
};

/**
 * This is an opaque transaction capability.  Its database handle and locked
 * merchant are deliberately private to this module; a route cannot construct a
 * useful context or issue an unscoped query.
 */
export interface StoreContext extends Context {
  readonly authenticated: boolean;
  readonly accessMode?: 'sandbox' | 'staff';
}
const sessions = new WeakMap<StoreContext, Session>();
const requestOperations = new WeakMap<Request, { id: string; merchantId: string; created: boolean }>();
/** Binds a request to its journal entry; `created` says this attempt created the entry (prepareOperation). */
export function bindOperation(req: Request, id: string, merchantId: string, created = false) { requestOperations.set(req, { id, merchantId, created }); }
/** The journal entry the recovery middleware bound to this request, if any. */
export function boundOperation(req: Request) { return requestOperations.get(req); }
const databaseConflictCodes = new Set(["23503", "23505", "23514", "P0001"]);
/** One workspace's requests for one lender hold at most half this process's connections; a request past that waits, without one, for up to the lock limit. */
const lenderGate = createLenderGate({ capacity: Math.max(1, Math.floor(poolSize / 2)), waitMs: () => databaseLimits().request.lockMs });
/**
 * The gate lane of the lender a request names: every lender-scoped route
 * carries it as the merchantId query value. The value is read before anything
 * is authorised, so the lane is the caller's own (the staff organisation, or
 * the sandbox principal) as well as the lender's: a caller that names another
 * tenant's lender only queues behind its own requests, never that tenant's.
 */
function gatedLender(req: Request, principal: string): string | undefined {
  const lender = (req.query as Record<string, unknown> | undefined)?.merchantId;
  if (typeof lender !== "string" || lender.length < 1 || lender.length > 100) return undefined;
  const caller = staffMode() ? `org:${getAuth(req).orgId || ""}` : `principal:${principal}`;
  return `${caller}\u0000${lender}`;
}

/** Throws an error carrying the HTTP status the error handler answers with (400 unless given). */
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
const conflict = (message = "Operation conflicts with the current lender state."): never => fail(message, 409);
/** Anonymous sandboxes expire after this many days without a change; the cookie carries the same lifetime. */
export const ANONYMOUS_WORKSPACE_DAYS = 30;
/** Lenders a sandbox workspace can hold, the two samples included, so one visitor cannot fill the scheduler's queue. */
export const SANDBOX_LENDER_LIMIT = 5;
/** How many expired sandboxes one bootstrap removes, so a request never pays for a large backlog. */
const SWEEP_BATCH = 5;
/** Automatic deletion is opt-in so importing the application cannot remove existing workspaces. */
export const expiredWorkspaceCleanupEnabled = (value: string | undefined) => value === "on";
/** Actor prefix for platform-initiated changes (the seed, the scheduled close); the expiry sweep does not count them as sandbox activity. */
export const SYSTEM_ACTOR_PREFIX = "System · ";
/** A UTC ISO instant as the platform writes it; guards the timestamptz cast on the stored close cursor. */
const ISO_INSTANT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$";
const sandboxCreation = createSandboxCreationLimits();

export interface StoredRequest { method: 'POST' | 'PATCH'; path: string; body: unknown; }
type OperationRow = { id: string; merchant_id: string; owner: string; actor: string; role: string; request_key: string; request_hash: string; request: StoredRequest; label: string; status: string; receipt: any; created_at: Date; updated_at: Date };
const operationView = (row: OperationRow) => ({ id: row.id, label: row.label, actor: row.actor, role: row.role, status: row.status,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  message: row.status === 'completed' ? 'The service saved this request.'
    : row.status === 'cancelled' ? (row.receipt?.rejected ? `The service refused this request: ${row.receipt.rejected.message} Correct it and submit it again.` : 'Cancelled before completion. This request cannot run again.')
    : 'Completion has not been confirmed. Check the original request.',
  // Only a compact result reference. Original payloads and export locations stay private.
  recordId: textOrNull(row.receipt?.record?.id) ?? textOrNull(row.receipt?.id),
  recordKind: textOrNull(row.receipt?.record?.kind) ?? textOrNull(row.receipt?.kind) });
/** A receipt field as the journal names it: text, or null for anything else (a sealed receipt, a count, nothing). */
function textOrNull(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

/** The lock of one journal entry: the attempt running its request holds it for its whole transaction (holdOperation). */
const OPERATION_LOCK = "hashtextextended('valopay.operation:' || $1, 0)";
/**
 * The journal entry of a keyed request: the one its key already has, or a new
 * pending one. An existing entry is read without the lender's lock, so a repeat
 * of a saved or running request is never turned away by a busy lender before
 * it can be answered for its key. A new entry is made under a lock of the
 * person's own in that lender, so the pending limit holds and a duplicate sent
 * at the same moment binds the same entry (the entry's reference to the lender
 * still waits for a write holding the lender). `created` says whether this
 * attempt made the entry: only that attempt, or a definitive refusal, may close
 * it (rejectOperation). `unused` is told, just before a new entry is made, that
 * nothing is saved under the key (no entry and no stored answer), so a failure
 * that follows may say nothing was saved.
 */
export async function prepareOperation(ctx: StoreContext, merchantId: string, key: string, request: StoredRequest, unused?: () => void): Promise<{ id: string; created: boolean }> {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  const owner = session.owner || session.principal, id = digest(`operation:${merchantId}:${owner}:${key}`);
  const hash = requestFingerprint(request);
  const existing = async () => {
    const prior = (await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [id, merchantId, owner])).rows[0];
    if (!prior) return undefined;
    if (prior.request_hash !== hash) fail('This request key belongs to a different request. Recover the original request first.', 409);
    // A cancelled entry is final (completeOperation refuses it), whatever the role now: the answer says so, and the
    // person who sent it hears the original reason.
    if (prior.status === 'cancelled') throw markOperationClosed(Object.assign(new Error(await cancelledRefusal(ctx, merchantId, prior)), { status: 409 }));
    if (prior.actor !== ctx.actor || prior.role !== ctx.role) fail('Return to the original role before checking this request.', 403);
    return { id: prior.id, created: false };
  };
  const found = await existing();
  if (found) return found;
  await session.client.query("SELECT pg_advisory_xact_lock(hashtextextended('valopay.operations:' || $1 || ':' || $2, 0))", [merchantId, owner]);
  // Another attempt with the key may have created the entry while this one waited.
  const raced = await existing();
  if (raced) return raced;
  if (!(await receiptStored(session.client, merchantId, key, id))) unused?.();
  if (ctx.role === 'Read-only') fail('Your read-only role cannot submit operations.', 403);
  const count = Number((await session.client.query<{ count: string }>("SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2 AND status='pending'", [merchantId, owner])).rows[0]!.count);
  if (count >= 100) fail('Review your pending operations before submitting more requests.', 409);
  const label = request.path.includes('/actions') && request.body && typeof request.body === 'object'
    ? String((request.body as { action?: unknown }).action || 'Workspace action').replaceAll('_', ' ').slice(0, 100)
    : `${request.method === 'PATCH' ? 'Update' : 'Save'} ${request.path.split('/').filter(Boolean).slice(1, 3).join(' ').replaceAll('-', ' ')}`;
  await session.client.query(`INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [id, merchantId, owner, ctx.actor, ctx.role, key, hash, await protectStored(request,{lender:merchantId,record:id,field:'request'}), label, ctx.now]);
  return { id, created: true };
}
/**
 * A journaled write holds its entry, before it waits for the lender, until its
 * transaction ends. A repeat of the request meanwhile (a double submission, a
 * retry after a lost answer) is turned away at once as still running (503 with
 * Retry-After) and leaves the entry to the attempt running it: it neither waits
 * for that attempt nor closes the entry when its own wait fails.
 */
async function holdOperation(session: Session): Promise<void> {
  const held = (await session.client.query<{ held: boolean }>(`SELECT pg_try_advisory_xact_lock(${OPERATION_LOCK}) AS held`, [session.operationId])).rows[0]?.held;
  if (!held) throw markRolledBack(new DatabaseLimitError('operation_running'));
}
/** Why a cancelled request cannot run again, in the words of its original refusal when the same person and role
 * ask and it was refused outright. The receipt may be absent (cancelled from Operations), expired under retention,
 * unreadable or a failure that saved nothing ("try again" would mislead here), so a general sentence stands in. */
async function cancelledRefusal(ctx: StoreContext, merchantId: string, prior: OperationRow): Promise<string> {
  let reason: unknown;
  if (prior.actor === ctx.actor && prior.role === ctx.role) {
    try {
      const rejected = (await revealStored(prior.receipt, { lender: merchantId, record: prior.id, field: 'receipt' }))?.rejected;
      if ((definitiveRefusalStatuses as readonly unknown[]).includes(rejected?.status)) reason = rejected.message;
    } catch { reason = undefined; }
  }
  return typeof reason === 'string' && reason.trim()
    ? `The service refused this request and saved nothing: ${reason.trim()} It cannot run again; review the latest records and submit a new request.`
    : 'This request was cancelled before it completed and saved nothing. It cannot run again; review the latest records and submit a new request.';
}
// The journal is read without the lender's lock: a busy lender never holds up Operations, a retry or a cancel's checks.
export async function listOperations(ctx: StoreContext, merchantId: string, offset = 0) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  const scope = [merchantId, session.owner || session.principal];
  const total = Number((await session.client.query<{ count: string }>('SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2', scope)).rows[0]!.count);
  const items = (await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE merchant_id=$1 AND owner=$2 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $3', [...scope, offset])).rows.map(operationView);
  return { items, total, offset };
}
/** The caller's own entry in the lender, as its current role may act on it; neither its request nor its receipt is opened. */
async function operationEntry(ctx: StoreContext, merchantId: string, id: string) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'none');
  const row = (await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [id, merchantId, session.owner || session.principal])).rows[0];
  if (!row) fail('Request not found in your lender history.', 404);
  if (row.actor !== ctx.actor || row.role !== ctx.role) fail('This request was submitted under a different role. Your current role cannot repeat it.', 403);
  if((row.request as any)?.purged)fail('This terminal request payload expired under the lender retention policy. Its identity and completion history are retained; it cannot run again.',410);
  return row;
}
/** An entry with its request opened, to repeat it. The receipt is not opened: a retry replays the answer saved for
 * the request. A request that cannot be opened is refused naming the entry's state, so the answer never says nothing
 * was saved for a request that was. */
export async function readOperation(ctx: StoreContext, merchantId: string, id: string) {
  const { receipt: _receipt, ...entry } = await operationEntry(ctx, merchantId, id);
  try { return { ...entry, request: await revealStored(entry.request, { lender: merchantId, record: id, field: 'request' }) }; }
  catch (error) { throw markOperationState(error, entry.status as OperationState); }
}
/**
 * Where a keyed write's answer is kept for its repeats. A journaled request's is
 * kept under its journal entry's own id: the entry holds one person's request
 * on one route, so the same key used on another route, or by a colleague,
 * never answers it or leaves its entry stranded. A write the journal does not
 * record (a demo persona switch) keeps it under its key in a name of its own.
 * `earlier` is where an earlier build kept every answer, under the key alone
 * (with the connected workspace's prefix): it is read, never written, so a
 * request saved before still replays.
 */
export function receiptOf(req: Request, merchantId: string, key: string, kind: 'workspace' | 'connected' | 'persona') {
  const earlier = digest(`${kind === 'connected' ? 'connected:' : ''}${merchantId}:${key}`);
  const entry = requestOperations.get(req)?.id;
  return { id: entry ?? (kind === 'persona' ? digest(`persona:${merchantId}:${key}`) : earlier), earlier };
}
/** Every place a journal entry's answer may be kept: its own id, then the key alone as earlier builds kept it. */
const receiptIds = (merchantId: string, key: string, entryId: string) => [entryId, digest(`${merchantId}:${key}`), digest(`connected:${merchantId}:${key}`)];
/** Whether an answer is stored for this entry's request. An entry that is not completed but has one belongs to a
 * write saved outside the journal, before it existed: that request was saved, so its entry is never cancelled. */
async function receiptStored(client: PoolClient, merchantId: string, key: string, entryId: string): Promise<boolean> {
  return (await client.query('SELECT 1 FROM valopay_idempotency WHERE merchant_id=$1 AND id=ANY($2::text[])', [merchantId, receiptIds(merchantId, key, entryId)])).rows.length > 0;
}
export async function cancelOperation(ctx: StoreContext, merchantId: string, id: string) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'update');
  const row = await operationEntry(ctx, merchantId, id);
  if (row.status === 'completed') fail('This request already completed. Refresh Operations to see its saved result.', 409);
  if (await receiptStored(session.client, merchantId, row.request_key, row.id)) fail('A receipt already exists for this request. Check the original request to recover it.', 409);
  await session.client.query("UPDATE valopay_operations SET status='cancelled',updated_at=$4 WHERE id=$1 AND merchant_id=$2 AND owner=$3 AND status='pending'", [id, merchantId, session.owner || session.principal, ctx.now]);
  return { message: 'The server confirmed this request has not completed and cancelled it. It cannot run again.' };
}
/**
 * After a request bound to a journal entry was refused or failed, closes the
 * entry when it may be closed, and resolves to its state afterwards (undefined
 * when there is no entry). Runs in its own transaction, after the request's own
 * transaction ended. `close` says why it may close: a definitive refusal (a 4xx
 * the same request would receive again, `refused`) closes it whatever else is
 * running, and an attempt already past its checks is then refused at
 * completeOperation; a failure that saved nothing (`unsaved`), of the attempt
 * that created the entry, closes it only while no other attempt holds it
 * (holdOperation), so a repeat's failure never cancels the request its original
 * attempt is still running. A closed entry neither waits for confirmation nor
 * counts towards the pending limit, and its key cannot run again. Without
 * `close`, the state is only read, for the answer to say. An entry an earlier
 * attempt completed stays `completed`; one cancelled meanwhile (by another
 * attempt's refusal, or from Operations) is `cancelled`; an entry held by an
 * attempt running it is `running`. As in cancelOperation, an entry whose
 * request has a stored answer (a write saved before the journal existed) stays
 * pending, and is `completed` for the answer: that request was saved.
 */
export async function rejectOperation(req: Request, bound: { id: string; merchantId: string }, rejection: { status: number; message: string }, close: 'refused' | 'unsaved' | undefined): Promise<OperationState | undefined> {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  try {
    await client.query(beginStatement(databaseLimits().request));
    if (runtimeIsolationEnabled()) {
      const verified = getAuth(req) as unknown as VerifiedClerkSession;
      await bindRuntimeIdentity(client, { organizationId: verified.orgId || '', userId: verified.userId || '' });
    }
    // Held by this transaction when no attempt is running the request; kept until it ends, so none starts meanwhile.
    const idle = (await client.query<{ held: boolean }>(`SELECT pg_try_advisory_xact_lock(${OPERATION_LOCK}) AS held`, [bound.id])).rows[0]?.held === true;
    // The row lock orders this against an attempt completing the entry: whichever commits first decides.
    const entry = (await client.query<{ status: string; request_key: string }>('SELECT status,request_key FROM valopay_operations WHERE id=$1 AND merchant_id=$2 FOR UPDATE', [bound.id, bound.merchantId])).rows[0];
    let state = entry?.status as OperationState | undefined;
    if (entry?.status === 'pending') {
      if (await receiptStored(client, bound.merchantId, entry.request_key, bound.id)) state = 'completed';
      else if (close === 'refused' || (close === 'unsaved' && idle)) {
        const receipt = await protectStored({ rejected: rejection }, { lender: bound.merchantId, record: bound.id, field: 'receipt' });
        await client.query("UPDATE valopay_operations SET status='cancelled',receipt=$3,updated_at=now() WHERE id=$1 AND merchant_id=$2 AND status='pending'", [bound.id, bound.merchantId, receipt]);
        state = 'cancelled';
      } else if (!idle) state = 'running';
    }
    const committed = await client.query('COMMIT');
    return committed.command === 'COMMIT' ? state : undefined;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    throw error;
  } finally { guard.release(); }
}
/**
 * What the journal keeps of a completed request's answer: a reference to the
 * record it saved, the only part Operations reads (its "Open saved result"
 * link). The whole answer is stored once in valopay_idempotency, under the
 * request's journal entry (receiptOf), and that copy is what a retried key or
 * a retry from Operations replays. A daily close answers with its whole record, about
 * 100 KB for a pilot-scale lender, and used to be stored in both tables.
 * Entries completed earlier keep their whole answer until retention removes it.
 * The reference names only the saved record's ID and kind, so it is stored
 * unsealed: sealed, Operations could not read it without the key service.
 */
/** A journal receipt that is only such a reference, which is never sealed. */
function isJournalReference(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => key === "record" || key === "id" || key === "kind");
}
export function journalReceipt(response: unknown): { id?: string; kind?: string; record?: { id: string; kind?: string } } {
  const reference = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const { id, kind } = value as { id?: unknown; kind?: unknown };
    return typeof id === "string" ? { id, ...(typeof kind === "string" ? { kind } : {}) } : undefined;
  };
  const record = reference((response as { record?: unknown } | null | undefined)?.record);
  return { ...(record ? { record } : {}), ...reference(response) };
}
/** Receipt and domain writes commit together. A process crash cannot leave a
 * completed journal entry without the corresponding business write.
 *
 * A cancelled entry never completes. This guard is what makes cancellation
 * final: an attempt already past its checks when a retry's refusal (or
 * Cancel if unfinished) cancelled its entry is refused here and rolls back,
 * so an answer that says `operation: "cancelled"` proves that nothing sent
 * with the key was saved. Every journaled write must commit through this
 * function for that to hold. */
export async function completeOperation(ctx: StoreContext, receipt: unknown) {
  const session = sessionFor(ctx);
  if (!session.operationId) return;
  const merchantId = lockedMerchant(session), owner = session.owner || session.principal;
  const result = await session.client.query(`UPDATE valopay_operations SET status='completed',receipt=$5,updated_at=$6
    WHERE id=$1 AND merchant_id=$2 AND owner=$3 AND actor=$4 AND status<>'cancelled'`, [session.operationId, merchantId, owner, ctx.actor, journalReceipt(receipt), ctx.now]);
  if (rowsAffected(result)) return;
  const current = (await session.client.query<{ status: string }>('SELECT status FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [session.operationId, merchantId, owner])).rows[0];
  if (current?.status === 'cancelled') fail('This request was cancelled before it completed. Nothing was saved, and it cannot run again.', 409);
  fail('The recovery request no longer belongs to this session.', 409);
}

type StaffRow = { id: string; workspace_id: string; user_id: string; display_name: string; role: string; status: 'active' | 'suspended' | 'revoked'; expires_at: Date; created_at: Date; updated_at: Date };
const staffProvision = (row: StaffRow, organizationId: string) => ({ id: row.id, userId: row.user_id, organizationId, tenantId: row.workspace_id, role: row.role, status: row.status, validFrom: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() });
const staffView = (row: StaffRow) => ({ id: row.id, actor: `Clerk:${row.user_id}`, name: row.display_name, role: row.role, status: row.status, expiresAt: row.expires_at.toISOString(), updatedAt: row.updated_at.toISOString() });
export async function caseAssignees(ctx: StoreContext) {
  const session = sessionFor(ctx);
  if (ctx.accessMode !== 'staff') return roles.filter(role => role !== 'Read-only').map(role => ({ actor: `Sandbox ${role}`, name: `Demo ${role}`, role }));
  if (!session.lockedMerchantId) fail('Select a lender before looking up available assignees.', 409);
  // The same three fields as a demo role: who, their name and their role; the membership's other details stay in the team directory.
  return (await session.client.query<StaffRow>(`SELECT member.* FROM valopay_staff_memberships member
    WHERE member.workspace_id=$1 AND member.status='active' AND member.expires_at>$2 AND member.role<>'Read-only'
      AND (member.role='Admin' OR EXISTS (SELECT 1 FROM valopay_staff_lender_access grant_row WHERE grant_row.membership_id=member.id AND grant_row.merchant_id=$3))
    ORDER BY member.display_name,member.id`, [session.workspace.id, ctx.now, session.lockedMerchantId])).rows.map(row => { const { actor, name, role } = staffView(row); return { actor, name, role }; });
}
/** A membership change that grants one of `approvalRoles`, waiting for a second administrator: its request in the access history. */
type ChangeRequestRow = { id: string; actor: string; subject: string; detail: { before: { role: string; status: string }; after: { role: string; status: string }; reason: string; version: string }; created_at: Date; name: string; member_version: Date };
const changeView = (row: ChangeRequestRow) => ({ id: row.id, memberId: row.subject, name: row.name, from: row.detail.before, to: row.detail.after, reason: row.detail.reason, requestedBy: row.actor, requestedAt: row.created_at.toISOString() });
/** Change requests nobody has approved or declined, with the membership they change as it stands now, newest first. */
const changeRequestsSql = `SELECT request.id,request.actor,request.subject,request.detail,request.created_at,member.display_name AS name,member.updated_at AS member_version
  FROM valopay_staff_events request JOIN valopay_staff_memberships member ON member.id=request.subject AND member.workspace_id=request.workspace_id
  WHERE request.workspace_id=$1 AND request.action='staff.change_requested' AND ($2::text IS NULL OR request.id=$2) AND ($3::text IS NULL OR request.subject=$3)
    AND NOT EXISTS (SELECT 1 FROM valopay_staff_events decision WHERE decision.workspace_id=request.workspace_id AND decision.action IN ('staff.change_approved','staff.change_declined') AND decision.detail->>'requestId'=request.id)
  ORDER BY request.created_at DESC,request.id DESC LIMIT 200`;
/** A request is current while the membership is still the version it was made against; any later change leaves it out of date. */
const currentRequest = (row: ChangeRequestRow) => row.member_version.toISOString() === row.detail.version;
/** The administrator who approved a pending invitation, never the one who sent it; undefined while it waits. */
async function invitationApprover(client: PoolClient, workspaceId: string, invitation: { id: string; invited_by: string }): Promise<string | undefined> {
  return (await client.query<{ actor: string }>("SELECT actor FROM valopay_staff_events WHERE workspace_id=$1 AND subject=$2 AND action='staff.invitation_approved' AND actor<>$3 ORDER BY created_at,id LIMIT 1", [workspaceId, invitation.id, invitation.invited_by])).rows[0]?.actor;
}
const needsApproval = (role: string) => (approvalRoles as readonly string[]).includes(role);
/** What a person refused as their own approver is told: the rule, and how a pilot with one administrator gets a second. */
const secondAdministrator = (what: string, who: string) => `A different administrator must approve this ${what}: the administrator who ${who} cannot approve it. A pilot with one administrator asks the operator to add a second with the provisioning command's --add-administrator mode.`;
export async function staffDirectory(ctx: StoreContext) {
  const session = sessionFor(ctx);
  if (ctx.accessMode !== 'staff') return { mode: 'sandbox', actor: ctx.actor, members: [], lenders: [], invitations: [], changes: [], events: [], message: 'Real staff access is not enabled on this host. Demo roles are for practice only.' };
  const memberRows = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 ORDER BY display_name,id', [session.workspace.id])).rows;
  const grants = (await session.client.query<{ membership_id: string; merchant_id: string }>(`SELECT grant_row.membership_id,grant_row.merchant_id FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id JOIN valopay_merchants lender ON lender.id=grant_row.merchant_id WHERE member.workspace_id=$1 AND lender.workspace_id=$1 ORDER BY grant_row.merchant_id`, [session.workspace.id])).rows;
  const lendersOf = (id: string) => grants.filter(grant => grant.membership_id === id).map(grant => grant.merchant_id);
  const admin = ctx.role === 'Admin', own = memberRows.find(row => row.user_id === session.userId), shared = new Set(own ? lendersOf(own.id) : []);
  // An administrator sees everyone. Anyone else sees the colleagues who can open one of their lenders (an administrator opens
  // every lender), only the lenders they share, and no one's expiry but their own.
  const colleague = (row: StaffRow) => row.status === 'active' && row.expires_at.getTime() > Date.parse(ctx.now) && (row.role === 'Admin' ? shared.size > 0 : lendersOf(row.id).some(id => shared.has(id)));
  const members = memberRows.filter(row => admin || row.id === own?.id || colleague(row)).map(row => {
    const whole = admin || row.id === own?.id;
    return { ...staffView(row), expiresAt: whole ? row.expires_at.toISOString() : null, lenderIds: row.role === 'Admin' ? [] : lendersOf(row.id).filter(id => whole || shared.has(id)), allLenders: row.role === 'Admin' };
  });
  if (!admin) return { mode: 'staff', actor: ctx.actor, members, lenders: [], invitations: [], changes: [], events: [], message: 'Verified staff access. Membership, lender access and MFA are checked for every request. You see the colleagues who work on your lenders. Financial records remain synthetic.' };
  const lenders = await listMerchants(ctx);
  // Timestamps as the ISO text the answer carries, as every other view writes them.
  const invitations = (await session.client.query<{ id: string; email: string; role: string; status: string; expiresAt: Date; invitedBy: string; approvedBy: string | null }>(`SELECT invitation.id,invitation.email,invitation.role,invitation.status,invitation.expires_at AS "expiresAt",invitation.invited_by AS "invitedBy",
    (SELECT approval.actor FROM valopay_staff_events approval WHERE approval.workspace_id=invitation.workspace_id AND approval.subject=invitation.id AND approval.action='staff.invitation_approved' AND approval.actor<>invitation.invited_by ORDER BY approval.created_at,approval.id LIMIT 1) AS "approvedBy"
    FROM valopay_staff_invitations invitation WHERE invitation.workspace_id=$1 ORDER BY invitation.created_at DESC LIMIT 100`, [session.workspace.id])).rows
    .map(row => ({ ...row, expiresAt: row.expiresAt.toISOString(), approval: !needsApproval(row.role) ? 'not_required' : row.approvedBy ? 'approved' : 'awaiting' }));
  const changes = (await session.client.query<ChangeRequestRow>(changeRequestsSql, [session.workspace.id, null, null])).rows.filter(currentRequest).slice(0, 100).map(changeView);
  const events = (await session.client.query<{ id: string; actor: string; action: string; subject: string; detail: unknown; createdAt: Date }>('SELECT id,actor,action,subject,detail,created_at AS "createdAt" FROM valopay_staff_events WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [session.workspace.id])).rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() }));
  return { mode: 'staff', actor: ctx.actor, members, lenders, invitations, changes, events, message: 'Verified staff access. Membership, lender access and MFA are checked for every request. Financial records remain synthetic.' };
}
export function viewerScope(ctx: StoreContext) { const session = sessionFor(ctx); return digest(`viewer:${session.workspace.id}:${session.owner || session.principal}`); }
function teamAdmin(ctx: StoreContext) {
  const session = sessionFor(ctx);
  if (ctx.accessMode !== 'staff' || ctx.role !== 'Admin' || session.access !== 'team') fail('A verified pilot administrator with recent MFA is required.', 403);
  return session;
}
async function staffEvent(client: PoolClient, workspaceId: string, actor: string, action: string, subject: string, detail: unknown): Promise<{ id: string; createdAt: Date }> {
  return (await client.query<{ id: string; createdAt: Date }>('INSERT INTO valopay_staff_events(id,workspace_id,actor,action,subject,detail) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,created_at AS "createdAt"', [randomUUID(), workspaceId, actor, action, subject, detail])).rows[0]!;
}
export async function inviteStaff(ctx: StoreContext, email: string, role: string) {
  const session = teamAdmin(ctx);
  const token = randomBytes(32).toString('hex'), id = randomUUID(), approval = needsApproval(role) ? 'awaiting' as const : 'not_required' as const;
  await session.client.query("UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND email=$2 AND status='pending'", [session.workspace.id, email]);
  await session.client.query(`INSERT INTO valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, session.workspace.id, email, role, digest(token), ctx.actor, new Date(Date.parse(ctx.now) + 7 * 86400000)]);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.invited', id, { email, role, ...(approval === 'awaiting' ? { approval } : {}) });
  if (approval === 'not_required') return { id, token, approval, message: 'Invitation created. Share the link directly with this person; no email has been sent. It expires in seven days.' };
  const administrators = Number((await session.client.query<{ count: string }>("SELECT count(*) FROM valopay_staff_memberships WHERE workspace_id=$1 AND role='Admin' AND status='active' AND expires_at>$2", [session.workspace.id, ctx.now])).rows[0]!.count);
  return { id, token, approval, message: `Invitation created. It waits for a second administrator's approval before it can be accepted: an Admin, Finance or Compliance reviewer grant needs two administrators, and the one who sent it cannot approve it.${administrators < 2 ? " This pilot has one active administrator: ask the operator to add a second with the provisioning command's --add-administrator mode." : ''} Share the link directly; no email has been sent. It expires in seven days.` };
}
/** A second administrator's approval of an invitation to Admin, Finance or Compliance reviewer, recorded in the access history; the invitee can accept it afterwards. */
export async function approveInvitation(ctx: StoreContext, id: string) {
  const session = teamAdmin(ctx);
  const invitation = (await session.client.query<{ id: string; email: string; role: string; invited_by: string; status: string; expires_at: Date }>('SELECT id,email,role,invited_by,status,expires_at FROM valopay_staff_invitations WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, id])).rows[0];
  if (!invitation) fail('Invitation not found.', 404);
  if (invitation.status !== 'pending' || invitation.expires_at.getTime() <= Date.parse(ctx.now)) fail('This invitation is no longer pending.', 409);
  if (!needsApproval(invitation.role)) fail('This invitation needs no approval: only Admin, Finance and Compliance reviewer invitations do.', 409);
  if (invitation.invited_by === ctx.actor) fail(secondAdministrator('invitation', 'sent it'), 403);
  if (await invitationApprover(session.client, session.workspace.id, invitation)) fail('This invitation is already approved.', 409);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.invitation_approved', id, { email: invitation.email, role: invitation.role, invitedBy: invitation.invited_by });
  return { message: `Invitation approved: ${invitation.email} can now accept it as ${invitation.role}.` };
}
/** Applies a membership change, clearing lender grants on a role change or revocation and pending invitations on a suspension or revocation, with its event. */
async function applyStaffChange(session: Session, ctx: StoreContext, row: StaffRow, after: { role: string; status: string }, action: string, detail: Record<string, unknown>) {
  const result = await session.client.query<StaffRow>(`UPDATE valopay_staff_memberships SET role=$3,status=$4,updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE workspace_id=$1 AND id=$2 RETURNING *`, [session.workspace.id, row.id, after.role, after.status]);
  if (after.status === 'revoked' || after.role !== row.role) await session.client.query('DELETE FROM valopay_staff_lender_access WHERE membership_id=$1', [row.id]);
  // Suspension and revocation withdraw the person's pending invitations: an
  // invitation sent earlier must not hand the access straight back.
  const invitationsRevoked = after.status === 'active' ? 0 : (await session.client.query("UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='pending'", [session.workspace.id, row.display_name])).rowCount || 0;
  await staffEvent(session.client, session.workspace.id, ctx.actor, action, row.id, { before: { role: row.role, status: row.status }, after, ...detail, ...(invitationsRevoked ? { invitationsRevoked } : {}) });
  return result.rows[0]!;
}
export async function updateStaff(ctx: StoreContext, id: string, input: { role: string; status: string; expectedUpdatedAt: string; reason: string }) {
  const session = teamAdmin(ctx);
  const row = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, id])).rows[0];
  if (!row) fail('Staff membership not found.', 404);
  if (row.user_id === session.userId) fail('Ask another administrator to change your membership.', 403);
  if (row.updated_at.toISOString() !== input.expectedUpdatedAt) fail('This membership changed. Refresh the team and review it again.', 409);
  if (row.status === 'revoked' && input.status !== 'revoked') fail('A revoked person must accept a new invitation before access is restored.', 409);
  const after = { role: input.role, status: input.status };
  if (grantNeedsApproval(row, after)) {
    // The grant waits for a second administrator: the request is recorded, and the membership stays as it is until one approves it.
    const waiting = (await session.client.query<ChangeRequestRow>(changeRequestsSql, [session.workspace.id, null, id])).rows.find(request => currentRequest(request) && sameJson(request.detail.after, after));
    const pending = waiting ? changeView(waiting) : await (async () => {
      const request = await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.change_requested', id, { before: { role: row.role, status: row.status }, after, reason: input.reason, version: row.updated_at.toISOString() });
      return changeView({ id: request.id, actor: ctx.actor, subject: id, detail: { before: { role: row.role, status: row.status }, after, reason: input.reason, version: row.updated_at.toISOString() }, created_at: request.createdAt, name: row.display_name, member_version: row.updated_at });
    })();
    return { ...staffView(row), message: `This change waits for a second administrator: an Admin, Finance or Compliance reviewer grant takes effect only when a different administrator approves it in Team & access. ${row.display_name} keeps their current access until then.`, pendingChange: pending };
  }
  const updated = await applyStaffChange(session, ctx, row, after, 'staff.changed', { reason: input.reason });
  return { ...staffView(updated), message: 'Access change saved. Existing sessions must pass it on their next request.', pendingChange: null };
}
/** The request a second administrator approves or declines: current, not decided, in this workspace. */
async function changeRequest(session: Session, requestId: string): Promise<ChangeRequestRow> {
  const found = (await session.client.query<ChangeRequestRow>(`SELECT request.id,request.actor,request.subject,request.detail,request.created_at,member.display_name AS name,member.updated_at AS member_version
    FROM valopay_staff_events request JOIN valopay_staff_memberships member ON member.id=request.subject AND member.workspace_id=request.workspace_id
    WHERE request.workspace_id=$1 AND request.id=$2 AND request.action='staff.change_requested'`, [session.workspace.id, requestId])).rows[0];
  if (!found) fail('Change request not found.', 404);
  if (!(await session.client.query(changeRequestsSql, [session.workspace.id, requestId, null])).rows.length) fail('This change was already approved or declined.', 409);
  return found;
}
/** A second administrator's approval of a waiting change: the exact change requested, applied now and recorded with who asked and who approved. */
export async function approveStaffChange(ctx: StoreContext, requestId: string) {
  const session = teamAdmin(ctx);
  const request = await changeRequest(session, requestId);
  const row = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, request.subject])).rows[0];
  if (!row) fail('Staff membership not found.', 404);
  if (row.updated_at.toISOString() !== request.detail.version) fail('This membership changed after the change was requested. Review the membership and ask for the change again.', 409);
  if (request.actor === ctx.actor) fail(secondAdministrator('change', 'asked for it'), 403);
  if (row.user_id === session.userId) fail('Ask another administrator to approve a change to your own membership.', 403);
  const updated = await applyStaffChange(session, ctx, row, request.detail.after, 'staff.change_approved', { reason: request.detail.reason, requestId, requestedBy: request.actor });
  return { ...staffView(updated), message: `Change approved: ${row.display_name} is now ${updated.role} (${updated.status}). Existing sessions must pass it on their next request.`, pendingChange: null };
}
/** Declines a waiting change (or withdraws it, for the administrator who asked), recorded in the access history; the membership is unchanged. */
export async function declineStaffChange(ctx: StoreContext, requestId: string) {
  const session = teamAdmin(ctx);
  const request = await changeRequest(session, requestId);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.change_declined', request.subject, { requestId, before: request.detail.before, after: request.detail.after, requestedBy: request.actor });
  return { message: request.actor === ctx.actor ? 'Change request withdrawn. The membership is unchanged.' : 'Change request declined. The membership is unchanged.' };
}
/** The workspace's exclusive team lock serialises grant changes with every
 * read/write transaction, so removing a grant blocks later requests using an
 * already-issued session token after current authorised work completes. */
export async function updateStaffLenders(ctx: StoreContext, id: string, input: StaffLenderAccessInput) {
  const session = teamAdmin(ctx);
  const member = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, id])).rows[0];
  if (!member) fail('Staff membership not found.', 404);
  const available = await listMerchants(ctx);
  const checked = validateLenderAccessChange(input, { userId: member.user_id, role: member.role, status: member.status, updatedAt: member.updated_at.toISOString(), expiresAt: member.expires_at.toISOString() }, session.userId || '', available.map(lender => lender.id), ctx.now);
  const before = (await session.client.query<{ merchant_id: string }>('SELECT merchant_id FROM valopay_staff_lender_access WHERE membership_id=$1 ORDER BY merchant_id', [id])).rows.map(row => row.merchant_id);
  await session.client.query('DELETE FROM valopay_staff_lender_access WHERE membership_id=$1', [id]);
  for (const merchantId of checked.lenderIds) await session.client.query('INSERT INTO valopay_staff_lender_access(membership_id,merchant_id,granted_by,granted_at) VALUES($1,$2,$3,$4)', [id, merchantId, ctx.actor, ctx.now]);
  const updated = (await session.client.query<StaffRow>(`UPDATE valopay_staff_memberships SET updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE id=$1 AND workspace_id=$2 RETURNING *`, [id, session.workspace.id])).rows[0]!;
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.lender_access_changed', id, { before, after: [...checked.lenderIds].sort(), reason: checked.reason });
  return { ...staffView(updated), lenderIds: checked.lenderIds, allLenders: false, message: 'Lender access saved. Existing sessions must pass these permissions on their next request.' };
}
export async function revokeInvitation(ctx: StoreContext, id: string) {
  const session = teamAdmin(ctx);
  const result = await session.client.query("UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND id=$2 AND status='pending'", [session.workspace.id, id]);
  if (!rowsAffected(result)) fail('This invitation is no longer pending.', 409);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.invitation_revoked', id, {});
  return { message: 'Invitation revoked.' };
}

/** Acceptance has no existing membership. Clerk supplies the verified email;
 * the browser supplies only the invitation token, never an email or role. */
export async function acceptStaffInvitation(req: Request, token: string) {
  if (!staffMode()) fail('Staff access is not enabled on this host.', 403);
  const auth = getAuth(req) as unknown as VerifiedClerkSession;
  const now = new Date().toISOString();
  verifyStaff(auth, { id: 'invitation-check', userId: auth.userId || '', organizationId: auth.orgId || '', tenantId: 'invitation-check', role: 'Read-only', status: 'active', validFrom: '2020-01-01T00:00:00.000Z', expiresAt: '2100-01-01T00:00:00.000Z' }, true, now);
  const user = await clerkClient.users.getUser(auth.userId!);
  const emails = user.emailAddresses.filter(address => address.verification?.status === 'verified').map(address => address.emailAddress.toLowerCase());
  return acceptVerifiedInvitation(auth, token, emails);
}
async function acceptVerifiedInvitation(auth: VerifiedClerkSession, token: string, verifiedEmails: string[]) {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  let committing = false;
  try {
    await client.query(beginStatement(databaseLimits().request));
    await bindRuntimeIdentity(client, { organizationId: auth.orgId || '', userId: auth.userId || '' }, { token, verifiedEmails });
    // A membership change, like a team change: the workspace lock exclusively (waiting only for work already running), then its row.
    const found = (await client.query<{ workspace_id: string }>('SELECT t.workspace_id FROM valopay_teams t WHERE t.organization_id=$1', [auth.orgId])).rows[0];
    if (!found) fail('Select the organisation named in your invitation.', 403);
    await lockWorkspace(client, found.workspace_id, 'exclusive', true);
    const team = (await client.query<{ workspace_id: string }>(`SELECT t.workspace_id FROM valopay_teams t JOIN valopay_workspaces w ON w.id=t.workspace_id WHERE t.organization_id=$1 AND w.id=$2 FOR UPDATE OF w`, [auth.orgId, found.workspace_id])).rows[0];
    if (!team) fail('Select the organisation named in your invitation.', 403);
    const checkedAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
    verifyStaff(auth, { id: 'invitation-check', userId: auth.userId || '', organizationId: auth.orgId || '', tenantId: 'invitation-check', role: 'Read-only', status: 'active', validFrom: '2020-01-01T00:00:00.000Z', expiresAt: '2100-01-01T00:00:00.000Z' }, true, checkedAt);
    const invite = (await client.query<{ id: string; email: string; role: string; invited_by: string; created_at: Date }>(`SELECT id,email,role,invited_by,created_at FROM valopay_staff_invitations WHERE workspace_id=$1 AND token_hash=$2 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE`, [team.workspace_id, digest(token)])).rows[0];
    if (!invite || !verifiedEmails.includes(invite.email)) fail('This invitation is expired, used, revoked or belongs to another verified email address.', 403);
    const existing = (await client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [team.workspace_id, auth.userId])).rows[0];
    if (existing?.status === 'active' && existing.expires_at > new Date(checkedAt)) fail('You already have an active membership. Ask an administrator to change its role.', 409);
    if (existing && existing.status !== 'active') {
      // Only an invitation an administrator sent after the suspension or
      // revocation restores access; an older one, sent to any of the person's
      // verified addresses, is refused.
      const withdrawnAt = (await client.query<{ at: Date | null }>(`SELECT max(created_at) AS at FROM valopay_staff_events WHERE workspace_id=$1 AND subject=$2 AND action='staff.changed' AND detail->'after'->>'status' IN ('suspended','revoked')`, [team.workspace_id, existing.id])).rows[0]?.at ?? existing.updated_at;
      if (invite.created_at <= withdrawnAt) fail('This invitation was sent before your access was suspended or revoked, so it cannot restore it. Ask an administrator for a new invitation.', 403);
    }
    // An Admin, Finance or Compliance reviewer grant takes effect only once a second administrator approved the invitation.
    const approvedBy = needsApproval(invite.role) ? await invitationApprover(client, team.workspace_id, invite) : undefined;
    if (needsApproval(invite.role) && !approvedBy) fail("This invitation is waiting for a second administrator's approval. Ask the administrator who sent it to have another administrator approve it in Team & access, then accept it again.", 403);
    if(existing) {
      if (runtimeIsolationEnabled()) await clearRuntimeInviteeGrants(client);
      else await client.query('DELETE FROM valopay_staff_lender_access WHERE membership_id=$1',[existing.id]);
    }
    await client.query(`INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,status,expires_at) VALUES($1,$2,$3,$4,$5,'active',now()+interval '90 days')
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role,status='active',expires_at=EXCLUDED.expires_at,updated_at=greatest(now(),valopay_staff_memberships.updated_at+interval '1 millisecond')`, [randomUUID(), team.workspace_id, auth.userId, invite.email, invite.role]);
    await client.query("UPDATE valopay_staff_invitations SET status='accepted' WHERE id=$1 AND workspace_id=$2", [invite.id, team.workspace_id]);
    await staffEvent(client, team.workspace_id, `Clerk:${auth.userId}`, 'staff.accepted', invite.id, { role: invite.role, ...(approvedBy ? { approvedBy } : {}) });
    // Checked before COMMIT: an answer that does not match its contract saves nothing.
    const accepted = contractAnswer(invitationAcceptedSchema, { message: 'Invitation accepted. Your pilot membership lasts 90 days.', role: invite.role });
    committing = true;
    await client.query('COMMIT'); return accepted;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    const failed = failedTransaction(error, { committing, lost: guard.lost(), write: true });
    // Before COMMIT was sent nothing was saved, and the answer may say so (as inWorkspace's do).
    if (failed === error && !committing) markRolledBack(error);
    throw failed;
  } finally { guard.release(); }
}

/**
 * Operator-only (scripts/provision-pilot.ts); never called by an HTTP route.
 * An organisation's staff workspace and its administrators: the first
 * administrator with the workspace, another administrator, and renewal of an
 * administrator's 90 days. Each change is one transaction with its staff
 * event; running a command again never fails on a duplicate row, it says
 * where things stand.
 */
const OPERATOR_ACTOR = 'System · operator provisioning';
/** What an operator command did: its outcome, the workspace and administrator, and the expiry, in plain words too. */
export type OperatorProvisioning = { outcome: 'provisioned' | 'added' | 'renewed' | 'unchanged'; workspaceId: string; userId: string; status: string; expiresAt: string; previousExpiresAt?: string; message: string };
/** The checks every operator command makes before it opens a connection. */
function operatorCheck(organizationId: string, userId: string, name?: { value: string; label: string }) {
  if (runtimeIsolationEnabled()) fail('Provision isolated staff workspaces through the separate migration-owner connection before starting the restricted runtime.', 503);
  if (!staffMode() || !/^org_[A-Za-z0-9]+$/.test(organizationId) || !/^user_[A-Za-z0-9]+$/.test(userId) || (name && (!name.value.trim() || name.value.length > 100))) fail(`Provide a staging organisation${name ? `, administrator user ID and ${name.label}` : ' and administrator user ID'}.`);
}
/** One operator change in its own bounded transaction: committed, or rolled back and thrown. */
async function operatorTransaction<T>(change: (client: PoolClient) => Promise<T>): Promise<T> {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  let committing = false;
  try {
    await client.query(beginStatement(databaseLimits().request));
    const result = await change(client);
    committing = true;
    const committed = await client.query('COMMIT');
    if (committed.command !== 'COMMIT') throw markRolledBack(new Error('The provisioning transaction was rolled back.'));
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    // A row another run wrote at the same moment: named in plain words, never with the key the database quotes.
    if ((error as { code?: unknown }).code === '23505') fail('Another provisioning run changed this organisation at the same moment, and nothing was saved. Run the command again to see where it stands.', 409);
    throw failedTransaction(error, { committing, lost: guard.lost(), write: true });
  } finally { guard.release(); }
}
type OperatorMember = StaffRow & { current: boolean };
const memberFor = async (client: PoolClient, workspaceId: string, userId: string) => (await client.query<OperatorMember>('SELECT *, expires_at > clock_timestamp() AS current FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE', [workspaceId, userId])).rows[0];
const operatorAnswer = (outcome: OperatorProvisioning['outcome'], workspaceId: string, member: StaffRow, message: string, previous?: StaffRow): OperatorProvisioning => ({ outcome, workspaceId, userId: member.user_id, status: member.status, expiresAt: member.expires_at.toISOString(), ...(previous ? { previousExpiresAt: previous.expires_at.toISOString() } : {}), message });
/** The organisation's workspace, locked as a team change locks it (exclusively, waiting only for work already running), or a 404. */
async function lockedTeam(client: PoolClient, organizationId: string): Promise<string> {
  const missing = () => fail('This organisation has not been provisioned yet. Provision it with its first administrator.', 404);
  const found = (await client.query<{ workspace_id: string }>('SELECT workspace_id FROM valopay_teams WHERE organization_id=$1', [organizationId])).rows[0] ?? missing();
  await lockWorkspace(client, found.workspace_id, 'exclusive', true);
  const team = (await client.query<{ workspace_id: string }>('SELECT t.workspace_id FROM valopay_teams t JOIN valopay_workspaces w ON w.id=t.workspace_id WHERE t.organization_id=$1 AND w.id=$2 FOR UPDATE OF w', [organizationId, found.workspace_id])).rows[0] ?? missing();
  return team.workspace_id;
}

/** The organisation's workspace with its first administrator for 90 days; for an organisation already provisioned with this administrator, nothing changes and the answer says where it stands. */
export async function provisionStaffWorkspace(organizationId: string, userId: string, name: string): Promise<OperatorProvisioning> {
  operatorCheck(organizationId, userId, { value: name, label: 'workspace name' });
  const principal = digest(`staff-org:${organizationId}`);
  return operatorTransaction(async (client) => {
    // The lock a first visit takes for its principal: two runs for one organisation run one after the other.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [principal]);
    const existing = (await client.query<{ workspace_id: string }>('SELECT workspace_id FROM valopay_teams WHERE organization_id=$1', [organizationId])).rows[0];
    if (existing) {
      const member = await memberFor(client, existing.workspace_id, userId);
      if (member?.role !== 'Admin') fail('This organisation is already provisioned, with another first administrator. Add this person with --add-administrator, or renew an administrator with --renew.', 409);
      const state = member.status !== 'active' ? `this administrator's membership is ${member.status}` : member.current ? `this person is an administrator until ${member.expires_at.toISOString()}` : `this administrator's access ended on ${member.expires_at.toISOString()}; renew it with --renew`;
      return operatorAnswer('unchanged', existing.workspace_id, member, `Already provisioned, so nothing changed: ${state}.`);
    }
    const workspaceId = randomUUID();
    await client.query("INSERT INTO valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Read-only')", [workspaceId, principal]);
    await client.query('INSERT INTO valopay_teams(workspace_id,organization_id,name) VALUES($1,$2,$3)', [workspaceId, organizationId, name]);
    const member = (await client.query<StaffRow>("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,$4,'Admin',now()+interval '90 days') RETURNING *", [randomUUID(), workspaceId, userId, 'Pilot administrator'])).rows[0]!;
    await staffEvent(client, workspaceId, OPERATOR_ACTOR, 'staff.provisioned', userId, { organizationId });
    return operatorAnswer('provisioned', workspaceId, member, `Provisioned: the first administrator's access lasts until ${member.expires_at.toISOString()}. Add a second administrator with --add-administrator, and renew with --renew before access ends.`);
  });
}

/** Another administrator for a provisioned organisation, for 90 days; for a person who is already an active administrator, nothing changes. A suspended or revoked membership is never restored this way. */
export async function addStaffAdministrator(organizationId: string, userId: string, displayName: string): Promise<OperatorProvisioning> {
  operatorCheck(organizationId, userId, { value: displayName, label: 'display name' });
  return operatorTransaction(async (client) => {
    const workspaceId = await lockedTeam(client, organizationId);
    const member = await memberFor(client, workspaceId, userId);
    if (member?.role === 'Admin' && member.status === 'active' && member.current) return operatorAnswer('unchanged', workspaceId, member, `Already an administrator until ${member.expires_at.toISOString()}, so nothing changed. Renew with --renew before then.`);
    if (member?.role === 'Admin' && member.status === 'active') fail(`This administrator's access ended on ${member.expires_at.toISOString()}. Renew it with --renew.`, 409);
    if (member) fail(member.status === 'active' ? `This person is already a ${member.role} member. An administrator changes their role in Team & access.` : `This person's membership is ${member.status}, and adding an administrator never restores it: an administrator invites them again.`, 409);
    const added = (await client.query<StaffRow>("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,$4,'Admin',now()+interval '90 days') RETURNING *", [randomUUID(), workspaceId, userId, displayName.trim()])).rows[0]!;
    await staffEvent(client, workspaceId, OPERATOR_ACTOR, 'staff.administrator_added', added.id, { userId, organizationId });
    return operatorAnswer('added', workspaceId, added, `Added: this administrator's access lasts until ${added.expires_at.toISOString()}.`);
  });
}

/** An administrator's access, active or already ended, extended to 90 days from now, with a staff event; a suspended or revoked membership, or another role's, is refused. */
export async function renewStaffAdministrator(organizationId: string, userId: string): Promise<OperatorProvisioning> {
  operatorCheck(organizationId, userId);
  return operatorTransaction(async (client) => {
    const workspaceId = await lockedTeam(client, organizationId);
    const member = await memberFor(client, workspaceId, userId);
    if (!member) fail('This person has no membership in the organisation\'s workspace. Add them with --add-administrator.', 404);
    if (member.role !== 'Admin') fail(`Renewal is for administrators, and this membership is ${member.role}. An administrator renews anyone else with a new invitation.`, 409);
    if (member.status !== 'active') fail(`This administrator's membership is ${member.status}, and renewal never restores it: an administrator invites them again, or add another administrator with --add-administrator.`, 409);
    const renewed = (await client.query<StaffRow>("UPDATE valopay_staff_memberships SET expires_at=greatest(expires_at,now()+interval '90 days'),updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE id=$1 AND workspace_id=$2 RETURNING *", [member.id, workspaceId])).rows[0]!;
    await staffEvent(client, workspaceId, OPERATOR_ACTOR, 'staff.renewed', member.id, { userId, previousExpiresAt: member.expires_at.toISOString(), expiresAt: renewed.expires_at.toISOString(), ended: !member.current });
    return operatorAnswer('renewed', workspaceId, renewed, `Renewed: this administrator's access ${member.current ? 'now lasts' : 'is restored and lasts'} until ${renewed.expires_at.toISOString()}.`, member);
  });
}

/** A new synthetic lender, or, for a repeat of the same request (repeated), the lender its key created earlier. */
export async function createPilotLender(ctx: StoreContext, input: { name: string; segment: string }, key: string): Promise<{ lender: DomainState["merchant"]; repeated: boolean }> {
  const session = sessionFor(ctx);
  if (ctx.role !== 'Admin' || session.access !== 'team') fail('An administrator must set up a lender.', 403);
  // Workspace lock and deterministic ID make a repeated onboarding request safe.
  const id = digest(`onboarding:${session.workspace.id}:${session.owner}:${key}`), fingerprint = requestFingerprint(input);
  const found = (await session.client.query<MerchantRow>('SELECT id,info,settings FROM valopay_merchants WHERE workspace_id=$1 AND id=$2', [session.workspace.id, id])).rows[0];
  if (found) { if (found.settings.onboardingFingerprint !== fingerprint) fail('This setup request was already used for different details.', 409); return { lender: found.info, repeated: true }; }
  // 'team' access holds the workspace lock exclusively (lockWorkspace), so two creations at once are counted one after the other.
  if (ctx.accessMode !== 'staff') {
    const held = (await session.client.query<{ count: number }>('SELECT count(*)::int AS count FROM valopay_merchants WHERE workspace_id=$1', [session.workspace.id])).rows[0]!.count;
    if (held >= SANDBOX_LENDER_LIMIT) fail(`This sandbox already holds ${SANDBOX_LENDER_LIMIT} lenders, the most a sandbox can have. Continue with an existing lender; a staff workspace can hold more.`, 409);
  }
  const state = seedMerchant(id, true);
  state.records = [];
  Object.assign(state.merchant, { name: input.name, shortName: input.name, segment: input.segment, provider: 'Paystack', mode: 'observation', status: 'onboarding', monthlyVolume: 0, killSwitch: true, preDataReady: false, preLiveReady: false });
  Object.assign(state.settings, { onboardingFingerprint: fingerprint, scheduledCloseEnabled: false, anonymousWorkspace: !ctx.authenticated, nextCloseAt: null });
  await session.client.query('INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,$4)', [id, session.workspace.id, state.merchant, state.settings]);
  await loadState(ctx, id, 'update');
  appendAudit(state, ctx, 'lender.created', id, 'Created an empty synthetic lender for pilot rehearsal.');
  await saveState(ctx, state);
  return { lender: state.merchant, repeated: false };
}

function principalFor(req: Request, res: Response) {
  const userId = signedInUser(req);
  if (staffMode() && !userId) fail('Sign in with your pilot staff account. Anonymous access is unavailable in this environment.', 401);
  if (userId) return { principal: digest(`clerk:${userId}`), authenticated: true, address: req.ip };
  // A request with two different sandbox tokens is refused here, before anything is read (sandbox-cookie.ts).
  const secure = secureRequest(req), cookie = readSandboxCookie(req.headers.cookie, secure);
  const token = cookie.token ?? randomBytes(32).toString("hex");
  // The cookie slides: an active sandbox keeps its 30 days from the last visit, matching the expiry sweep below.
  writeSandboxCookie(res, cookie, token, secure, ANONYMOUS_WORKSPACE_DAYS * 86400000);
  return { principal: sandboxPrincipal(token), authenticated: false, address: req.ip };
}

function sessionFor(context: StoreContext): Session {
  const session = sessions.get(context);
  if (!session || !session.active) fail("This workspace transaction is no longer available.", 409);
  return session;
}
/** Whether this request's own transaction verified the restricted database: the readiness page reports this, never the configuration alone. */
export function runtimeIsolationVerified(context: StoreContext): boolean { return sessionFor(context).isolationVerified === true; }
export function systemWorkspaceMatches(context:StoreContext,workspaceId:string):boolean {return context.actor.startsWith(SYSTEM_ACTOR_PREFIX)&&sessionFor(context).workspace.id===workspaceId;}
export async function verifyWorkspaceEncryption(context:StoreContext) {
  const session=teamAdmin(context);
  if(!payloadEncryptionKey())fail('Configure managed payload encryption before running this check.',503);
  const scope={lender:session.workspace.id,record:randomUUID(),field:'synthetic-key-check'},value={synthetic:true,nonce:randomUUID()};
  const sealed=await protectStored(value,scope),opened=await revealStored(sealed,scope);
  if(!sameJson(value,opened))fail('The encryption check failed.',503);
  await staffEvent(session.client,session.workspace.id,context.actor,'encryption.verified','workspace',{synthetic:true,checkedAt:context.now});
  return {message:'Managed encryption and decryption succeeded for a synthetic payload.',checkedAt:context.now,verified:true};
}
/** Bounded, repeatable protection of legacy payloads. Metadata and request
 * fingerprints remain stable; no recovery key is erased or reused. */
export async function protectWorkspacePayloads(context:StoreContext) {
  const session=teamAdmin(context);
  if(!payloadEncryptionKey())fail('Configure managed payload encryption first.',503);
  // One record per request bounds managed-key calls and keeps progress restartable.
  const batch=1;let protectedCount=0;
  const imports=(await session.client.query<RecordRow>(`SELECT r.* FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id WHERE m.workspace_id=$1 AND r.kind='import-batches' AND (r.data ? 'csv' AND NOT (jsonb_typeof(r.data->'csv')='object' AND r.data->'csv' ? 'protectedPayload')) ORDER BY r.id LIMIT $2 FOR UPDATE OF r`,[session.workspace.id,batch])).rows;
  for(const row of imports){await session.client.query('UPDATE valopay_records SET data=$3 WHERE id=$1 AND merchant_id=$2',[row.id,row.merchant_id,await protectRecordData(rowToRecord(row))]);protectedCount++;}
  const operations=(await session.client.query<OperationRow>(`SELECT o.* FROM valopay_operations o JOIN valopay_merchants m ON m.id=o.merchant_id WHERE m.workspace_id=$1 AND ((NOT(o.request ? 'protectedPayload') AND NOT(o.request ? 'purged')) OR (o.receipt IS NOT NULL AND NOT(o.receipt ? 'protectedPayload') AND NOT(o.receipt ? 'purged') AND CASE WHEN jsonb_typeof(o.receipt)='object' THEN o.receipt-'record'-'id'-'kind'<>'{}'::jsonb ELSE true END)) ORDER BY o.id LIMIT $2 FOR UPDATE OF o`,[session.workspace.id,batch])).rows;
  for(const row of operations){if(protectedCount)break;const scope={lender:row.merchant_id,record:row.id};const request=isProtectedPayload(row.request)?row.request:await protectStored(row.request,{...scope,field:'request'});const receipt=row.receipt===null||isProtectedPayload(row.receipt)||isJournalReference(row.receipt)?row.receipt:await protectStored(row.receipt,{...scope,field:'receipt'});await session.client.query('UPDATE valopay_operations SET request=$3,receipt=$4 WHERE id=$1 AND merchant_id=$2',[row.id,row.merchant_id,request,receipt]);protectedCount++;}
  const receipts=(await session.client.query<{id:string;merchant_id:string;response:unknown}>(`SELECT i.* FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id WHERE m.workspace_id=$1 AND NOT(i.response ? 'protectedPayload') AND NOT(i.response ? 'purged') ORDER BY i.id LIMIT $2 FOR UPDATE OF i`,[session.workspace.id,batch])).rows;
  for(const row of receipts){if(protectedCount)break;await session.client.query('UPDATE valopay_idempotency SET response=$3 WHERE id=$1 AND merchant_id=$2',[row.id,row.merchant_id,await protectStored(row.response,{lender:row.merchant_id,record:row.id,field:'response'})]);protectedCount++;}
  await staffEvent(session.client,session.workspace.id,context.actor,'encryption.protected','workspace',{protectedCount,at:context.now});
  return {message:protectedCount?'Protected another batch of stored payloads. Run again until no payloads remain.':'No unprotected import or recovery payloads remain in this workspace.',protectedCount,mayHaveMore:protectedCount>0};
}
/** What one run of the operator's re-wrap step did (scripts/rewrap-payloads.ts). */
export type PayloadRewrap = { key: string; rewrapped: number; changed: number; remaining: number; remainingByKey: Array<{ key: string; payloads: number }>; message: string };
/**
 * Every protected payload and the scope it was sealed in, with the table it
 * lives in: an import batch's source rows and check, a journal entry's request
 * and receipt, and a replay copy's answer. The fields are fixed here, never
 * input. $1 is the current key; $2, when not null, limits it to those
 * workspaces (tests).
 */
const sealedPayloadsSql = `WITH sealed AS (
    SELECT 'records' AS source, r.id, r.merchant_id, f.field, f.value FROM valopay_records r CROSS JOIN LATERAL (VALUES ('csv', r.data->'csv'), ('check', r.data->'check')) AS f(field, value) WHERE r.kind='import-batches'
    UNION ALL SELECT 'operations', o.id, o.merchant_id, f.field, f.value FROM valopay_operations o CROSS JOIN LATERAL (VALUES ('request', o.request), ('receipt', o.receipt)) AS f(field, value)
    UNION ALL SELECT 'idempotency', i.id, i.merchant_id, 'response', i.response FROM valopay_idempotency i)
  SELECT sealed.source, sealed.id, sealed.merchant_id, sealed.field, sealed.value FROM sealed JOIN valopay_merchants m ON m.id=sealed.merchant_id
  WHERE jsonb_typeof(sealed.value)='object' AND sealed.value ? 'protectedPayload' AND sealed.value->>'key' IS DISTINCT FROM $1 AND ($2::text[] IS NULL OR m.workspace_id=ANY($2::text[]))`;
/** Writes a re-sealed payload back only while it is still the envelope that was read, so a request that changed it meanwhile wins. */
const rewrapWrites: Record<string, string> = {
  'records:csv': "UPDATE valopay_records SET data=jsonb_set(data,'{csv}',$3::jsonb) WHERE id=$1 AND merchant_id=$2 AND kind='import-batches' AND data->'csv'=$4::jsonb",
  'records:check': "UPDATE valopay_records SET data=jsonb_set(data,'{check}',$3::jsonb) WHERE id=$1 AND merchant_id=$2 AND kind='import-batches' AND data->'check'=$4::jsonb",
  'operations:request': 'UPDATE valopay_operations SET request=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND request=$4::jsonb',
  'operations:receipt': 'UPDATE valopay_operations SET receipt=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND receipt=$4::jsonb',
  'idempotency:response': 'UPDATE valopay_idempotency SET response=$3::jsonb WHERE id=$1 AND merchant_id=$2 AND response=$4::jsonb',
};
/**
 * Operator-only (scripts/rewrap-payloads.ts); never called by an HTTP route.
 * After the payload wrapping key changes name (VALOPAY_KMS_KEY), re-seals at
 * most `limit` protected payloads that still name an earlier key: each is
 * opened with the key it names, which must still be listed in
 * VALOPAY_KMS_PREVIOUS_KEYS, and sealed again under the current key with a
 * fresh data key, in the scope it was sealed in. Nothing is locked while the
 * key service works: a payload is read, re-sealed, then written back in a
 * short transaction of its own only if it is still the envelope that was read,
 * so a run can stop at any point and be run again, and a payload a request
 * rewrote meanwhile is left to it (counted as changed). Returns how many it
 * re-sealed and how many still name each earlier key: the earlier key may be
 * retired once none remain (docs/pilot-security.md, "Key rotation").
 */
export async function rewrapProtectedPayloads(options: { limit?: number; workspaces?: readonly string[] } = {}): Promise<PayloadRewrap> {
  if (runtimeIsolationEnabled()) fail("Re-wrap payloads with the database owner's connection and VALOPAY_RUNTIME_ISOLATION unset: the restricted runtime login cannot read every workspace's payloads.", 503);
  const key = payloadEncryptionKey();
  if (!key) fail('Set VALOPAY_PAYLOAD_ENCRYPTION=kms and VALOPAY_KMS_KEY to the key payloads should be sealed under.', 503);
  const limit = options.limit ?? 100, workspaces = options.workspaces ? [...options.workspaces] : null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('Re-wrap between 1 and 1000 payloads at a time.');
  type Sealed = { source: string; id: string; merchant_id: string; field: string; value: { key?: string } };
  const batch = await operatorTransaction(async client => (await client.query<Sealed>(`${sealedPayloadsSql} ORDER BY sealed.source,sealed.merchant_id,sealed.id,sealed.field LIMIT $3`, [key, workspaces, limit])).rows);
  let rewrapped = 0, changed = 0;
  for (const payload of batch) {
    const scope = { lender: payload.merchant_id, record: payload.id, field: payload.field };
    let sealed: unknown;
    try { sealed = await protectStored(await revealStored(payload.value, scope), scope); }
    catch (error) {
      if ((error as { status?: unknown }).status !== 503) throw error;
      fail(`A payload sealed under ${String(payload.value.key)} could not be opened, so the run stopped after re-sealing ${rewrapped}. Keep that key in VALOPAY_KMS_PREVIOUS_KEYS and check this service may decrypt with it, then run the command again.`, 503);
    }
    const written = await operatorTransaction(client => client.query(rewrapWrites[`${payload.source}:${payload.field}`]!, [payload.id, payload.merchant_id, JSON.stringify(sealed), JSON.stringify(payload.value)]));
    if (rowsAffected(written)) rewrapped++; else changed++;
  }
  const remainingByKey = (await operatorTransaction(async client => (await client.query<{ key: string; payloads: string }>(`SELECT payload.value->>'key' AS key, count(*) AS payloads FROM (${sealedPayloadsSql}) payload GROUP BY 1 ORDER BY 1`, [key, workspaces])).rows)).map(row => ({ key: row.key, payloads: Number(row.payloads) }));
  const remaining = remainingByKey.reduce((sum, row) => sum + row.payloads, 0);
  const moved = `Re-sealed ${rewrapped} protected payload${rewrapped === 1 ? '' : 's'} under ${key}${changed ? `; ${changed} changed while this run worked and will be checked again` : ''}.`;
  return { key, rewrapped, changed, remaining, remainingByKey, message: remaining
    ? `${moved} ${remaining} still name an earlier key: run the command again until none remain, and keep the earlier keys in VALOPAY_KMS_PREVIOUS_KEYS until then.`
    : `${moved} No protected payload names an earlier key: an earlier key may be retired once no backup you may restore still needs it.` };
}
function rowsAffected(result: { rowCount: number | null }): boolean { return (result.rowCount || 0) === 1; }
function rowToRecord(row: RecordRow): ValopayRecord {
  return {
    id: row.id, merchantId: row.merchant_id, kind: row.kind, name: row.name, status: row.status,
    reference: row.reference, amountKobo: Number(row.amount_kobo), customerId: row.customer_id,
    data: row.data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}
/** Row lock a load takes on the merchant: exclusive for a mutation, shared for a read so reads never queue behind each other. */
export type MerchantLock = "update" | "share" | "none";
export type WorkspaceAccess = "read" | "write" | "persona" | 'team';
function scopedMerchantQuery(lock: MerchantLock = "none") {
  return `SELECT m.id,m.info,m.settings FROM valopay_merchants m
    JOIN valopay_workspaces w ON w.id=m.workspace_id
    WHERE m.id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3${lock === "update" ? " FOR UPDATE OF m" : lock === "share" ? " FOR SHARE OF m" : ""}`;
}

/**
 * The workspace's own lock, taken before its row: shared by ordinary work,
 * exclusive for a team, lender-access, invitation or persona change.
 * PostgreSQL grants advisory locks in arrival order, so a request that arrives
 * while a change waits queues behind it; a row share lock is granted past a
 * waiting exclusive one, so steady polling could hold a revocation off for
 * ever. The wait is the transaction's own lock limit (database-limits.ts):
 * past it a change answers 503 and nothing changed, and a request queued
 * behind a change that holds the lock too long is turned away the same way.
 * The key's prefix keeps it apart from the principal's bootstrap lock.
 */
async function lockWorkspace(client: PoolClient, workspaceId: string, mode: "shared" | "exclusive", write: boolean): Promise<void> {
  try {
    await client.query(`SELECT ${mode === "exclusive" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared"}(hashtextextended('valopay.workspace:' || $1, 0))`, [workspaceId]);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "55P03") throw error;
    throw markRolledBack(new DatabaseLimitError(mode === "exclusive" ? "workspace_busy" : "workspace_changing", { write, cause: error }));
  }
}

/** Persona, team, lender-access and invitation changes take the workspace
 * lock exclusively (lockWorkspace). Ordinary work shares it, fixing the
 * persona and memberships for the transaction while lender locks serialize
 * mutations; a change waits only for the work already running, and work that
 * arrives meanwhile waits behind the change. The workspace row is still locked
 * after it (shared or exclusive), so the expiry sweep skips busy workspaces.
 * Only first-visit bootstrap needs the principal advisory lock. Every
 * transaction is bounded (database-limits.ts): a lock wait, a statement and
 * idle time each have a limit, and one lender holds at most half the pool, so
 * one busy lender turns its own requests away with a 503 instead of taking
 * every connection (two busy at once can still fill it). */
export async function inWorkspace<T>(req: Request, res: Response, fn: (context: StoreContext) => Promise<T>, access: WorkspaceAccess = "write"): Promise<T> {
  const identity = principalFor(req, res);
  const write = access !== "read", lender = gatedLender(req, identity.principal);
  const leave = lender ? await lenderGate.enter(lender, write) : undefined;
  let guard: Checkout<PoolClient> | undefined;
  let context: StoreContext | undefined, committing = false, isolationVerified = false;
  try {
    guard = await checkOut(() => pool.connect(), write);
    const client = guard.client;
    await client.query(beginStatement(databaseLimits().request, runtimeIsolationEnabled() && access === 'read' ? 'ISOLATION LEVEL REPEATABLE READ' : undefined));
    if (runtimeIsolationEnabled()) {
      const verified = getAuth(req) as unknown as VerifiedClerkSession;
      isolationVerified = await bindRuntimeIdentity(client, { organizationId: verified.orgId || '', userId: verified.userId || '' });
    }
    // Single source of time: the database clock, read once per transaction.
    let now = (await client.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();
    const exclusive = access === "persona" || access === 'team', lockMode = exclusive ? "exclusive" : "shared";
    const workspaceQuery = `SELECT id,principal_hash,role FROM valopay_workspaces WHERE principal_hash=$1 AND id=$2 FOR ${exclusive ? "UPDATE" : "SHARE"}`;
    /** The principal's sandbox, found without a lock and then locked; one removed meanwhile (the expiry sweep) is created afresh. */
    const lockedSandbox = async (): Promise<WorkspaceRow | undefined> => {
      const found = (await client.query<{ id: string }>("SELECT id FROM valopay_workspaces WHERE principal_hash=$1", [identity.principal])).rows[0];
      if (!found) return undefined;
      await lockWorkspace(client, found.id, lockMode, write);
      return (await client.query<WorkspaceRow>(workspaceQuery, [identity.principal, found.id])).rows[0];
    };
    let workspace: WorkspaceRow | undefined;
    let staff: StaffRow | undefined;
    let auth: VerifiedClerkSession | undefined;
    if (staffMode()) {
      auth = getAuth(req) as unknown as VerifiedClerkSession;
      if (access === 'persona') fail('Staff roles are assigned by an administrator. Demo role switching is unavailable.', 403);
      // Lock the organisation before its membership, consistently with team
      // changes. A revocation waits for in-flight work and blocks later work.
      const found = (await client.query<{ id: string }>('SELECT w.id FROM valopay_workspaces w JOIN valopay_teams t ON t.workspace_id=w.id WHERE t.organization_id=$1', [auth.orgId || ''])).rows[0];
      if (!found) fail('This organisation has not been provisioned for the pilot.', 403);
      await lockWorkspace(client, found.id, lockMode, write);
      workspace = (await client.query<WorkspaceRow>(`SELECT w.id,w.principal_hash,w.role FROM valopay_workspaces w JOIN valopay_teams t ON t.workspace_id=w.id WHERE t.organization_id=$1 AND w.id=$2 FOR ${access === 'team' ? 'UPDATE' : 'SHARE'} OF w`, [auth.orgId || '', found.id])).rows[0];
      if (!workspace) fail('This organisation has not been provisioned for the pilot.', 403);
      try {
        staff = (await client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspace.id, auth.userId])).rows[0];
      } catch (error) {
        // A repeatable-read request (runtime isolation) whose membership a team change altered while it waited behind it.
        if ((error as { code?: unknown }).code === '40001') fail('Your access changed while this request was waiting. Refresh and try again.', 409);
        throw error;
      }
      if (!staff) fail('An active staff membership is required. Accept an invitation or contact your administrator.', 403);
      now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now.toISOString();
      verifyStaff(auth, staffProvision(staff, auth.orgId!), access !== 'read', now);
    } else workspace = await lockedSandbox();
    if (!workspace && !staffMode()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [identity.principal]);
      // Another first visit may have finished seeding while we waited.
      workspace = await lockedSandbox();
    }
    if (!workspace) {
      // A new anonymous sandbox seeds two lenders; creation is bounded per client network, per IPv6 /48 and per process on top of the request limit.
      const refused = identity.authenticated ? undefined : sandboxCreation.take(identity.address);
      if (refused) throw Object.assign(new Error(creationRefusalMessage(refused)), { status: 429, retryAfterSeconds: WORKSPACE_CREATION_RETRY_AFTER_SECONDS });
      const inserted = (await client.query<WorkspaceRow>(
        `INSERT INTO valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Admin')
         ON CONFLICT (principal_hash) DO NOTHING RETURNING id,principal_hash,role`,
        [randomUUID(), identity.principal],
      )).rows[0];
      // No other transaction can see the new row before this one commits, so its lock never waits.
      if (inserted) await lockWorkspace(client, inserted.id, lockMode, write);
      workspace = inserted || await lockedSandbox();
      if (!workspace) throw new Error("Workspace bootstrap could not be completed.");
      if (inserted) {
        await seedWorkspace(client, workspace, identity.principal, !identity.authenticated, now);
        // When explicitly enabled, each new anonymous sandbox pays for a few expired ones without a scheduler.
        // The sweep runs inside a savepoint: one that is slow, meets a lock or deadlocks is undone and left to
        // a later bootstrap, and never fails this visitor's.
        if (!identity.authenticated && expiredWorkspaceCleanupEnabled(process.env["VALOPAY_EXPIRED_WORKSPACE_CLEANUP"])) {
          await client.query("SAVEPOINT expired_workspace_sweep");
          try {
            await sweepExpiredWorkspaces(client, SWEEP_BATCH);
            await client.query("RELEASE SAVEPOINT expired_workspace_sweep");
          } catch (error) {
            try { await client.query("ROLLBACK TO SAVEPOINT expired_workspace_sweep"); } catch { throw error; }
            (req as { log?: { warn?(fields: object, message: string): void } }).log?.warn?.({ event: "workspace.sweep_failed", err: error }, "Expired sandboxes were left for a later sweep");
          }
        }
      }
    }
    context = Object.freeze({
      authenticated: identity.authenticated, role: staff?.role || workspace.role, principalId: identity.principal,
      actor: staff ? `Clerk:${staff.user_id}` : `Sandbox ${workspace.role}`, now, accessMode: staff ? 'staff' : 'sandbox',
    });
    sessions.set(context, { client, workspace, principal: workspace.principal_hash, owner: identity.principal, active: true, access,
      operationId: requestOperations.get(req)?.id, userId: staff?.user_id, organizationId: auth?.orgId || undefined, isolationVerified });
    const result = await fn(context);
    committing = true;
    const committed = await client.query("COMMIT");
    // PostgreSQL accepts COMMIT after a caught statement error by returning
    // ROLLBACK.  Do not let a caller that swallowed that error observe success.
    if (committed.command !== "COMMIT") throw markRolledBack(new Error("The workspace transaction was rolled back."));
    // The sandbox exists now: requests that name it are limited as it, not as their network (request-limits.ts).
    if (!staff && !identity.authenticated) rememberSandbox(identity.principal);
    return result;
  } catch (error) {
    if (guard) try { await guard.client.query("ROLLBACK"); } catch { /* transaction is already closed */ }
    // A limit reached before COMMIT is a 503 that says nothing was saved; a connection lost during COMMIT stays unconfirmed.
    const failed = failedTransaction(error, { committing, lost: guard?.lost(), write });
    if (failed !== error) throw failed;
    // Before COMMIT was sent nothing was saved; a failed COMMIT's outcome is unknown.
    if (!committing) markRolledBack(error);
    if (databaseConflictCodes.has((error as { code?: string } | undefined)?.code || "")) {
      conflict("Operation conflicts with the current lender state.");
    }
    throw error;
  } finally {
    if (context) {
      const session = sessions.get(context);
      if (session) { session.active = false; session.snapshot = undefined; session.summarised = undefined; session.lockedMerchantId = undefined; }
    }
    guard?.release();
    leave?.();
  }
}

/** List is explicitly constrained by the server-derived workspace principal. */
export async function listMerchants(context: StoreContext) {
  const session = sessionFor(context);
  return (await session.client.query<{ info: DomainState["merchant"] }>(
    `SELECT m.info FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE m.workspace_id=$1 AND w.id=$1 AND w.principal_hash=$2
       AND ($3::boolean OR EXISTS (SELECT 1 FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id WHERE grant_row.merchant_id=m.id AND member.workspace_id=$1 AND member.user_id=$4 AND member.status='active' AND member.expires_at>clock_timestamp())) ORDER BY m.id`,
    [session.workspace.id, session.principal, context.accessMode !== 'staff' || context.role === 'Admin', session.userId || ''],
  )).rows.map((row) => row.info);
}

/**
 * Lock membership before loading records.  A context becomes bound to one
 * merchant, preventing a confused caller from switching tenant mid-operation.
 * A mutation takes the exclusive row lock that serializes validation, allocations,
 * idempotency and audit sequencing; a read takes a share lock, so it sees one
 * consistent state, waits for an in-flight mutation to commit, and never queues
 * behind other reads. The journal's own reads take none. A journaled write holds
 * its entry before it waits for the lender (holdOperation).
 */
async function readMerchant(context: StoreContext, merchantId: string, lock: MerchantLock = "share"): Promise<MerchantRow> {
  const session = sessionFor(context);
  if (session.access === "read" && lock === "update") conflict("A read transaction cannot acquire a lender write lock.");
  if (session.lockedMerchantId && session.lockedMerchantId !== merchantId) conflict("A transaction may operate on only one lender.");
  if (session.operationId && lock === 'update') await holdOperation(session);
  const merchant = (await session.client.query<MerchantRow>(
    scopedMerchantQuery(runtimeIsolationEnabled() && context.role === 'Read-only' && lock === 'share' ? 'none' : lock),
    [merchantId, session.workspace.id, session.principal],
  )).rows[0];
  if (!merchant) fail("Lender not found in this workspace.", 404);
  if (context.accessMode === 'staff' && context.role !== 'Admin') {
    const grant = (await session.client.query(`SELECT 1 FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id WHERE grant_row.merchant_id=$1 AND member.workspace_id=$2 AND member.user_id=$3 AND member.status='active' AND member.expires_at>clock_timestamp()`, [merchantId, session.workspace.id, session.userId])).rows[0];
    if (!grant) fail('Lender not found in your permitted workspace access.', 404);
  }
  if (session.operationId && lock === 'update') {
    const operation = (await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [session.operationId, merchantId, session.owner || session.principal])).rows[0];
    if (!operation || operation.actor !== context.actor || operation.role !== context.role || operation.status === 'cancelled') fail('This request has been cancelled or your authority changed. Refresh Operations.', 409);
  }
  session.lockedMerchantId = merchantId;
  if (merchant.info.id !== merchantId) conflict("Lender identity does not match its stored scope.");
  return merchant;
}

/** A daily close as the domain reads earlier closes: its summary and the unallocated and exception totals, without the full REC-07 arrays. */
const closeSummarySql = "(r.data - 'report' - 'operational' - 'metrics') || CASE WHEN r.data ? 'report' THEN jsonb_build_object('report',jsonb_build_object('unallocated',r.data#>'{report,unallocated}','exceptions',r.data#>'{report,exceptions}')) ELSE '{}'::jsonb END";
/** Closes this recent stay whole in a write load; the latest close, which a Finance review hashes, is always among them. */
const FULL_CLOSE_DAYS = 7;

export async function loadState(context: StoreContext, merchantId: string, lock: Exclude<MerchantLock, "none"> = "update"): Promise<DomainState> {
  const session = sessionFor(context);
  const merchant = await readMerchant(context, merchantId, lock);
  // A write loads earlier closes as summaries: each stored report is about
  // 100 KB, and a year of them used to be reloaded and hashed by every save.
  // The full reports stay in PostgreSQL; saveState refuses to change them.
  const rows = (await session.client.query<RecordRow & { summarised: boolean }>(
    `WITH recent AS (SELECT max(created_at) - make_interval(days => $5) AS cutoff FROM valopay_records WHERE merchant_id=$1 AND kind='closes'),
     loaded AS (SELECT r.*, ($4 AND r.kind='closes' AND r.created_at < recent.cutoff) AS summarised
       FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
       JOIN valopay_workspaces w ON w.id=m.workspace_id CROSS JOIN recent
       WHERE r.merchant_id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3)
     SELECT r.id,r.merchant_id,r.kind,r.name,r.status,r.reference,r.amount_kobo,r.customer_id,
       CASE WHEN r.summarised THEN ${closeSummarySql} ELSE r.data END AS data,r.created_at,r.updated_at,r.summarised
     FROM loaded r ORDER BY r.created_at,r.id`,
    [merchantId, session.workspace.id, session.principal, lock === "update", FULL_CLOSE_DAYS],
  )).rows;
  // Protected source rows stay sealed: only the views that show or use them open them (revealImportPayloads).
  const state: DomainState = { merchant: merchant.info, settings: merchant.settings, records: rows.map(rowToRecord) };
  if (state.merchant.id !== merchantId) conflict("Lender identity does not match its stored scope.");
  // A shared load is read-only, even in an otherwise write-capable context.
  // Avoid serialising the entire history just to serve a dashboard or export lookup.
  session.snapshot = lock === "update" ? snapshotOf(state) : undefined;
  session.summarised = lock === "update" ? new Set(rows.filter((row) => row.summarised).map((row) => row.id)) : undefined;
  return state;
}

/**
 * Opens the protected source rows (original CSV and validation check) of this
 * lender's import batches that `select` names, at most four key-service calls
 * at a time, and returns how many batches it opened. A full-state load keeps
 * them sealed, so overviews, saves, the scheduled close and Paystack test
 * deliveries never need the key service to open them (a keyed save still seals
 * its journal entry, and a batch save its rows). Only a view that shows or
 * uses raw source rows calls this, and in a write it must call it before the
 * domain changes the batch: the opened form becomes the batch's loaded form,
 * so an opened but unchanged batch is not written back and the immutability
 * checks compare like with like. A field already open costs nothing.
 */
export async function revealImportPayloads(context: StoreContext, state: DomainState, select: (record: ValopayRecord) => boolean, fields: readonly ProtectedImportField[] = PROTECTED_IMPORT_FIELDS): Promise<number> {
  const session = sessionFor(context);
  if (!session.lockedMerchantId || session.lockedMerchantId !== state.merchant.id) conflict("Load this lender before opening its source rows.");
  const targets = state.records.filter((record) => record.kind === "import-batches" && record.merchantId === session.lockedMerchantId
    && fields.some((field) => isProtectedPayload(record.data[field])) && select(record));
  if (!targets.length) return 0;
  const snapshot = session.snapshot;
  if (snapshot && targets.some((record) => snapshot.records.get(record.id) !== JSON.stringify(record))) throw new Error("Protected source rows must be opened before the batch changes.");
  const opened = await revealRecordsData(targets, fields);
  targets.forEach((record, index) => {
    record.data = opened[index]!.data;
    snapshot?.records.set(record.id, JSON.stringify(record));
  });
  return targets.length;
}

/**
 * After a mutation and before its response is built: every changed record
 * gets a strictly newer version, so the response carries it, and the audit
 * entry receives digests of exactly the records the request added or changed,
 * before and after, with the lender's settings. Unchanged records are never
 * canonicalised; before this, every save hashed the whole lender twice.
 */
export function settleChanges(context: StoreContext, state: DomainState): { beforeDigest: string; afterDigest: string; changedRecords: number } {
  const session = sessionFor(context);
  lockedMerchant(session);
  const snapshot = session.snapshot!;
  const { changed } = changesSince(snapshot, state);
  advanceChanged(snapshot, changed, context.now);
  const byId = (a: ValopayRecord, b: ValopayRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const previous = changed.filter((record) => snapshot.records.has(record.id)).map((record) => JSON.parse(snapshot.records.get(record.id)!) as ValopayRecord).sort(byId);
  return {
    // In the audit entry's form: they are committed to by its change digest.
    beforeDigest: canonicalDigest({ merchant: JSON.parse(snapshot.merchant), settings: JSON.parse(snapshot.settings), records: previous }, "legacy-en-us-null"),
    afterDigest: canonicalDigest({ merchant: state.merchant, settings: state.settings, records: [...changed].sort(byId) }, "legacy-en-us-null"),
    changedRecords: changed.length,
  };
}

/** Records this write transaction added since it loaded the lender. */
export function addedRecords(context: StoreContext, state: DomainState): ValopayRecord[] {
  const session = sessionFor(context);
  lockedMerchant(session);
  return state.records.filter((record) => !session.snapshot!.records.has(record.id));
}

const recordColumns = "r.id,r.merchant_id,r.kind,r.name,r.status,r.reference,r.amount_kobo,r.customer_id,r.data,r.created_at,r.updated_at";
const scopedRecordsFrom = `FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
  JOIN valopay_workspaces w ON w.id=m.workspace_id`;
const scopedRecordsWhere = "r.merchant_id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3";

/** A list never loads unrelated kinds or constructs a writable DomainState.
 * No search: PostgreSQL calculates the count and returns only the page.
 * Search: preserve the exact JavaScript Unicode/JSON search contract by
 * scanning bounded batches of this kind; only the requested page is retained.
 * This path deliberately does not pretend jsonb::text is JSON.stringify: its
 * whitespace and number spelling differ. Search indexing is a separate change.
 */
export async function listRecords(context: StoreContext, merchantId: string, kind: string, query: ListQuery) {
  const session = sessionFor(context);
  await readMerchant(context, merchantId);
  const params: unknown[] = [merchantId, session.workspace.id, session.principal, kind];
  let where = `${scopedRecordsWhere} AND r.kind=$4`;
  const filter = (column: string, value: unknown) => { params.push(value); where += ` AND ${column}=$${params.length}`; };
  if (query.status && query.status !== "all") filter("r.status", query.status);
  if (query.customerId) filter("r.customer_id", query.customerId);
  if (query.id) filter("r.id", query.id);
  if (query.updatedSince) {
    const since = Date.parse(query.updatedSince);
    if (!Number.isFinite(since)) fail("updatedSince must be an ISO timestamp.");
    params.push(new Date(since).toISOString()); where += ` AND r.updated_at >= $${params.length}::timestamptz`;
  }
  const offset = Number.isInteger(query.offset) && Number(query.offset) > 0 ? Number(query.offset) : 0;
  const limit = Number.isInteger(query.limit) && Number(query.limit) > 0 ? Math.min(Number(query.limit), LIST_PAGE_CEILING) : undefined;
  let items: ValopayRecord[] = [], total: number;
  if (!query.search) {
    // Merchant share lock keeps the separate total and page coherent with writes.
    total = Number((await session.client.query<{ total: string }>(`SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${where}`, params)).rows[0]!.total);
    const values = [...params, offset];
    let paging = ` OFFSET $${values.length}`;
    if (limit !== undefined) { values.push(limit); paging += ` LIMIT $${values.length}`; }
    if (offset < total) items = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${where} ORDER BY r.created_at DESC,r.id DESC${paging}`, values)).rows.map(rowToRecord);
  } else {
    const search = foldForSearch(query.search);
    total = 0;
    let cursor: { at: string; id: string } | undefined;
    while (true) {
      const values = [...params];
      let after = "";
      if (cursor) { values.push(cursor.at, cursor.id); after = ` AND (r.created_at,r.id) < ($${values.length - 1}::timestamptz,$${values.length}::text)`; }
      const batch = (await session.client.query<RecordRow & { cursor_at: string }>(`SELECT ${recordColumns},r.created_at::text AS cursor_at ${scopedRecordsFrom} WHERE ${where}${after} ORDER BY r.created_at DESC,r.id DESC LIMIT ${LIST_PAGE_CEILING}`, values)).rows;
      for (const row of batch) {
        if (!foldForSearch(`${row.name} ${row.reference} ${row.status} ${JSON.stringify(row.data)}`).includes(search)) continue;
        if (total >= offset && (limit === undefined || items.length < limit)) items.push(rowToRecord(row));
        total++;
      }
      if (batch.length < LIST_PAGE_CEILING) break;
      const last = batch.at(-1)!; cursor = { at: last.cursor_at, id: last.id };
    }
  }
  const nextOffset = offset + items.length < total ? offset + items.length : undefined;
  return nextOffset === undefined ? { items, total } : { items, total, nextOffset };
}

/** Priority queues are counted and paged by PostgreSQL. Only the page and its
 * linked records cross the repository boundary; no writable state is loaded. */
export async function listQueue(context: StoreContext, merchantId: string, queue: QueueName, query: QueueQuery) {
  const session = sessionFor(context);
  await readMerchant(context, merchantId);
  const view = queueView(queue, query.view), limit = query.limit || 25;
  const values: unknown[] = [merchantId, session.workspace.id, session.principal, context.now, query.owner || '', query.type || '', query.record || '', foldForSearch(query.q || '')];
  // PostgreSQL 16's input check also handles malformed legacy dates without failing a queue.
  const timestamp = (text: string) => `CASE WHEN pg_input_is_valid(${text},'timestamp with time zone') THEN (CASE WHEN length(${text})=10 THEN ${text} || 'T00:00:00Z' ELSE ${text} END)::timestamptz END`;
  const dueData = `CASE WHEN r.kind='attempts' THEN d.data ELSE r.data END`;
  const deadline = queue === 'exceptions' ? "r.data->>'dueBy'" : queue === 'mandates' ? "r.data->>'activationDeadline'" : `(${dueData})->>'dueDate'`;
  const owner = queue === 'collections' ? `coalesce(nullif((${dueData})->>'owner',''),'unassigned')` : "coalesce(nullif(r.data->>'owner',''),'Unassigned')";
  const kind = queue === 'collections' ? "(r.kind='due-items' OR r.kind='attempts' AND r.status='failed')" : `r.kind='${queue}'`;
  const unpaid = `coalesce((CASE WHEN r.kind='attempts' THEN d.status ELSE r.status END) NOT IN ('paid','closed','cancelled'),false)`;
  const overdue = queue === 'collections' ? `(CASE WHEN length(deadline)=10 THEN deadline < to_char($4::timestamptz AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD') ELSE deadline_at < $4::timestamptz END)` : 'deadline_at < $4::timestamptz';
  // Count/order only this queue's kinds. A failed attempt's instalment is read
  // by primary key from the same lender, one index probe per attempt: joining
  // the scoped set to itself made PostgreSQL compare every attempt with every
  // instalment (38 million pairs for one page of a 6,000-instalment lender).
  // OFFSET 0 keeps the lookup a primary-key probe whatever the statistics say:
  // as a plain join, a lender loaded since the last ANALYZE was estimated at
  // one row and each attempt scanned all its instalments (22 s for a
  // 25,000-record lender, past the statement limit). The lender and kind are
  // checked on the row the probe found.
  const cte = `WITH scoped AS (SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${kind}),
    b AS (SELECT r.*, ${deadline} AS deadline, ${timestamp(deadline)} AS deadline_at, ${owner} AS queue_owner,
      ${unpaid} AS unpaid, ${timestamp("r.data->>'occurredAt'")} AS attempt_at
      FROM scoped r LEFT JOIN LATERAL (SELECT d.merchant_id,d.kind,d.status,d.data FROM valopay_records d WHERE r.kind='attempts' AND d.id=r.data->>'dueItemId' OFFSET 0) d
        ON d.merchant_id=r.merchant_id AND d.kind='due-items' WHERE ${kind}),
    q AS (SELECT b.*,coalesce(${overdue},false) AS overdue,
      coalesce(CASE WHEN length(deadline)=10 THEN deadline ELSE to_char(deadline_at AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD') END = to_char($4::timestamptz AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD'),false) AS today FROM b)`;
  const conditions: Record<string, string> = queue === 'exceptions' ? {
    open: "status NOT IN ('closed','resolved')", high: "status NOT IN ('closed','resolved') AND data->>'severity'='high'",
    overdue: "status NOT IN ('closed','resolved') AND overdue", 'due-today': "status NOT IN ('closed','resolved') AND today", resolved: "status IN ('closed','resolved')",
  } : queue === 'mandates' ? { all: 'true', 'awaiting-activation': "status='pending_activation'", overdue: "status='pending_activation' AND overdue", 'due-today': "status='pending_activation' AND today" }
    : { all: "kind='due-items'", overdue: "kind='due-items' AND unpaid AND overdue", 'due-today': "kind='due-items' AND unpaid AND today", failed: "kind='attempts'" };
  const searchText = (expression: string) => `lower(regexp_replace(normalize(${expression},NFD), U&'[\\0300-\\036f]', '', 'g'))`;
  const searchFilter = `($8='' OR position($8 in ${searchText("concat_ws(' ',name,reference)")})>0 OR EXISTS(SELECT 1 FROM valopay_records c WHERE c.merchant_id=$1 AND c.kind='customers' AND c.id=q.customer_id AND position($8 in ${searchText("concat_ws(' ',c.name,c.reference)")})>0))`;
  const ownerFilter = searchFilter + " AND ($5='' OR queue_owner=$5) AND ($6='' OR data->>'type'=$6)";
  const selected = `${ownerFilter} AND (CASE WHEN $7<>'' THEN id=$7 ELSE (${conditions[view]}) END)`;
  const order = (queue === 'exceptions' ? "overdue DESC,CASE data->>'severity' WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,"
    : queue === 'mandates' ? "(status='pending_activation') DESC," : '(unpaid AND overdue) DESC,unpaid DESC,') + `deadline_at ASC NULLS LAST,${queue === 'collections' ? 'attempt_at ASC NULLS LAST,' : ''}id COLLATE "C"`;
  const summary = (await session.client.query<{ counts: Record<string, number>; owners: string[]; types: string[]; total: string }>(`${cte} SELECT
    json_build_object(${queueViews[queue].map(key => `'${key}',count(*) FILTER (WHERE ${ownerFilter} AND (${conditions[key]}))`).join(',')}) AS counts,
    coalesce(array_agg(DISTINCT queue_owner),ARRAY[]::text[]) AS owners,
    coalesce(array_agg(DISTINCT coalesce(data->>'type','unknown')),ARRAY[]::text[]) AS types,
    count(*) FILTER (WHERE ${selected}) AS total FROM q`, values)).rows[0]!;
  const total = Number(summary.total);
  let offset = Math.min(query.offset || 0, Math.max(0, Math.ceil(total / limit) - 1) * limit);
  if (query.target) {
    const located = (await session.client.query<{ position: string }>(`${cte}, ranked AS (SELECT id,row_number() OVER (ORDER BY ${order})-1 AS position FROM q WHERE ${selected}) SELECT position FROM ranked WHERE id=$9`, [...values, query.target])).rows[0];
    if (located) offset = Math.floor(Number(located.position) / limit) * limit;
  }
  const items = (await session.client.query<RecordRow>(`${cte} SELECT * FROM q WHERE ${selected} ORDER BY ${order} OFFSET $9 LIMIT $10`, [...values, offset, limit])).rows.map(rowToRecord);
  const related = new Map<string, ValopayRecord>();
  // Up to three link hops: attempt → instalment → mandate → policy. Each hop is lender scoped.
  for (let hop = 0; hop < 3; hop++) {
    const ids = [...new Set([...items, ...related.values()].flatMap(row => [row.customerId, row.data.dueItemId, row.data.mandateId, row.data.policyId]).filter((id): id is string => typeof id === 'string' && !!id && !related.has(id)))];
    if (!ids.length) break;
    const rows = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind IN ('customers','due-items','mandates','policies') AND r.id=ANY($4::text[])`, values.slice(0, 3).concat([ids]))).rows;
    for (const row of rows) related.set(row.id, rowToRecord(row));
  }
  const dueIds = [...items, ...related.values()].filter(row => row.kind === 'due-items').map(row => row.id);
  if (dueIds.length) {
    const rows = (await session.client.query<RecordRow>(`SELECT DISTINCT ON (r.data->>'dueItemId') ${recordColumns} ${scopedRecordsFrom}
      WHERE ${scopedRecordsWhere} AND r.kind='attempts' AND r.status='failed' AND r.data->>'dueItemId'=ANY($4::text[])
      ORDER BY r.data->>'dueItemId',coalesce(${timestamp("r.data->>'occurredAt'")},r.created_at) DESC,r.id COLLATE "C"`, values.slice(0, 3).concat([dueIds]))).rows;
    for (const row of rows) related.set(row.id, rowToRecord(row));
  }
  if (queue === 'mandates' && query.record) {
    const rows = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='mandates' AND r.data->>'reissuedFrom'=$4 ORDER BY r.created_at DESC,r.id LIMIT 100`, values.slice(0, 3).concat(query.record))).rows;
    for (const row of rows) related.set(row.id, rowToRecord(row));
  }
  return { items, related: [...related.values()], total, offset, counts: summary.counts, owners: summary.owners.sort(), types: summary.types.sort(), asOf: context.now };
}

/** All queue predicates execute inside the same lender-locked read transaction. */
export async function listReconciliation(context: StoreContext, merchantId: string, queue: ReconciliationQueue, query: ReadPageQuery) {
  const session = sessionFor(context), merchant = await readMerchant(context, merchantId);
  const scope = [merchantId, session.workspace.id, session.principal];
  const limit = query.limit || 25;
  const select = (where: string) => `SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${where}`;
  let precision: ReturnType<typeof precisionAudit> | undefined;
  let sampledIds: string[] = [];
  if (queue === 'audit') {
    const month = previousMonth(context.now), seed = `${merchantId}:${month}`, { start, end } = periodBounds(month);
    // The audit month is a WAT month: confirmedAt (or the creation time) as a UTC ISO string inside [start, end). Stored
    // instants are UTC timestamps or dates, which compare as strings in the "C" collation the way the domain parses them.
    const at = `coalesce(nullif(r.data->>'confirmedAt',''),to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) COLLATE "C"`;
    const predicate = `r.kind='allocations' AND r.status IN ('confirmed','superseded') AND r.data->'automatic'='true'::jsonb AND r.data->>'confidence'='certain' AND ${at}>=$4 AND ${at}<$5`;
    const population = Number((await session.client.query<{total:string}>(`SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${predicate}`, [...scope,start,end])).rows[0]!.total);
    const sample = (await session.client.query<RecordRow>(`${select(predicate)} ORDER BY sha256(convert_to($6 || ':' || r.id,'UTF8')),r.id COLLATE "C" LIMIT $7`, [...scope,start,end,seed,measurementRules.precisionSampleSize])).rows.map(rowToRecord);
    precision = { ...precisionAudit({merchant:merchant.info,settings:merchant.settings,records:sample},context.now), population, requiredSample:Math.min(measurementRules.precisionSampleSize,population) };
    sampledIds = precision.sampledAllocationIds;
  }
  const conditions = { proposals:"r.kind='allocations' AND r.status='proposed'", duplicates:"r.kind='payments' AND r.status='possible_duplicate'", payments:`r.kind='payments' AND (r.status='unallocated' OR (r.status IN ('partial','overpaid') AND ${paymentUnappliedSql}>0))`, observations:"r.kind='observations' AND r.status='unresolved'", audit:"r.kind='allocations' AND r.id=ANY($5::text[])", batches:"r.kind='settlement-batches'" };
  const due = query.dueItem ? (await session.client.query<RecordRow>(select("r.kind='due-items' AND r.id=$4"),[...scope,query.dueItem])).rows[0] : undefined;
  const related = new Map<string,ValopayRecord>();
  if (due) related.set(due.id,rowToRecord(due));
  // An unavailable focus fails closed rather than showing the whole lender.
  const focus = !query.dueItem ? 'true' : !due ? 'false' : queue === 'proposals' ? "r.data->>'dueItemId'=$4" : queue === 'observations' ? "(r.data->>'dueItemId'=$4 OR ($6<>'' AND r.customer_id=$6))" : "($6<>'' AND r.customer_id=$6)";
  // All parameters are referenced in every variant so PostgreSQL can infer their types.
  const fold = (value:string) => `lower(regexp_replace(normalize(${value},NFD), U&'[\\0300-\\036f]', '', 'g'))`;
  const searchFilter = `($7='' OR position($7 in ${fold("concat_ws(' ',r.name,r.reference)")})>0 OR EXISTS (
    SELECT 1 FROM valopay_records linked LEFT JOIN valopay_records customer ON customer.merchant_id=r.merchant_id AND customer.kind='customers' AND customer.id=linked.customer_id
    WHERE linked.merchant_id=r.merchant_id AND linked.kind IN ('customers','payments','due-items') AND linked.id=ANY(ARRAY[r.customer_id,r.data->>'paymentId',r.data->>'dueItemId'])
    AND position($7 in ${fold("concat_ws(' ',linked.name,linked.reference,customer.name,customer.reference)")})>0))`;
  const where = `${searchFilter} AND (${conditions[queue]}) AND (${focus}) AND $4::text IS NOT NULL AND $5::text[] IS NOT NULL AND $6::text IS NOT NULL`;
  const values = [...scope, query.dueItem || '', sampledIds, due?.customer_id || '', foldForSearch(query.q || '').trim()];
  const total = Number((await session.client.query<{total:string}>(`SELECT count(*) AS total ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND ${where}`,values)).rows[0]!.total);
  const offset = pageOffset(total,limit,query.offset);
  const items = (await session.client.query<RecordRow>(`${select(where)} ORDER BY r.created_at DESC,r.id DESC OFFSET $8 LIMIT $9`,[...values,offset,limit])).rows.map(rowToRecord);
  for (let hop=0;hop<2;hop++) {
    const ids = [...new Set([...items,...related.values()].flatMap(r=>[r.customerId,r.data.paymentId,r.data.dueItemId]).filter((id):id is string=>typeof id==='string' && !!id && !related.has(id)))];
    if (!ids.length) break;
    const rows = (await session.client.query<RecordRow>(select("r.kind IN ('customers','payments','due-items') AND r.id=ANY($4::text[])"),[...scope,ids])).rows;
    for (const row of rows) related.set(row.id,rowToRecord(row));
  }
  return {items,related:[...related.values()],total,offset,asOf:context.now,...(precision?{precision}:{})};
}

const closeSummaryData = `jsonb_strip_nulls(jsonb_build_object('summary',r.data->'summary','closedAt',r.data->'closedAt','schedule',r.data->'schedule','positionAlert',r.data->'positionAlert',
  'report',CASE WHEN r.data ? 'report' THEN jsonb_build_object('unallocated',jsonb_build_object('kobo',r.data#>'{report,unallocated,kobo}'),'exceptions',jsonb_build_object('openAtClose',r.data#>'{report,exceptions,openAtClose}')) END))`;

export async function listCloseHistory(context: StoreContext, merchantId: string, query: ReadPageQuery) {
  validateCloseRange(query.from,query.to);
  const session = sessionFor(context); await readMerchant(context,merchantId);
  const values = [merchantId,session.workspace.id,session.principal,query.from || '',query.to || ''];
  const base = `${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='closes'`;
  const day = "to_char(r.created_at AT TIME ZONE 'Africa/Lagos','YYYY-MM-DD')";
  const range = `($4='' OR ${day}>=$4) AND ($5='' OR ${day}<=$5)`;
  const counts = (await session.client.query<{total:string;all_total:string}>(`SELECT count(*) AS all_total,count(*) FILTER(WHERE ${range}) AS total ${base}`,values)).rows[0]!;
  const total = Number(counts.total),limit=query.limit || 25,offset=pageOffset(total,limit,query.offset);
  const select = `SELECT ${recordColumns.replace('r.data',closeSummaryData+' AS data')} ${base} AND ${range}`;
  const items = (await session.client.query<RecordRow>(`${select} ORDER BY r.created_at DESC,r.id DESC OFFSET $6 LIMIT $7`,[...values,offset,limit])).rows.map(rowToRecord);
  const endpoints = total ? (await session.client.query<RecordRow>(`(${select} ORDER BY r.created_at,r.id LIMIT 1) UNION ALL (${select} ORDER BY r.created_at DESC,r.id DESC LIMIT 1)`,values)).rows.map(rowToRecord) : [];
  return {items,total,allTotal:Number(counts.all_total),offset,...(total?{first:endpoints[0]!,latest:endpoints[1]!}:{})};
}
export async function getCloseDetail(context: StoreContext, merchantId:string, id:string) {
  const session=sessionFor(context); await readMerchant(context,merchantId);
  const row=(await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind='closes' AND r.id=$4`,[merchantId,session.workspace.id,session.principal,id])).rows[0];
  if (!row) fail('Close record not found in this lender.',404);
  return rowToRecord(row);
}

/** Read-only reports keep the measures needed by historical calculations, without
 * pulling large REC-07 evidence arrays into every summary request. */
export async function loadReportsView(context:StoreContext,merchantId:string):Promise<DomainState> {
  const session=sessionFor(context),merchant=await readMerchant(context,merchantId);
  const data = `CASE WHEN r.kind='closes' THEN ${closeSummarySql} ELSE r.data END AS data`;
  const rows=(await session.client.query<RecordRow>(`SELECT ${recordColumns.replace('r.data',data)} ${scopedRecordsFrom} WHERE ${scopedRecordsWhere} AND r.kind NOT IN ('audit','observations','notifications','retry-decisions') ORDER BY r.created_at,r.id`,[merchantId,session.workspace.id,session.principal])).rows;
  return {merchant:merchant.info,settings:merchant.settings,records:rows.map(rowToRecord)};
}

/** paymentRefundedKobo in SQL: for a refund (including the legacy spelling), data.refundedKobo when it is a whole non-negative safe number, else the whole payment. */
const paymentRefundedSql = `(CASE WHEN coalesce(r.data->>'refundStatus','') IN ('refunded','recorded_externally') THEN CASE WHEN jsonb_typeof(r.data->'refundedKobo')='number'
  THEN CASE WHEN (r.data->>'refundedKobo')::numeric BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER} AND (r.data->>'refundedKobo')::numeric=trunc((r.data->>'refundedKobo')::numeric) THEN (r.data->>'refundedKobo')::numeric ELSE r.amount_kobo END
  ELSE r.amount_kobo END ELSE 0 END)`;
/** paymentMoneyReturned in SQL: reversed by the provider, or refunded in full. Returned money is no customer's credit. */
const paymentReturnedSql = `(coalesce(r.data->>'reversalStatus','')='reversed' OR (coalesce(r.data->>'refundStatus','') IN ('refunded','recorded_externally') AND ${paymentRefundedSql}>=r.amount_kobo))`;
/** paymentUnappliedKobo in SQL: what a payment holds that is neither applied nor returned by a refund. */
const paymentUnappliedSql = `CASE WHEN ${paymentReturnedSql} THEN 0 ELSE greatest(0,r.amount_kobo-coalesce((r.data->>'allocatedKobo')::numeric,0)-${paymentRefundedSql}) END`;

/** Read-only customer cards and events are paged; balances aggregate every related record. */
export async function getCustomerHistory(context: StoreContext, merchantId: string, id: string, query: CustomerHistoryQuery) {
  const session = sessionFor(context); await readMerchant(context, merchantId);
  const values = [merchantId, session.workspace.id, session.principal, id];
  const base = `${scopedRecordsFrom} WHERE ${scopedRecordsWhere}`;
  const customerRow = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${base} AND r.kind='customers' AND r.id=$4`, values)).rows[0];
  if (!customerRow) fail('Customer not found.', 404);
  const totalsRow = (await session.client.query<Record<string,string>>(`SELECT count(*) AS events,
    count(*) FILTER(WHERE r.kind='mandates') AS mandates, count(*) FILTER(WHERE r.kind='due-items') AS "dueItems", count(*) FILTER(WHERE r.kind='payments') AS payments,
    coalesce(sum(r.amount_kobo) FILTER(WHERE r.kind='due-items' AND r.status<>'cancelled'),0) AS obligations,
    coalesce(sum(r.amount_kobo) FILTER(WHERE r.kind='allocations' AND r.status='confirmed'),0) AS allocated,
    coalesce(sum(${paymentUnappliedSql}) FILTER(WHERE r.kind='payments'),0) AS credit
    ${base} AND r.customer_id=$4`,values)).rows[0]!;
  const totals = {} as Record<HistorySection,number>, offsets = {} as Record<HistorySection,number>;
  const pages = {} as Record<HistorySection,ValopayRecord[]>;
  for (const section of historySections) {
    const limit = Math.min(query[`${section}Limit`] || 25,100);
    totals[section] = Number(totalsRow[section]);
    offsets[section] = pageOffset(totals[section],limit,query[`${section}Offset`]);
    const predicate = historyKind[section] ? `AND r.kind='${historyKind[section]}'` : '';
    pages[section] = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${base} AND r.customer_id=$4 ${predicate} ORDER BY r.created_at DESC,r.id DESC OFFSET $5 LIMIT $6`,[...values,offsets[section],limit])).rows.map(rowToRecord);
  }
  const focusedRow = query.record ? (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${base} AND r.customer_id=$4 AND r.id=$5`,[...values,query.record])).rows[0] : undefined;
  const obligationsKobo = Number(totalsRow.obligations), allocatedKobo = Number(totalsRow.allocated);
  return {customer:rowToRecord(customerRow),position:{obligationsKobo,allocatedKobo,outstandingKobo:Math.max(0,obligationsKobo-allocatedKobo),unallocatedKobo:Number(totalsRow.credit),note:positionNote},...pages,totals,offsets,...(focusedRow?{focusedRecord:rowToRecord(focusedRow)}:{})};
}

/** Complete customer history and balances without every other customer's data.
 * This read has no mutable snapshot: passing it to saveState is rejected. */
export async function loadCustomerView(context: StoreContext, merchantId: string, customerId: string): Promise<DomainState> {
  const session = sessionFor(context), merchant = await readMerchant(context, merchantId);
  const records = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom}
    WHERE ${scopedRecordsWhere} AND ((r.kind='customers' AND r.id=$4) OR r.customer_id=$4) ORDER BY r.created_at,r.id`,
    [merchantId, session.workspace.id, session.principal, customerId])).rows.map(rowToRecord);
  return { merchant: merchant.info, settings: merchant.settings, records };
}

/** Settings only need integrations, the calendar and close history. */
export async function loadSettingsView(context: StoreContext, merchantId: string): Promise<DomainState> {
  const session = sessionFor(context), merchant = await readMerchant(context, merchantId);
  const records = (await session.client.query<RecordRow>(`SELECT ${recordColumns} ${scopedRecordsFrom}
    WHERE ${scopedRecordsWhere} AND r.kind IN ('integrations','calendar','closes') ORDER BY r.created_at,r.id`,
    [merchantId, session.workspace.id, session.principal])).rows.map(rowToRecord);
  return { merchant: merchant.info, settings: merchant.settings, records };
}

/** The stored answer for an idempotency key, when the request was already made: kept under `id` (receiptOf), or
 * under `earlier`, where an earlier build kept it. */
export async function findIdempotency(context: StoreContext, id: string, earlier?: string) {
  const session = sessionFor(context);
  const merchantId = lockedMerchant(session);
  const found = (await session.client.query<{ id: string; request_hash: string; response: any }>(
    `SELECT i.id,i.request_hash,i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id
     JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE i.id=ANY($1::text[]) AND i.merchant_id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4
     ORDER BY i.id=$5 DESC LIMIT 1`,
    [earlier === undefined || earlier === id ? [id] : [id, earlier], merchantId, session.workspace.id, session.principal, id],
  )).rows[0];
  if(found?.response?.purged)fail('This request already completed and its retained payload has expired. It cannot run again.',410);
  return found ? { request_hash: found.request_hash, response: await revealStored(found.response,{lender:merchantId,record:found.id,field:'response'}) } : undefined;
}
/** Stores the answer where receiptOf keeps it (`id`), with the request's fingerprint, so a replay with different input is refused. */
export async function saveIdempotency(context: StoreContext, id: string, requestHash: string, response: unknown) {
  const session = sessionFor(context);
  const merchantId = lockedMerchant(session);
  const owned = await session.client.query(scopedMerchantQuery(), [merchantId, session.workspace.id, session.principal]);
  if (!owned.rows[0]) fail("Lender not found in this workspace.", 404);
  try {
    const inserted = await session.client.query(
      `INSERT INTO valopay_idempotency(id,merchant_id,request_hash,response)
       SELECT $1,$2,$3,$4 WHERE EXISTS (
         SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
         WHERE m.id=$2 AND m.workspace_id=$5 AND w.id=$5 AND w.principal_hash=$6)`,
      [id, merchantId, requestHash, await protectStored(response,{lender:merchantId,record:id,field:'response'}), session.workspace.id, session.principal],
    );
    if (!rowsAffected(inserted)) fail("Lender not found in this workspace.", 404);
    await completeOperation(context, response);
  } catch (error: any) {
    if (error?.code === "23505") conflict("This idempotency key is already in use.");
    throw error;
  }
}
/** Switches the workspace's demo persona. */
export async function changeRole(context: StoreContext, role: string) {
  const session = sessionFor(context);
  if (context.accessMode === 'staff') fail('Staff cannot switch demo personas.', 403);
  if (session.access !== "persona") conflict("A persona change requires an exclusive workspace transaction.");
  if (!roles.includes(role)) fail("Unknown sandbox persona.");
  const result = await session.client.query(
    "UPDATE valopay_workspaces SET role=$3 WHERE id=$1 AND principal_hash=$2",
    [session.workspace.id, session.principal, role],
  );
  if (!rowsAffected(result)) fail("Workspace not found.", 404);
  session.workspace.role = role;
}

function lockedMerchant(session: Session): string {
  if (session.access === "read") fail("A read transaction cannot write lender data.", 409);
  if (!session.lockedMerchantId || !session.snapshot) fail("Load a lender before using this repository operation.", 409);
  return session.lockedMerchantId;
}
function reference(record: ValopayRecord, id: unknown, kind: string, label: string, all: Map<string, ValopayRecord>): ValopayRecord {
  const recordId = typeof id === "string" && id ? id : conflict(`${label} is required.`);
  const target = all.get(recordId) ?? conflict(`${label} must reference a ${kind} in this lender.`);
  if (target.kind !== kind || target.merchantId !== record.merchantId) conflict(`${label} must reference a ${kind} in this lender.`);
  return target;
}
/** Pure guard exported for focused repository guard tests. */
function isExportRetry(before: ValopayRecord, after: ValopayRecord, now?: string): boolean {
  const expired = before.status === "running" && !!now && (!before.data.leaseExpiresAt || Date.parse(String(before.data.leaseExpiresAt)) <= Date.parse(now));
  if (after.status !== "queued" || !(before.status === "failed" || expired)) return false;
  const cleared = ["leaseToken", "leaseExpiresAt", "lastError"];
  if (cleared.some(key => after.data[key] !== undefined)) return false;
  if (after.data.stage !== 'queued' || after.data.lastProgressAt !== now) return false;
  const stableData = (record: ValopayRecord) => Object.fromEntries(Object.entries(record.data).filter(([key]) => ![...cleared, 'stage', 'lastProgressAt'].includes(key)));
  // A retry cannot change the request, private object identity, attempts,
  // checksum, customer or any prior evidence; it only clears the old lease/error.
  return sameJson({ ...after, status: before.status, updatedAt: before.updatedAt, data: stableData(after) }, { ...before, data: stableData(before) });
}

/**
 * The repository's final-state checks. `unchanged` names records whose JSON is
 * identical to the loaded snapshot: they passed these checks when they were
 * written, so only added and changed records are compared field by field.
 */
export function assertFinalState(snapshot: DomainState, state: DomainState, merchantId: string, now?: string, unchanged: ReadonlySet<string> = new Set()) {
  if (state.merchant.id !== merchantId || snapshot.merchant.id !== merchantId) conflict("Lender identity cannot be reassigned.");
  const final = new Map<string, ValopayRecord>();
  for (const record of state.records) {
    if (final.has(record.id)) conflict("Duplicate record IDs are not permitted.");
    if (record.merchantId !== merchantId) conflict("Records cannot be moved between lenders.");
    if (!Number.isSafeInteger(record.amountKobo) || record.amountKobo < 0 || record.amountKobo > Number.MAX_SAFE_INTEGER) conflict("Amounts must be safe non-negative integer kobo.");
    if (record.kind === "due-items" && record.amountKobo < 500000) conflict("Debits under ₦5,000 are refused.");
    final.set(record.id, record);
  }
  const original = new Map(snapshot.records.map((record) => [record.id, record]));
  for (const [id, before] of original) {
    const after = final.get(id);
    const present = after ?? conflict("Records cannot be deleted.");
    if (unchanged.has(id)) continue;
    if (present.id !== before.id || present.merchantId !== before.merchantId || present.kind !== before.kind || present.createdAt !== before.createdAt) {
      conflict("Record identity, lender, kind, and creation time are immutable.");
    }
    // A payment's payer, once its evidence named one or Finance identified it, is never reassigned.
    if (before.kind === "payments" && before.customerId && present.customerId !== before.customerId) conflict("A payment's payer cannot change once it is recorded.");
    const retentionChange=()=>{
      const kind=before.kind==='exports'?'export_file':'raw_csv';
      const receipt=[...final.values()].find(r=>r.kind==='retention-receipts'&&!original.has(r.id)&&r.data.sourceId===before.id&&r.data.kind===kind&&['deleted','already_absent'].includes(r.data.result));
      const run=receipt&&original.get(receipt.data.runId);
      if(!run||run.kind!=='retention-runs'||!['approved','running','attention'].includes(run.status)||!run.data.candidates.some((c:any)=>c.sourceId===before.id&&c.kind===kind&&c.version===before.updatedAt))return false;
      const expected=structuredClone(before);expected.updatedAt=present.updatedAt;
      if(kind==='raw_csv'){delete expected.data.csv;if(expected.data.check)delete expected.data.check.preview;expected.data.rawCsvRemovedAt=now;expected.data.rawCsvRetentionRunId=run.id;}
      else {expected.data.fileDeletedAt=now;expected.data.fileRetentionRunId=run.id;}
      return sameJson(expected,present);
    };
    if (["audit", "exports", "reviews", "closes", "retry-decisions", "invoices", "connected-credit-assessments", "connected-credit-reviews", "case-events", "import-revisions", "import-corrections", "import-correction-events", "source-manifests", "close-review-events", "work-events", "retention-policies", "retention-holds", "retention-receipts"].includes(before.kind) && !sameJson(present, before)
      && !(before.kind === "exports" && (isExportRetry(before, present, now)||retentionChange()))) conflict("Evidence records are immutable.");
    if (["policies", "templates", "experiments"].includes(before.kind) && ["approved", "preregistered", "closed"].includes(before.status) && !sameJson(present, before)) {
      conflict("Approved, preregistered, and closed versions are immutable.");
    }
    if (before.kind === 'provider-events') assertProviderEventChange(before,present);
    if (before.kind === 'source-profiles' && ['source','kind'].some(key=>!sameJson(before.data[key],present.data[key]))) conflict('A source profile cannot change its source or record type.');
    if (before.kind === 'import-batches' && before.status === 'committed' && !sameJson(present, before)&&!retentionChange()) conflict('Committed source batches are immutable.');
    if(before.kind==='close-reviews'&&!sameJson(present,before)){
      const expected=structuredClone(before);expected.status=present.status;expected.updatedAt=present.updatedAt;
      for(const field of ['decidedBy','decidedPrincipal','decidedAt','decisionNote','sourceExceptions'])expected.data[field]=present.data[field];
      if(before.status!=='awaiting_review'||!['approved','changes_requested'].includes(present.status)||!sameJson(expected,present))conflict('The prepared close snapshot and recorded decision are immutable.');
    }
    if(before.kind==='retention-runs'&&['candidates','previewDigest','policyRevision','expiresAt','preparedBy'].some(key=>!sameJson(before.data[key],present.data[key])))conflict('The approved retention manifest is immutable.');
    if (before.data.importIdentity && !sameJson(present.data.importIdentity, before.data.importIdentity)) conflict('Source row provenance is immutable.');
    assertImportedCorrectionChange(before, present, snapshot, state);
  }
  const dueReferences = new Set<string>(), observations = new Set<string>(), inflight = new Set<string>();
  const allocatedPayments = new Map<string, number>(), allocatedDues = new Map<string, number>();
  const changed = (record: ValopayRecord, ...keys: string[]) => {
    if (unchanged.has(record.id)) return false;
    const before = original.get(record.id);
    return !before || keys.some((key) => !sameJson(before.data[key], record.data[key]));
  };
  const changedCustomer = (record: ValopayRecord) => {
    if (unchanged.has(record.id)) return false;
    const before = original.get(record.id);
    return !before || before.customerId !== record.customerId;
  };
  const optionalReference = (record: ValopayRecord, key: string, kind: string, label: string) => {
    if (record.data[key] !== undefined && record.data[key] !== null && record.data[key] !== "" && changed(record, key)) {
      return reference(record, record.data[key], kind, label, final);
    }
    return undefined;
  };
  const anyReference = (record: ValopayRecord, key: string, label: string) => {
    if (record.data[key] === undefined || record.data[key] === null || record.data[key] === "" || !changed(record, key)) return;
    const target = final.get(String(record.data[key]));
    if (!target || target.merchantId !== record.merchantId) conflict(`${label} must belong to this lender.`);
  };
  for (const record of final.values()) {
    if (record.customerId && changedCustomer(record)) reference(record, record.customerId, "customers", "Customer", final);
    // Shared data links are verified only when a new/changed state introduces
    // them; this protects writes without reinterpreting historical snapshots.
    optionalReference(record, "policyId", "policies", "Policy");
    optionalReference(record, "mandateId", "mandates", "Mandate");
    optionalReference(record, "dueItemId", "due-items", "Due item");
    optionalReference(record, "paymentId", "payments", "Payment");
    optionalReference(record, "noticeId", "notifications", "Notice");
    optionalReference(record, "experimentId", "experiments", "Experiment");
    optionalReference(record, "proposedDueItemId", "due-items", "Proposed due item");
    optionalReference(record, "virtualAccountCustomerId", "customers", "Virtual-account customer");
    optionalReference(record, "settlementBatchId", "settlement-batches", "Settlement batch");
    optionalReference(record, "countedInBatchId", "settlement-batches", "Settlement batch counting the line");
    optionalReference(record, "statementObservationId", "observations", "Statement observation");
    anyReference(record, "linkedRecordId", "Exception link");
    if (record.data.lineObservationIds !== undefined && changed(record, "lineObservationIds")) {
      if (!Array.isArray(record.data.lineObservationIds)) conflict("Settlement batch observation IDs must be an array.");
      for (const id of record.data.lineObservationIds) reference(record, id, "observations", "Settlement batch observation", final);
    }
    if (record.kind === "due-items") {
      if (record.reference) { if (dueReferences.has(record.reference)) conflict("Due-item reference already exists."); dueReferences.add(record.reference); }
      const mandate = optionalReference(record, "mandateId", "mandates", "Due-item mandate")
        || (changedCustomer(record) && record.data.mandateId ? reference(record, record.data.mandateId, "mandates", "Due-item mandate", final) : undefined);
      if (mandate && mandate.customerId !== record.customerId) conflict("Due-item mandate must belong to the same customer.");
      const outstanding = record.data.outstandingKobo;
      if (outstanding !== undefined && (!Number.isSafeInteger(outstanding) || outstanding < 0 || outstanding > record.amountKobo)) conflict("Outstanding balance is invalid.");
    }
    if (record.kind === "attempts") {
      // Attempts are facts, so their required parent remains checked on every
      // save.  This also permits the in-flight uniqueness calculation below.
      const due = reference(record, record.data.dueItemId, "due-items", "Attempt due item", final);
      const before = original.get(record.id);
      if ((!before || changed(record, "dueItemId") || changedCustomer(record) || before.amountKobo !== record.amountKobo)
        && (due.customerId !== record.customerId || record.amountKobo !== due.amountKobo)) {
        conflict("Attempt must match its due item and customer.");
      }
      if (["scheduled", "sent", "unknown"].includes(record.status)) {
        if (inflight.has(due.id)) conflict("Only one in-flight attempt is allowed for a due item.");
        inflight.add(due.id);
      }
    }
    if (record.kind === "observations") {
      const due = optionalReference(record, "dueItemId", "due-items", "Observation due item")
        || (changedCustomer(record) && record.data.dueItemId ? reference(record, record.data.dueItemId, "due-items", "Observation due item", final) : undefined);
      if (due && record.customerId && due.customerId !== record.customerId) conflict("Observation due item must belong to its customer.");
      if (record.data.eventId !== undefined && record.data.eventId !== null) {
        const key = `${String(record.data.source)}\u0000${String(record.data.eventId)}`;
        if (observations.has(key)) conflict("Observation already exists for this source event.");
        observations.add(key);
      }
    }
    if (record.kind === "payments") {
      const due = optionalReference(record, "dueItemId", "due-items", "Payment due item")
        || optionalReference(record, "proposedDueItemId", "due-items", "Proposed due item")
        || (changedCustomer(record) && record.data.dueItemId ? reference(record, record.data.dueItemId, "due-items", "Payment due item", final) : undefined)
        || (changedCustomer(record) && record.data.proposedDueItemId ? reference(record, record.data.proposedDueItemId, "due-items", "Proposed due item", final) : undefined);
      if (due && record.customerId && due.customerId !== record.customerId) conflict("Payment due item must belong to its customer.");
    }
    if (record.kind === "allocations") {
      // Every allocation status carries durable parent IDs; confirmed rows add
      // the final-state amount constraints below.
      const payment = reference(record, record.data.paymentId, "payments", "Allocation payment", final);
      const due = reference(record, record.data.dueItemId, "due-items", "Allocation due item", final);
      // A superseded allocation applies nothing, such as a proposal withdrawn when Finance identified another payer.
      if (record.status !== "superseded" && payment.customerId && due.customerId && payment.customerId !== due.customerId) conflict("Allocation payment and due item must have the same customer.");
      // A proposal for a payment whose evidence named no payer carries no customer until Finance identifies the payer.
      if (record.customerId && (record.customerId !== payment.customerId || record.customerId !== due.customerId)) conflict("Allocation customer must match its parents.");
      if (record.status === "confirmed") {
        // Evidence that named no payer is applied only once Finance has identified the payer.
        if (!payment.customerId || record.customerId !== payment.customerId) conflict("A payment is applied to an instalment only once its payer is identified.");
        allocatedPayments.set(payment.id, (allocatedPayments.get(payment.id) || 0) + record.amountKobo);
        allocatedDues.set(due.id, (allocatedDues.get(due.id) || 0) + record.amountKobo);
      }
    }
  }
  for(const record of final.values()) {
    if(record.kind==='connected-intents' && ['authorised','pending','unknown'].includes(record.status)) {
      const due=reference(record,record.data.dueItemId,'due-items','Checkout instalment',final);
      if(due.customerId!==record.customerId) conflict('Checkout customer must match the instalment.');
      if(inflight.has(due.id)) conflict('A pay-by-bank checkout and another collection cannot be in flight together.');
      inflight.add(due.id);
    }
  }
  for (const [id, amount] of allocatedPayments) if (amount > final.get(id)!.amountKobo) conflict("Allocations exceed the payment amount.");
  for (const [id, amount] of allocatedDues) if (amount > final.get(id)!.amountKobo) conflict("Allocations exceed the due-item amount.");
}

/** Persist only a checked diff against the repository-owned snapshot. */
export async function saveState(context: StoreContext, state: DomainState): Promise<void> {
  const session = sessionFor(context);
  const merchantId = lockedMerchant(session);
  const snapshot = session.snapshot!;
  const { changed, unchanged } = changesSince(snapshot, state);
  // A summarised close would overwrite its full stored report; closes are evidence and never change.
  if (changed.some((record) => session.summarised?.has(record.id))) conflict("Evidence records are immutable.");
  advanceChanged(snapshot, changed, context.now);
  // An unchanged record is its own "before": identical JSON is identical content.
  const current = new Map(state.records.map((record) => [record.id, record]));
  const before: DomainState = {
    merchant: JSON.parse(snapshot.merchant), settings: JSON.parse(snapshot.settings),
    records: [...snapshot.records].map(([id, json]) => (unchanged.has(id) ? current.get(id)! : JSON.parse(json) as ValopayRecord)),
  };
  assertFinalState(before, state, merchantId, context.now, unchanged);
  const owned = await session.client.query(scopedMerchantQuery(), [merchantId, session.workspace.id, session.principal]);
  if (!owned.rows[0]) fail("Lender not found in this workspace.", 404);
  const sorted = [...changed].sort((a, b) => {
    const priority = (record: ValopayRecord) => record.kind === "allocations" ? (record.status === "confirmed" ? 3 : 0) : record.kind === "audit" ? 4 : 1;
    return priority(a) - priority(b);
  });
  for (const record of sorted) {
    const values = [record.id, merchantId, record.kind, record.name, record.status, record.reference, record.amountKobo, record.customerId, await protectRecordData(record), record.createdAt, record.updatedAt];
    if (snapshot.records.has(record.id)) {
      const result = await session.client.query(
        `UPDATE valopay_records SET name=$4,status=$5,reference=$6,amount_kobo=$7,customer_id=$8,data=$9,updated_at=$11
         WHERE id=$1 AND merchant_id=$2 AND kind=$3 AND created_at=$10 AND EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$12 AND w.id=$12 AND w.principal_hash=$13)`,
        [...values, session.workspace.id, session.principal],
      );
      if (!rowsAffected(result)) conflict("Record was changed concurrently; reload before retrying.");
    } else {
      const result = await session.client.query(
        `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 WHERE EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$12 AND w.id=$12 AND w.principal_hash=$13)`,
        [...values, session.workspace.id, session.principal],
      );
      if (!rowsAffected(result)) fail("Lender not found in this workspace.", 404);
    }
  }
  const merchantUpdate = await session.client.query(
    `UPDATE valopay_merchants m SET info=$4,settings=$5 WHERE m.id=$1 AND m.workspace_id=$2 AND EXISTS
      (SELECT 1 FROM valopay_workspaces w WHERE w.id=$2 AND w.principal_hash=$3)`,
    [merchantId, session.workspace.id, session.principal, state.merchant, state.settings],
  );
  if (!rowsAffected(merchantUpdate)) fail("Lender not found in this workspace.", 404);
  // A subsequent repository save in this transaction validates against what
  // was just written, never a caller-supplied "previous" array.
  for (const record of changed) snapshot.records.set(record.id, JSON.stringify(record));
  snapshot.merchant = JSON.stringify(state.merchant); snapshot.settings = JSON.stringify(state.settings);
}

export async function lifecycleInventory(context:StoreContext,state:DomainState):Promise<LifecycleExternalCandidate[]> {
 const session=sessionFor(context),merchantId=session.lockedMerchantId;
 // Inventory is also used by GET after loadState acquired a shared lender lock.
 // Physical execution still requires lockedMerchant's exclusive write snapshot.
 if(context.role!=='Admin'||!merchantId||state.merchant.id!==merchantId)fail('An administrator in this lender is required.',403);
 const rows=(await session.client.query<OperationRow>("SELECT * FROM valopay_operations WHERE merchant_id=$1 AND status IN ('completed','cancelled') AND NOT(request ? 'purged') ORDER BY updated_at,id",[merchantId])).rows;
 return [
  ...rows.map(row=>({kind:'journal_payload' as const,merchantId,sourceId:row.id,version:row.updated_at.toISOString(),createdAt:row.updated_at.toISOString(),label:'Terminal operation payload',digest:canonicalDigest({request:row.request,receipt:row.receipt,key:row.request_key,hash:row.request_hash,status:row.status},"legacy-en-us-null"),status:row.status as 'completed'|'cancelled'})),
  ...state.records.filter(r=>r.kind==='exports'&&['ready','failed'].includes(r.status)&&!r.data.fileDeletedAt&&r.data.bucket&&r.data.objectName).map(r=>({kind:'export_file' as const,merchantId,sourceId:r.id,version:r.updatedAt,createdAt:String(r.data.generatedAt||r.updatedAt),label:'Private export file',digest:canonicalDigest({id:r.id,status:r.status,data:r.data},"legacy-en-us-null"),status:r.status as 'ready'|'failed'})),
 ];
}
/** One candidate per request bounds external work and makes progress resumable.
 * The lender lock prevents a hold or retry being introduced during deletion. */
export async function executeLifecycleRun(context:StoreContext,state:DomainState,id:string) {
 const session=sessionFor(context),merchantId=lockedMerchant(session);
 if(context.role!=='Admin'||session.access!=='write'||state.merchant.id!==merchantId)fail('An administrator in this lender is required.',403);
 const run=state.records.find(r=>r.id===id&&r.kind==='retention-runs');if(!run)fail('Retention run not found.',404);
 if(run.status==='completed')return lifecycleRunView(state,run);
 const external=await lifecycleInventory(context,state);
 const attempted=new Set(state.records.filter(r=>r.kind==='retention-receipts'&&r.data.runId===id).map(r=>`${r.data.kind}:${r.data.sourceId}`));
 const candidates=[...run.data.candidates as LifecycleCandidate[]].sort((a,b)=>Number(attempted.has(`${a.kind}:${a.sourceId}`))-Number(attempted.has(`${b.kind}:${b.sourceId}`)));
 // Prepared once: nothing changes the state until the one candidate this request handles, so skipping the run's
 // finished sources costs a lookup each rather than another pass over the lender.
 const check=lifecycleCandidateCheck(state,context,id,external);
 for(const candidate of candidates){
  try{
   if(!check(candidate))continue;
  }catch{return recordLifecycleReceipt(state,context,id,candidate,'blocked','This source changed, is held or no longer meets the approved policy. Review the source and prepare a fresh preview.');}
  try{
   let result:'deleted'|'already_absent'='deleted';
   if(candidate.kind==='raw_csv')eraseLifecycleRawCsv(state,context,id,candidate);
   else if(candidate.kind==='journal_payload'){
    const row=(await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE merchant_id=$1 AND id=$2 FOR UPDATE',[merchantId,candidate.sourceId])).rows[0];
    if(!row||!['completed','cancelled'].includes(row.status))fail('The terminal request is no longer eligible.',409);
    const tombstone={purged:true,at:context.now,retentionRunId:id};
    await session.client.query("UPDATE valopay_operations SET request=$3,receipt=$3 WHERE merchant_id=$1 AND id=$2 AND status IN ('completed','cancelled')",[merchantId,row.id,tombstone]);
    await session.client.query('UPDATE valopay_idempotency SET response=$3 WHERE merchant_id=$1 AND id=ANY($2::text[])',[merchantId,receiptIds(merchantId,row.request_key,row.id),tombstone]);
   }else{
    const record=state.records.find(r=>r.id===candidate.sourceId&&r.kind==='exports')!;
    result=await deleteRetainedExport(objectStorageClient.bucket(record.data.bucket).file(record.data.objectName),{id:record.id,merchantId,checksum:record.data.checksum});
    record.data.fileDeletedAt=context.now;record.data.fileRetentionRunId=id;
   }
   return recordLifecycleReceipt(state,context,id,candidate,result,'Retention action completed. Financial records, provenance, request identities and audit history were retained.');
  }catch(error){
   // A SQL error aborts the whole transaction; never mask it as a receipt.
   if(typeof (error as any)?.code==='string'&&/^[A-Z0-9]{5}$/.test((error as any).code))throw error;
   return recordLifecycleReceipt(state,context,id,candidate,'failed','Deletion could not be confirmed. Resume this saved run to check the same source; do not create a replacement export.');
  }
 }
 return lifecycleRunView(state,run);
}

/**
 * Anonymous sandboxes older than the cookie lifetime with no change by a
 * person in that time are removed, children first; signed-in workspaces never
 * carry the flag and are never swept.  Activity is read from the audit chain,
 * which every request mutation appends to, so the scheduled close (a system
 * actor) never keeps an abandoned sandbox alive.  Ordinary DML inside the
 * caller's transaction.
 *
 * Nothing is deleted until the workspace row and every one of its lenders
 * are locked, in lender order and without waiting (SKIP LOCKED). The
 * scheduled close, the export worker, Paystack test deliveries and requests
 * all hold a lender's row while they write its records, and a request holds
 * its workspace row, so a sandbox with either held elsewhere is left whole
 * for a later sweep. Deleting the records first and then waiting for such a
 * lender deadlocked with a close that saved it. Each sandbox is locked in a
 * savepoint of its own and a busy one is undone at once, so its free lenders
 * and its row are not held for the rest of the caller's transaction.
 */
export async function sweepExpiredWorkspaces(client: PoolClient, limit: number): Promise<number> {
  const staleness = `w.created_at < now() - make_interval(days => $1)
       AND EXISTS (SELECT 1 FROM valopay_merchants m WHERE m.workspace_id=w.id AND m.settings->>'anonymousWorkspace'='true')
       AND NOT EXISTS (SELECT 1 FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
                       WHERE m.workspace_id=w.id AND r.kind='audit' AND r.created_at >= now() - make_interval(days => $1)
                         AND COALESCE(r.data->>'actor','') NOT LIKE $2)`;
  const candidates = (await client.query<{ id: string }>(
    `SELECT w.id FROM valopay_workspaces w WHERE ${staleness} ORDER BY w.created_at LIMIT $3`,
    [ANONYMOUS_WORKSPACE_DAYS, `${SYSTEM_ACTOR_PREFIX}%`, limit],
  )).rows.map((row) => row.id);
  const expired: string[] = [];
  for (const id of candidates) {
    await client.query("SAVEPOINT expired_workspace");
    // Read again once locked: a person may have used the sandbox since the list above was read.
    const still = rowsAffected(await client.query(`SELECT w.id FROM valopay_workspaces w WHERE w.id=$3 AND ${staleness} FOR UPDATE OF w SKIP LOCKED`, [ANONYMOUS_WORKSPACE_DAYS, `${SYSTEM_ACTOR_PREFIX}%`, id]));
    // The workspace row, once locked, keeps the lender list fixed: adding a lender needs its workspace.
    const lenders = still ? (await client.query<{ total: number }>("SELECT count(*)::int AS total FROM valopay_merchants WHERE workspace_id=$1", [id])).rows[0]!.total : 0;
    const locked = still ? (await client.query("SELECT id FROM valopay_merchants WHERE workspace_id=$1 ORDER BY id FOR UPDATE SKIP LOCKED", [id])).rowCount || 0 : 0;
    if (still && locked === lenders) { await client.query("RELEASE SAVEPOINT expired_workspace"); expired.push(id); }
    else await client.query("ROLLBACK TO SAVEPOINT expired_workspace");
  }
  if (!expired.length) return 0;
  await client.query("DELETE FROM valopay_idempotency WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id = ANY($1::text[]))", [expired]);
  await client.query("DELETE FROM valopay_records WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id = ANY($1::text[]))", [expired]);
  await client.query("DELETE FROM valopay_merchants WHERE workspace_id = ANY($1::text[])", [expired]);
  await client.query("DELETE FROM valopay_workspaces WHERE id = ANY($1::text[])", [expired]);
  return expired.length;
}

async function seedWorkspace(client: PoolClient, workspace: WorkspaceRow, principal: string, anonymous: boolean, now: string) {
  for (const smaller of [false, true]) {
    const state = seedMerchant(randomUUID(), smaller);
    state.settings.anonymousWorkspace = anonymous;
    // REC-01: the first scheduled close is the next configured time after creation, from the database clock.
    state.settings.nextCloseAt = nextCloseInstant(now, closeTimeOf(state.settings));
    const merchant = await client.query(
      `INSERT INTO valopay_merchants(id,workspace_id,info,settings)
       SELECT $1,$2,$3,$4 WHERE EXISTS (SELECT 1 FROM valopay_workspaces WHERE id=$2 AND principal_hash=$5)`,
      [state.merchant.id, workspace.id, state.merchant, state.settings, principal],
    );
    if (!rowsAffected(merchant)) throw new Error("Workspace seed ownership check failed.");
    appendAudit(state, { actor: `${SYSTEM_ACTOR_PREFIX}sandbox seed`, role: "Admin", now }, "sandbox.created", "workspace", "Created an isolated synthetic lender. Not live evidence.");
    assertFinalState({ merchant: structuredClone(state.merchant), settings: {}, records: [] }, state, state.merchant.id);
    for (const record of state.records) {
      const inserted = await client.query(
        `INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11 WHERE EXISTS (
           SELECT 1 FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
           WHERE m.id=$2 AND m.workspace_id=$12 AND w.id=$12 AND w.principal_hash=$13)`,
        [record.id, record.merchantId, record.kind, record.name, record.status, record.reference, record.amountKobo, record.customerId, record.data, record.createdAt, record.updatedAt, workspace.id, principal],
      );
      if (!rowsAffected(inserted)) throw new Error("Workspace seed record ownership check failed.");
    }
  }
}

/**
 * A system transaction scoped to one merchant, for the scheduled close.  The
 * scope is the merchant's own workspace and principal, so every repository
 * query keeps its tenant predicate.  The merchant row is taken with SKIP
 * LOCKED: two instances never close the same lender at once and a request in
 * flight is never queued behind the scheduler.  Returns undefined when the
 * merchant is locked elsewhere or no longer exists.  It carries the system
 * limits (database-limits.ts) and is not gated: SKIP LOCKED already keeps it
 * from waiting on a busy lender.
 */
export async function inMerchantAsSystem<T>(merchantId: string, actor: string, fn: (context: StoreContext) => Promise<T>): Promise<T | undefined> {
  if (!actor.startsWith(SYSTEM_ACTOR_PREFIX)) throw new Error("A system transaction needs a system actor.");
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  let context: StoreContext | undefined, committing = false;
  try {
    await client.query(beginStatement(databaseLimits().system));
    await bindRuntimeService(client);
    const scope = (await client.query<{ id: string; workspace_id: string; principal_hash: string; role: string }>(
      `SELECT m.id,m.workspace_id,w.principal_hash,w.role FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
       WHERE m.id=$1 FOR UPDATE OF m SKIP LOCKED`,
      [merchantId],
    )).rows[0];
    if (!scope) { await client.query("ROLLBACK"); return undefined; }
    const now = (await client.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();
    context = Object.freeze({ authenticated: true, role: "Operations", actor, now });
    sessions.set(context, { client, workspace: { id: scope.workspace_id, principal_hash: scope.principal_hash, role: scope.role }, principal: scope.principal_hash, active: true, access: "write" });
    const result = await fn(context);
    committing = true;
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT") throw new Error("The system transaction was rolled back.");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction is already closed */ }
    throw failedTransaction(error, { committing, lost: guard.lost(), write: true });
  } finally {
    if (context) {
      const session = sessions.get(context);
      if (session) { session.active = false; session.snapshot = undefined; session.summarised = undefined; session.lockedMerchantId = undefined; }
    }
    guard.release();
  }
}

/**
 * Whether a lender exists in a workspace, read without its lock: when
 * inMerchantAsSystem finds no row to lock, this tells a lender busy elsewhere
 * from one that is not there.  A plain read with the system limits; under
 * runtime isolation it runs as the service member, as the lock does.
 */
export async function merchantInWorkspace(merchantId: string, workspaceId: string): Promise<boolean> {
  return runtimeServiceRead(async client => Boolean((await client.query("SELECT 1 FROM valopay_merchants WHERE id=$1 AND workspace_id=$2", [merchantId, workspaceId])).rows[0]));
}

/**
 * The next lenders whose scheduled close is due, in a fair order: staff and
 * signed-in lenders before anonymous sandboxes; lenders waiting to retry a
 * failed attempt after the rest; one lender per workspace per turn, so one
 * workspace's many lenders never hold another's back; then the earliest
 * time.  A lender waiting for its retry time is not due.  `exclude` leaves
 * out lenders a pass has already dealt with; `only` limits the read to the
 * lenders named (tests and operator tooling).  A plain read with the system
 * limits (runtimeServiceRead binds the service identity only under runtime
 * isolation): the caller re-checks under the merchant lock before closing.
 */
export async function dueScheduledCloses(limit: number, options: { exclude?: readonly string[]; only?: readonly string[] } = {}): Promise<string[]> {
  return runtimeServiceRead(async client => (await client.query<{ id: string }>(
    `WITH ready AS (
       SELECT m.id, m.workspace_id,
         (CASE WHEN m.settings->>'nextCloseAt' ~ $2 THEN (m.settings->>'nextCloseAt')::timestamptz END) AS due_at,
         -- A retry counts only for the pending time and when well formed, as closeRetryOf reads it.
         CASE WHEN m.settings->'closeRetry'->>'cursor' = m.settings->>'nextCloseAt' AND m.settings->'closeRetry'->>'failures' ~ '^[1-9][0-9]{0,5}$' AND m.settings->'closeRetry'->>'retryAt' ~ $2
              THEN (m.settings->'closeRetry'->>'failures')::int ELSE 0 END AS failures,
         CASE WHEN m.settings->'closeRetry'->>'cursor' = m.settings->>'nextCloseAt' AND m.settings->'closeRetry'->>'failures' ~ '^[1-9][0-9]{0,5}$' AND m.settings->'closeRetry'->>'retryAt' ~ $2
              THEN (m.settings->'closeRetry'->>'retryAt')::timestamptz END AS retry_at,
         COALESCE(m.settings->>'anonymousWorkspace', 'false') = 'true' AS anonymous
       FROM valopay_merchants m
       WHERE COALESCE(m.settings->>'scheduledCloseEnabled','true') <> 'false'
         AND NOT (m.id = ANY($3::text[])) AND ($4::text[] IS NULL OR m.id = ANY($4::text[]))
     ), due AS (
       SELECT * FROM ready WHERE due_at <= now() AND (retry_at IS NULL OR retry_at <= now())
     ), ranked AS (
       SELECT id, anonymous, failures, due_at, row_number() OVER (PARTITION BY workspace_id ORDER BY failures > 0, due_at, id) AS turn FROM due
     )
     SELECT id FROM ranked ORDER BY anonymous, failures > 0, turn, due_at, id LIMIT $1`,
    [limit, ISO_INSTANT_PATTERN, [...(options.exclude ?? [])], options.only ? [...options.only] : null],
  )).rows.map((row) => row.id));
}

/**
 * Records a failed scheduled attempt on the lender (settings.closeRetry): one
 * more failure at its pending close time and when to try again, from the
 * database clock.  Its own small service transaction, after the failed close
 * rolled back; the row is taken with SKIP LOCKED, so a request or another
 * instance holding the lender is never waited for.  Returns undefined when
 * nothing was recorded: the lender is gone or locked, or its close is no
 * longer pending because someone closed it meanwhile.  The error text is never
 * stored, because the lender's settings are shown to its users.
 */
export async function recordScheduledCloseFailure(merchantId: string): Promise<CloseRetry | undefined> {
  return runtimeServiceRead(async client => {
    const row = (await client.query<{ settings: Record<string, unknown>; now: Date }>("SELECT settings, now() AS now FROM valopay_merchants WHERE id=$1 FOR UPDATE SKIP LOCKED", [merchantId])).rows[0];
    const retry = row ? nextCloseRetry(row.settings, row.now.toISOString()) : null;
    if (!retry) return undefined;
    const updated = await client.query("UPDATE valopay_merchants SET settings = settings || jsonb_build_object('closeRetry', $2::jsonb) WHERE id=$1", [merchantId, JSON.stringify(retry)]);
    return rowsAffected(updated) ? retry : undefined;
  });
}

/**
 * Whether nobody has changed this context's workspace for `days`: it is older
 * than that and no audit entry by a person was written within it.  The same
 * definition of activity as the expiry sweep, so the scheduled close's own
 * entries never count.
 */
export async function sandboxInactiveFor(context: StoreContext, days: number): Promise<boolean> {
  const session = sessionFor(context);
  return (await session.client.query<{ idle: boolean }>(
    `SELECT (w.created_at < now() - make_interval(days => $2)) AND NOT EXISTS (
       SELECT 1 FROM valopay_merchants m JOIN valopay_records r ON r.merchant_id=m.id
       WHERE m.workspace_id=w.id AND r.kind='audit' AND r.created_at >= now() - make_interval(days => $2)
         AND COALESCE(r.data->>'actor','') NOT LIKE $3) AS idle
     FROM valopay_workspaces w WHERE w.id=$1`,
    [session.workspace.id, days, `${SYSTEM_ACTOR_PREFIX}%`],
  )).rows[0]?.idle === true;
}

/**
 * Merchants created before the scheduler existed carry no cursor.  Each gets
 * the next configured time after the database clock, without a close, so the
 * first scheduled close comes at its time rather than at the next tick.
 */
export async function initialiseCloseCursors(): Promise<number> {
  return runtimeServiceRead(async client => {
    if (runtimeIsolationEnabled()) {
      const rows = (await client.query<{ id: string; settings: Record<string, unknown>; now: Date }>("SELECT m.id,m.settings,now() AS now FROM valopay_merchants m WHERE m.settings->>'nextCloseAt' IS NULL FOR UPDATE", [])).rows;
      for (const row of rows) await client.query("UPDATE valopay_merchants SET settings=settings || jsonb_build_object('nextCloseAt',$2::text) WHERE id=$1 AND settings->>'nextCloseAt' IS NULL", [row.id, nextCloseInstant(row.now.toISOString(), closeTimeOf(row.settings))]);
      return rows.length;
    }
    const rows = (await client.query<{ id: string; settings: Record<string, unknown>; now: Date }>(
      "SELECT m.id,m.settings,now() AS now FROM valopay_merchants m WHERE m.settings->>'nextCloseAt' IS NULL",
    )).rows;
    if (!rows.length) return 0;
    const updated = await client.query(
      `UPDATE valopay_merchants m SET settings = m.settings || jsonb_build_object('nextCloseAt', v.next_at)
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS next_at) v
       WHERE m.id = v.id AND m.settings->>'nextCloseAt' IS NULL`,
      [rows.map((row) => row.id), rows.map((row) => nextCloseInstant(row.now.toISOString(), closeTimeOf(row.settings)))],
    );
    return updated.rowCount || 0;
  });
}

/** Where a table comes from: the base schema, or the migration in lib/db/migrations that adds it. */
const tableMigrations: Record<string, string> = {
  valopay_operations: "003_pilot_workflow.sql", valopay_teams: "003_pilot_workflow.sql", valopay_staff_memberships: "003_pilot_workflow.sql",
  valopay_staff_invitations: "003_pilot_workflow.sql", valopay_staff_events: "003_pilot_workflow.sql", valopay_staff_lender_access: "004_staff_lender_access.sql",
};
const schemaSource = (table: string) => tableMigrations[table] ? `apply lib/db/migrations/${tableMigrations[table]}` : "create it from the Drizzle schema in lib/db";
/** Every table this build uses, with every column the Drizzle schema in lib/db gives it. */
const requiredTables = [tables.workspaces, tables.merchants, tables.records, tables.idempotency, tables.operations, tables.teams, tables.staffMemberships, tables.staffInvitations, tables.staffEvents, tables.staffLenderAccess]
  .map((table) => { const config = getTableConfig(table); return { name: config.name, columns: config.columns.map((column) => column.name) }; });
/**
 * The integrity guards the Drizzle schema in lib/db declares: every unique
 * index (those behind primary keys and unique constraints included) and every
 * check constraint, as PostgreSQL 16 writes their definitions. Without one the
 * database accepts what the application relies on it to refuse: a second
 * workspace for one principal, two attempts in flight for one instalment, a
 * provider event recorded twice, money outside the safe range. So a missing
 * guard makes the schema incomplete, not slower. Compared by definition, not
 * by name, like the indexes below.
 */
export const integrityGuards = [
  { type: "unique index", name: "valopay_workspaces_pkey", table: "valopay_workspaces", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_workspaces_principal_hash_unique", table: "valopay_workspaces", definition: "USING btree (principal_hash)" },
  { type: "unique index", name: "valopay_merchants_pkey", table: "valopay_merchants", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_records_pkey", table: "valopay_records", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_unique_due_reference", table: "valopay_records", definition: "USING btree (merchant_id, reference) WHERE ((kind = 'due-items'::text) AND (reference <> ''::text))" },
  { type: "unique index", name: "valopay_unique_observation", table: "valopay_records", definition: "USING btree (merchant_id, ((data ->> 'source'::text)), ((data ->> 'eventId'::text))) WHERE ((kind = 'observations'::text) AND ((data ->> 'eventId'::text) IS NOT NULL))" },
  { type: "unique index", name: "valopay_one_inflight", table: "valopay_records", definition: "USING btree (merchant_id, ((data ->> 'dueItemId'::text))) WHERE ((kind = 'attempts'::text) AND (status = ANY (ARRAY['scheduled'::text, 'sent'::text, 'unknown'::text])))" },
  { type: "check", name: "valopay_money_integer", table: "valopay_records", definition: "CHECK (((amount_kobo >= 0) AND (amount_kobo <= '9007199254740991'::bigint)))" },
  { type: "check", name: "valopay_ticket_floor", table: "valopay_records", definition: "CHECK (((kind <> 'due-items'::text) OR (amount_kobo >= 500000)))" },
  { type: "unique index", name: "valopay_idempotency_pkey", table: "valopay_idempotency", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_idempotency_tenant_key", table: "valopay_idempotency", definition: "USING btree (merchant_id, id)" },
  { type: "unique index", name: "valopay_operations_pkey", table: "valopay_operations", definition: "USING btree (id)" },
  { type: "check", name: "valopay_operation_status", table: "valopay_operations", definition: "CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'cancelled'::text])))" },
  { type: "unique index", name: "valopay_teams_pkey", table: "valopay_teams", definition: "USING btree (workspace_id)" },
  { type: "unique index", name: "valopay_teams_organization_id_unique", table: "valopay_teams", definition: "USING btree (organization_id)" },
  { type: "unique index", name: "valopay_staff_memberships_pkey", table: "valopay_staff_memberships", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_staff_workspace_user", table: "valopay_staff_memberships", definition: "USING btree (workspace_id, user_id)" },
  { type: "check", name: "valopay_staff_status", table: "valopay_staff_memberships", definition: "CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'revoked'::text])))" },
  { type: "check", name: "valopay_staff_role", table: "valopay_staff_memberships", definition: "CHECK ((role = ANY (ARRAY['Admin'::text, 'Operations'::text, 'Finance'::text, 'Compliance reviewer'::text, 'Read-only'::text])))" },
  { type: "unique index", name: "valopay_staff_invitations_pkey", table: "valopay_staff_invitations", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_staff_invitations_token_hash_unique", table: "valopay_staff_invitations", definition: "USING btree (token_hash)" },
  { type: "check", name: "valopay_invitation_status", table: "valopay_staff_invitations", definition: "CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text])))" },
  { type: "unique index", name: "valopay_staff_events_pkey", table: "valopay_staff_events", definition: "USING btree (id)" },
  { type: "unique index", name: "valopay_staff_lender_access_membership_id_merchant_id_pk", table: "valopay_staff_lender_access", definition: "USING btree (membership_id, merchant_id)" },
] as const;
/**
 * The read indexes later migrations add, as PostgreSQL 16 writes their
 * definitions after the name and table. They are compared by definition, not
 * by name: an isolated runtime schema holds copies of the tables whose indexes
 * carry generated names.
 */
const requiredIndexes = [
  { name: "valopay_records_lender_kind_page", table: "valopay_records", definition: "USING btree (merchant_id, kind, created_at, id)", migration: "002_record_list_indexes.sql" },
  { name: "valopay_records_lender_kind_status_page", table: "valopay_records", definition: "USING btree (merchant_id, kind, status, created_at, id)", migration: "002_record_list_indexes.sql" },
  { name: "valopay_records_lender_customer", table: "valopay_records", definition: "USING btree (merchant_id, customer_id, created_at, id)", migration: "002_record_list_indexes.sql" },
  { name: "valopay_records_lender_kind_updated", table: "valopay_records", definition: "USING btree (merchant_id, kind, updated_at)", migration: "002_record_list_indexes.sql" },
  { name: "valopay_staff_lender_access_lender", table: "valopay_staff_lender_access", definition: "USING btree (merchant_id, membership_id)", migration: "004_staff_lender_access.sql" },
  { name: "valopay_operations_pending", table: "valopay_operations", definition: "USING btree (merchant_id, owner) WHERE (status = 'pending'::text)", migration: "007_journal_and_lender_indexes.sql" },
  { name: "valopay_merchants_workspace", table: "valopay_merchants", definition: "USING btree (workspace_id, id)", migration: "007_journal_and_lender_indexes.sql" },
  { name: "valopay_records_export_queue", table: "valopay_records", definition: "USING btree (created_at, id) WHERE ((kind = 'exports'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))", migration: "008_export_queue_index_and_foreign_key_names.sql" },
] as const;
type SchemaCatalogue = {
  columns: Array<{ table: string; column: string }>;
  indexes: Array<{ table: string; unique: boolean; definition: string }>;
  checks: Array<{ table: string; definition: string }>;
};
/**
 * The columns, valid indexes and validated check constraints of the
 * application's tables, in one catalogue read: in the schema named, or else the
 * tables the connection's unqualified queries reach along its search path
 * (pg_table_is_visible), which is not always the first schema on it. A check
 * added NOT VALID is left out: it has not checked the rows already stored.
 */
const schemaCatalogue = `SELECT
  (SELECT coalesce(json_agg(json_build_object('table',c.relname,'column',a.attname)),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(c.oid) ELSE n.nspname=$1::text END AND c.relname=ANY($2::text[]) AND c.relkind IN ('r','p')) AS columns,
  (SELECT coalesce(json_agg(json_build_object('table',t.relname,'unique',i.indisunique,'definition',regexp_replace(pg_get_indexdef(i.indexrelid),'^CREATE (UNIQUE )?INDEX \\S+ ON (ONLY )?\\S+ ',''))),'[]')
    FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(t.oid) ELSE n.nspname=$1::text END AND t.relname=ANY($2::text[]) AND i.indisvalid AND i.indisready) AS indexes,
  (SELECT coalesce(json_agg(json_build_object('table',t.relname,'definition',pg_get_constraintdef(k.oid))),'[]')
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE CASE WHEN $1::text IS NULL THEN pg_table_is_visible(t.oid) ELSE n.nspname=$1::text END AND t.relname=ANY($2::text[]) AND k.contype='c' AND k.convalidated) AS checks`;
/**
 * What the catalogue lacks of what this build needs, each with where it comes
 * from: the tables and columns the queries use and the integrity guards, then
 * the read indexes; at most 20 of each, then a count.
 */
function schemaGaps(catalogue: SchemaCatalogue): { required: string[]; indexes: string[] } {
  const present = new Map<string, Set<string>>(), required: string[] = [], indexes: string[] = [];
  for (const { table, column } of catalogue.columns) present.set(table, (present.get(table) ?? new Set<string>()).add(column));
  for (const table of requiredTables) {
    const columns = present.get(table.name);
    if (!columns) { required.push(`table ${table.name}: ${schemaSource(table.name)}`); continue; }
    for (const column of table.columns) if (!columns.has(column)) required.push(`column ${table.name}.${column}: ${schemaSource(table.name)}`);
  }
  const defined = new Set(catalogue.indexes.map((index) => `${index.table} ${index.definition}`));
  const guarded = new Set([...catalogue.indexes.filter((index) => index.unique).map((index) => `${index.table} unique index ${index.definition}`), ...catalogue.checks.map((check) => `${check.table} check ${check.definition}`)]);
  // A missing table is named above; its guards and indexes are not listed again.
  for (const guard of integrityGuards) if (present.has(guard.table) && !guarded.has(`${guard.table} ${guard.type} ${guard.definition}`)) required.push(`${guard.type} ${guard.name}: restore it from the Drizzle schema in lib/db`);
  for (const index of requiredIndexes) if (present.has(index.table) && !defined.has(`${index.table} ${index.definition}`)) indexes.push(`index ${index.name}: apply lib/db/migrations/${index.migration}`);
  const capped = (list: string[]) => list.length > 20 ? [...list.slice(0, 20), `and ${list.length - 20} more`] : list;
  return { required: capped(required), indexes: capped(indexes) };
}
/**
 * The readiness check's findings: whether the database answered, and whether
 * it holds everything this build needs. `incomplete` means a table or column
 * the queries use is missing, so requests would fail, or an integrity guard
 * is, so the database would accept what the application relies on it to
 * refuse; `indexes_missing` means only a read index a migration adds is
 * missing, so some reads are slower but every request still works. `missing`
 * names each, for the log.
 */
export interface DatabaseReadiness {
  status: "ok" | "failed"; latencyMs: number; error?: string;
  /** The schema checked, when one is named (the isolated runtime schema); absent when the connection's search path decides. */
  searched?: string;
  schema: { status: "ok" | "indexes_missing" | "incomplete" | "unchecked"; missing: string[] };
}
let readiness: InstanceType<typeof Pool> | undefined;
/**
 * Readiness: one bounded round trip to the database, on its own connection,
 * so a request pool that is busy does not read as a database that cannot be
 * reached. The round trip reads the catalogue, so a database that answers but
 * lacks a table or a column this build needs (a migration not yet applied), or
 * a unique index or check constraint it relies on (a push stopped part way),
 * is not ready either; a missing read index is reported without failing, since
 * every request still works, only slower. A SELECT 1 could not tell. It checks
 * the application's schema: the isolated runtime schema when runtime isolation
 * is on, otherwise the connection's own (`schema` names another, for tests).
 * Never throws; a connection error stays in the caller's log, not in an
 * answer.
 */
export async function pingDatabase(options: { timeoutMs?: number; schema?: string } = {}): Promise<DatabaseReadiness> {
  const timeoutMs = options.timeoutMs ?? 2000, started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!readiness) {
      readiness = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: timeoutMs, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
      // An idle connection that fails is replaced; the next ping reports whether the database answers.
      readiness.on("error", () => {});
    }
    const schema = options.schema ?? runtimeIsolationConfiguration()?.schema ?? null;
    const catalogue = (await Promise.race([
      readiness.query<SchemaCatalogue>(schemaCatalogue, [schema, requiredTables.map((table) => table.name)]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs); }),
    ])).rows[0]!;
    const gaps = schemaGaps(catalogue);
    const status = gaps.required.length ? "incomplete" : gaps.indexes.length ? "indexes_missing" : "ok";
    return { status: "ok", latencyMs: Math.round(performance.now() - started), ...(schema ? { searched: schema } : {}), schema: { status, missing: [...gaps.required, ...gaps.indexes] } };
  } catch (error) {
    return { status: "failed", latencyMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error), schema: { status: "unchecked", missing: [] } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An idle connection that fails emits an error on the pool; unheard, that event ends the process. Heard, it is a log line and the pool replaces the connection. */
export function watchDatabase(log: { error: (fields: object, message: string) => void }): void {
  pool.on("error", (error) => log.error({ event: "database.pool_error", err: error }, "Database connection error on an idle client"));
}

/** Ends the pools on shutdown, after the last transaction. */
export async function closeDatabase(): Promise<void> {
  const ending = readiness;
  readiness = undefined;
  await Promise.all([pool.end(), ending?.end()]);
}

/** Appends a hash-chained audit entry for an action to the lender's state. */
export function appendAudit(state: DomainState, ctx: Context, action: string, objectId: string, summary: string, changes?: unknown): ValopayRecord {
  // One pass for the chain's length and head; the chain grows with every save, so it is not sorted here.
  let length = 0, previous: ValopayRecord | undefined;
  for (const record of state.records) {
    if (record.kind !== "audit") continue;
    length += 1;
    if (!previous || Number(record.data.sequence || 0) >= Number(previous.data.sequence || 0)) previous = record;
  }
  const data = auditEntryData({ sequence: length + 1, actor: ctx.actor, action, objectId, summary, changes, previousHash: previous?.data.hash, timestamp: ctx.now });
  const record: ValopayRecord = { id: randomUUID(), merchantId: state.merchant.id, kind: "audit", name: action, status: "recorded", reference: "", amountKobo: 0, customerId: state.records.find((item) => item.id === objectId)?.customerId || "", createdAt: ctx.now, updatedAt: ctx.now, data };
  state.records.push(record);
  return record;
}
/** Walks the chain: valid when every entry's sequence, previous hash and digest agree; returns the count and the head hash. */
export function verifyAudit(state: DomainState) {
  return verifyAuditChain(recordsOf(state, "audit"));
}
