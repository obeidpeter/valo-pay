import { historySections, historyKind, positionNote, type CustomerHistoryQuery, type HistorySection } from './customer-history';
import { pool, Pool, poolSize, type PoolClient } from "@workspace/db";
import { getAuth, clerkClient } from "@clerk/express";
import { staffMode, verifyStaff } from './staff-access';
import { validateLenderAccessChange } from './staff-lender-access';
import { bindRuntimeIdentity, bindRuntimeService, clearRuntimeInviteeGrants, runtimeIsolationEnabled, runtimeServiceRead } from './runtime-isolation';
import type { StaffLenderAccessInput } from '@workspace/valopay-schema';
import type { VerifiedClerkSession } from './pilot-access';
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { closeTimeOf, nextCloseInstant } from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { recordsOf } from "../domain/records";
import { seedMerchant } from "./valopay-seed";
import { createCreationLimiter } from "./creation-limit";
import { foldForSearch, LIST_PAGE_CEILING, type ListQuery } from "./valopay-list";
import { queueView, queueViews, type QueueName, type QueueQuery } from './valopay-queues';
import { validateCloseRange, pageOffset, type ReadPageQuery, type ReconciliationQueue } from './console-read-models';
import { precisionAudit } from '../domain/reports';
import { periodBounds, previousMonth } from '../domain/billing';
import { measurementRules } from '@workspace/valopay-schema';
import { protectStored, revealStored, protectRecordData, revealRecordsData, payloadEncryptionKey, isProtectedPayload, PROTECTED_IMPORT_FIELDS, type ProtectedImportField } from './protected-payloads';
import { markRolledBack } from './transaction-outcome';
import { beginStatement, checkOut, databaseLimits, failedTransaction, DatabaseLimitError, type Checkout } from './database-limits';
import { createLenderGate } from './lender-gate';
import { assertImportedCorrectionChange } from '../domain/import-corrections';
import type { LifecycleExternalCandidate, LifecycleCandidate } from '@workspace/valopay-schema';
import { assertLifecycleCandidate, eraseLifecycleRawCsv, recordLifecycleReceipt, lifecycleRunView } from '../domain/lifecycle';
import { deleteRetainedExport } from './export-download';
import { objectStorageClient } from './objectStorage';
import { assertProviderEventChange } from '../providers/paystack-inbox';

/** The demo persona roles, the same list as the shared schema's. */
export const roles = ["Admin", "Operations", "Finance", "Compliance reviewer", "Read-only"];
/** SHA-256 of a string, as hex. */
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** A stable JSON form with sorted keys, so two states with the same content hash the same. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  // Preserve the historical byte format regardless of JSONB key order.
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

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
/** One JSON pass: the records added or changed since the lender was loaded, and the IDs left untouched. */
function changesSince(snapshot: StateSnapshot, state: DomainState): { changed: ValopayRecord[]; unchanged: Set<string> } {
  const changed: ValopayRecord[] = [], unchanged = new Set<string>();
  for (const record of state.records) {
    if (snapshot.records.get(record.id) === JSON.stringify(record)) unchanged.add(record.id);
    else changed.push(record);
  }
  return { changed, unchanged };
}
/** Every changed stored record gets a strictly newer version, even when two actions share a millisecond. */
function advanceChanged(snapshot: StateSnapshot, changed: ValopayRecord[], now: string): void {
  for (const record of changed) {
    const original = snapshot.records.get(record.id);
    if (original === undefined) continue;
    const previous = Date.parse((JSON.parse(original) as ValopayRecord).updatedAt);
    record.updatedAt = new Date(Math.max(Date.parse(now), Date.parse(record.updatedAt), previous + 1)).toISOString();
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
const requestOperations = new WeakMap<Request, { id: string; merchantId: string }>();
export function bindOperation(req: Request, id: string, merchantId: string) { requestOperations.set(req, { id, merchantId }); }
/** The journal entry the recovery middleware bound to this request, if any. */
export function boundOperation(req: Request) { return requestOperations.get(req); }
const databaseConflictCodes = new Set(["23503", "23505", "23514", "P0001"]);
/** One lender holds at most half this process's connections; a request past that waits, without one, for up to the lock limit. */
const lenderGate = createLenderGate({ capacity: Math.max(1, Math.floor(poolSize / 2)), waitMs: () => databaseLimits().request.lockMs });
/** The lender a request names: every lender-scoped route carries it as the merchantId query value. */
function gatedLender(req: Request): string | undefined {
  const lender = (req.query as Record<string, unknown> | undefined)?.merchantId;
  return typeof lender === "string" && lender.length >= 1 && lender.length <= 100 ? lender : undefined;
}

/** Throws an error carrying the HTTP status the error handler answers with (400 unless given). */
export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
const conflict = (message = "Operation conflicts with the current lender state."): never => fail(message, 409);
/** Anonymous sandboxes expire after this many days without a change; the cookie carries the same lifetime. */
export const ANONYMOUS_WORKSPACE_DAYS = 30;
/** How many expired sandboxes one bootstrap removes, so a request never pays for a large backlog. */
const SWEEP_BATCH = 5;
/** Automatic deletion is opt-in so importing the application cannot remove existing workspaces. */
export const expiredWorkspaceCleanupEnabled = (value: string | undefined) => value === "on";
/** Actor prefix for platform-initiated changes (the seed, the scheduled close); the expiry sweep does not count them as sandbox activity. */
export const SYSTEM_ACTOR_PREFIX = "System · ";
/** A UTC ISO instant as the platform writes it; guards the timestamptz cast on the stored close cursor. */
const ISO_INSTANT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$";
const creationLimiter = createCreationLimiter();
const sandboxCookieName = "valopay_sandbox";
const legacySandboxCookieName = "valo_sandbox";
const cookieValue = (cookies: string, name: string) => cookies.split(";").map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`))?.slice(name.length + 1);
const isSandboxToken = (value: string | undefined): value is string => !!value && /^[a-f0-9]{64}$/.test(value);

export interface StoredRequest { method: 'POST' | 'PATCH'; path: string; body: unknown; }
type OperationRow = { id: string; merchant_id: string; owner: string; actor: string; role: string; request_key: string; request_hash: string; request: StoredRequest; label: string; status: string; receipt: any; created_at: Date; updated_at: Date };
const operationView = (row: OperationRow) => ({ id: row.id, label: row.label, actor: row.actor, role: row.role, status: row.status,
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  message: row.status === 'completed' ? 'The service saved this request.'
    : row.status === 'cancelled' ? (row.receipt?.rejected ? `The service refused this request: ${row.receipt.rejected.message} Correct it and submit it again.` : 'Cancelled before completion. This request cannot run again.')
    : 'Completion has not been confirmed. Check the original request.',
  // Only a compact result reference. Original payloads and export locations stay private.
  recordId: row.receipt?.record?.id || row.receipt?.id || null,
  recordKind: row.receipt?.record?.kind || row.receipt?.kind || null });

export async function prepareOperation(ctx: StoreContext, merchantId: string, key: string, request: StoredRequest) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'update');
  const owner = session.owner || session.principal, id = digest(`operation:${merchantId}:${owner}:${key}`);
  const hash = digest(canonical(request));
  const prior = (await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [id, merchantId, owner])).rows[0];
  if (prior) {
    if (prior.request_hash !== hash) fail('This request key belongs to a different request. Recover the original request first.', 409);
    if (prior.actor !== ctx.actor || prior.role !== ctx.role) fail('Return to the original role before checking this request.', 403);
    if (prior.status === 'cancelled') fail('This request was cancelled and cannot run again.', 409);
    return prior.id;
  }
  if (ctx.role === 'Read-only') fail('Your read-only role cannot submit operations.', 403);
  const count = Number((await session.client.query<{ count: string }>("SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2 AND status='pending'", [merchantId, owner])).rows[0]!.count);
  if (count >= 100) fail('Review your pending operations before submitting more requests.', 409);
  const label = request.path.includes('/actions') && request.body && typeof request.body === 'object'
    ? String((request.body as { action?: unknown }).action || 'Workspace action').replaceAll('_', ' ').slice(0, 100)
    : `${request.method === 'PATCH' ? 'Update' : 'Save'} ${request.path.split('/').filter(Boolean).slice(1, 3).join(' ').replaceAll('-', ' ')}`;
  await session.client.query(`INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [id, merchantId, owner, ctx.actor, ctx.role, key, hash, await protectStored(request,{lender:merchantId,record:id,field:'request'}), label, ctx.now]);
  return id;
}
export async function listOperations(ctx: StoreContext, merchantId: string, offset = 0) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId);
  const scope = [merchantId, session.owner || session.principal];
  const total = Number((await session.client.query<{ count: string }>('SELECT count(*) FROM valopay_operations WHERE merchant_id=$1 AND owner=$2', scope)).rows[0]!.count);
  const items = (await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE merchant_id=$1 AND owner=$2 ORDER BY created_at DESC,id DESC LIMIT 25 OFFSET $3', [...scope, offset])).rows.map(operationView);
  return { items, total, offset };
}
export async function readOperation(ctx: StoreContext, merchantId: string, id: string) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId);
  const row = (await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE id=$1 AND merchant_id=$2 AND owner=$3', [id, merchantId, session.owner || session.principal])).rows[0];
  if (!row) fail('Request not found in your lender history.', 404);
  if (row.actor !== ctx.actor || row.role !== ctx.role) fail('This request was submitted under a different role. Your current role cannot repeat it.', 403);
  if((row.request as any)?.purged)fail('This terminal request payload expired under the lender retention policy. Its identity and completion history are retained; it cannot run again.',410);
  return {...row, request:await revealStored(row.request,{lender:merchantId,record:id,field:'request'}), receipt:await revealStored(row.receipt,{lender:merchantId,record:id,field:'receipt'})};
}
export async function cancelOperation(ctx: StoreContext, merchantId: string, id: string) {
  const session = sessionFor(ctx); await readMerchant(ctx, merchantId, 'update');
  const row = await readOperation(ctx, merchantId, id);
  if (row.status === 'completed') fail('This request already completed. Refresh Operations to see its saved result.', 409);
  const legacy = await session.client.query('SELECT 1 FROM valopay_idempotency WHERE merchant_id=$1 AND id=ANY($2::text[])', [merchantId, [digest(`${merchantId}:${row.request_key}`), digest(`connected:${merchantId}:${row.request_key}`)]]);
  if (legacy.rows.length) fail('A receipt already exists for this request. Check the original request to recover it.', 409);
  await session.client.query("UPDATE valopay_operations SET status='cancelled',updated_at=$4 WHERE id=$1 AND merchant_id=$2 AND owner=$3 AND status='pending'", [id, merchantId, session.owner || session.principal, ctx.now]);
  return { message: 'The server confirmed this request has not completed and cancelled it. It cannot run again.' };
}
/** A definitive refusal (a 4xx the same request would receive again) closes
 * the journal entry: it neither waits for confirmation nor counts towards the
 * pending limit, and its key cannot run again. Runs in its own transaction
 * after the refused request's transaction rolled back. */
export async function rejectOperation(req: Request, bound: { id: string; merchantId: string }, rejection: { status: number; message: string }) {
  const guard = await checkOut(() => pool.connect()), client = guard.client;
  try {
    await client.query(beginStatement(databaseLimits().request));
    if (runtimeIsolationEnabled()) {
      const verified = getAuth(req) as unknown as VerifiedClerkSession;
      await bindRuntimeIdentity(client, { organizationId: verified.orgId || '', userId: verified.userId || '' });
    }
    const receipt = await protectStored({ rejected: rejection }, { lender: bound.merchantId, record: bound.id, field: 'receipt' });
    await client.query("UPDATE valopay_operations SET status='cancelled',receipt=$3,updated_at=now() WHERE id=$1 AND merchant_id=$2 AND status='pending'", [bound.id, bound.merchantId, receipt]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    throw error;
  } finally { guard.release(); }
}
/** Receipt and domain writes commit together. A process crash cannot leave a
 * completed journal entry without the corresponding business write. */
export async function completeOperation(ctx: StoreContext, receipt: unknown) {
  const session = sessionFor(ctx);
  if (!session.operationId) return;
  const merchantId = lockedMerchant(session);
  const result = await session.client.query(`UPDATE valopay_operations SET status='completed',receipt=$5,updated_at=$6
    WHERE id=$1 AND merchant_id=$2 AND owner=$3 AND actor=$4`, [session.operationId, merchantId, session.owner || session.principal, ctx.actor, await protectStored(receipt,{lender:merchantId,record:session.operationId,field:'receipt'}), ctx.now]);
  if (!rowsAffected(result)) fail('The recovery request no longer belongs to this session.', 409);
}

type StaffRow = { id: string; workspace_id: string; user_id: string; display_name: string; role: string; status: 'active' | 'suspended' | 'revoked'; expires_at: Date; created_at: Date; updated_at: Date };
const staffProvision = (row: StaffRow, organizationId: string) => ({ id: row.id, userId: row.user_id, organizationId, tenantId: row.workspace_id, role: row.role, status: row.status, validFrom: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() });
const staffView = (row: StaffRow) => ({ id: row.id, actor: `Clerk:${row.user_id}`, name: row.display_name, role: row.role, status: row.status, expiresAt: row.expires_at.toISOString(), updatedAt: row.updated_at.toISOString() });
export async function caseAssignees(ctx: StoreContext) {
  const session = sessionFor(ctx);
  if (ctx.accessMode !== 'staff') return roles.filter(role => role !== 'Read-only').map(role => ({ actor: `Sandbox ${role}`, name: `Demo ${role}`, role }));
  if (!session.lockedMerchantId) fail('Select a lender before looking up available assignees.', 409);
  return (await session.client.query<StaffRow>(`SELECT member.* FROM valopay_staff_memberships member
    WHERE member.workspace_id=$1 AND member.status='active' AND member.expires_at>$2 AND member.role<>'Read-only'
      AND (member.role='Admin' OR EXISTS (SELECT 1 FROM valopay_staff_lender_access grant_row WHERE grant_row.membership_id=member.id AND grant_row.merchant_id=$3))
    ORDER BY member.display_name,member.id`, [session.workspace.id, ctx.now, session.lockedMerchantId])).rows.map(staffView);
}
export async function staffDirectory(ctx: StoreContext) {
  const session = sessionFor(ctx);
  if (ctx.accessMode !== 'staff') return { mode: 'sandbox', actor: ctx.actor, members: [], invitations: [], events: [], message: 'Real staff access is not enabled on this host. Demo roles are for practice only.' };
  const memberRows = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 ORDER BY display_name,id', [session.workspace.id])).rows;
  const grants = (await session.client.query<{ membership_id: string; merchant_id: string }>(`SELECT grant_row.membership_id,grant_row.merchant_id FROM valopay_staff_lender_access grant_row JOIN valopay_staff_memberships member ON member.id=grant_row.membership_id JOIN valopay_merchants lender ON lender.id=grant_row.merchant_id WHERE member.workspace_id=$1 AND lender.workspace_id=$1 ORDER BY grant_row.merchant_id`, [session.workspace.id])).rows;
  const members = memberRows.map(row => ({ ...staffView(row), lenderIds: row.role === 'Admin' ? [] : grants.filter(grant => grant.membership_id === row.id).map(grant => grant.merchant_id), allLenders: row.role === 'Admin' }));
  const lenders = ctx.role === 'Admin' ? await listMerchants(ctx) : [];
  const invitations = ctx.role === 'Admin' ? (await session.client.query('SELECT id,email,role,status,expires_at AS "expiresAt" FROM valopay_staff_invitations WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [session.workspace.id])).rows : [];
  const events = ctx.role === 'Admin' ? (await session.client.query('SELECT id,actor,action,subject,detail,created_at AS "createdAt" FROM valopay_staff_events WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100', [session.workspace.id])).rows : [];
  return { mode: 'staff', actor: ctx.actor, members, lenders, invitations, events, message: 'Verified staff access. Membership, lender access and MFA are checked for every request. Financial records remain synthetic.' };
}
export function viewerScope(ctx: StoreContext) { const session = sessionFor(ctx); return digest(`viewer:${session.workspace.id}:${session.owner || session.principal}`); }
function teamAdmin(ctx: StoreContext) {
  const session = sessionFor(ctx);
  if (ctx.accessMode !== 'staff' || ctx.role !== 'Admin' || session.access !== 'team') fail('A verified pilot administrator with recent MFA is required.', 403);
  return session;
}
async function staffEvent(client: PoolClient, workspaceId: string, actor: string, action: string, subject: string, detail: unknown) {
  await client.query('INSERT INTO valopay_staff_events(id,workspace_id,actor,action,subject,detail) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), workspaceId, actor, action, subject, detail]);
}
export async function inviteStaff(ctx: StoreContext, email: string, role: string) {
  const session = teamAdmin(ctx);
  const token = randomBytes(32).toString('hex'), id = randomUUID();
  await session.client.query("UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND email=$2 AND status='pending'", [session.workspace.id, email]);
  await session.client.query(`INSERT INTO valopay_staff_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, session.workspace.id, email, role, digest(token), ctx.actor, new Date(Date.parse(ctx.now) + 7 * 86400000)]);
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.invited', id, { email, role });
  return { id, token, message: 'Invitation created. Share the link directly with this person; no email has been sent. It expires in seven days.' };
}
export async function updateStaff(ctx: StoreContext, id: string, input: { role: string; status: string; expectedUpdatedAt: string; reason: string }) {
  const session = teamAdmin(ctx);
  const row = (await session.client.query<StaffRow>('SELECT * FROM valopay_staff_memberships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [session.workspace.id, id])).rows[0];
  if (!row) fail('Staff membership not found.', 404);
  if (row.user_id === session.userId) fail('Ask another administrator to change your membership.', 403);
  if (row.updated_at.toISOString() !== input.expectedUpdatedAt) fail('This membership changed. Refresh the team and review it again.', 409);
  if (row.status === 'revoked' && input.status !== 'revoked') fail('A revoked person must accept a new invitation before access is restored.', 409);
  const result = await session.client.query<StaffRow>(`UPDATE valopay_staff_memberships SET role=$3,status=$4,updated_at=greatest(now(),updated_at+interval '1 millisecond') WHERE workspace_id=$1 AND id=$2 RETURNING *`, [session.workspace.id, id, input.role, input.status]);
  if (input.status === 'revoked' || input.role !== row.role) await session.client.query('DELETE FROM valopay_staff_lender_access WHERE membership_id=$1', [id]);
  // Suspension and revocation withdraw the person's pending invitations: an
  // invitation sent earlier must not hand the access straight back.
  const invitationsRevoked = input.status === 'active' ? 0 : (await session.client.query("UPDATE valopay_staff_invitations SET status='revoked' WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='pending'", [session.workspace.id, row.display_name])).rowCount || 0;
  await staffEvent(session.client, session.workspace.id, ctx.actor, 'staff.changed', id, { before: { role: row.role, status: row.status }, after: { role: input.role, status: input.status }, reason: input.reason, ...(invitationsRevoked ? { invitationsRevoked } : {}) });
  return staffView(result.rows[0]!);
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
    const invite = (await client.query<{ id: string; email: string; role: string; created_at: Date }>(`SELECT id,email,role,created_at FROM valopay_staff_invitations WHERE workspace_id=$1 AND token_hash=$2 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE`, [team.workspace_id, digest(token)])).rows[0];
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
    if(existing) {
      if (runtimeIsolationEnabled()) await clearRuntimeInviteeGrants(client);
      else await client.query('DELETE FROM valopay_staff_lender_access WHERE membership_id=$1',[existing.id]);
    }
    await client.query(`INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,status,expires_at) VALUES($1,$2,$3,$4,$5,'active',now()+interval '90 days')
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role,status='active',expires_at=EXCLUDED.expires_at,updated_at=greatest(now(),valopay_staff_memberships.updated_at+interval '1 millisecond')`, [randomUUID(), team.workspace_id, auth.userId, invite.email, invite.role]);
    await client.query("UPDATE valopay_staff_invitations SET status='accepted' WHERE id=$1 AND workspace_id=$2", [invite.id, team.workspace_id]);
    await staffEvent(client, team.workspace_id, `Clerk:${auth.userId}`, 'staff.accepted', invite.id, { role: invite.role });
    committing = true;
    await client.query('COMMIT'); return { message: 'Invitation accepted. Your pilot membership lasts 90 days.', role: invite.role };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    throw failedTransaction(error, { committing, lost: guard.lost(), write: true });
  } finally { guard.release(); }
}

/** Operator-only bootstrap; never called by an HTTP route. */
export async function provisionStaffWorkspace(organizationId: string, userId: string, name: string) {
  if (runtimeIsolationEnabled()) fail('Provision isolated staff workspaces through the separate migration-owner connection before starting the restricted runtime.', 503);
  if (!staffMode() || !/^org_[A-Za-z0-9]+$/.test(organizationId) || !/^user_[A-Za-z0-9]+$/.test(userId) || !name.trim() || name.length > 100) fail('Provide a staging organisation, administrator user ID and workspace name.');
  const guard = await checkOut(() => pool.connect()), client = guard.client, workspaceId = randomUUID();
  let committing = false;
  try {
    await client.query(beginStatement(databaseLimits().request));
    await client.query("INSERT INTO valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Read-only')", [workspaceId, digest(`staff-org:${organizationId}`)]);
    await client.query('INSERT INTO valopay_teams(workspace_id,organization_id,name) VALUES($1,$2,$3)', [workspaceId, organizationId, name]);
    await client.query("INSERT INTO valopay_staff_memberships(id,workspace_id,user_id,display_name,role,expires_at) VALUES($1,$2,$3,$4,'Admin',now()+interval '90 days')", [randomUUID(), workspaceId, userId, 'Pilot administrator']);
    await staffEvent(client, workspaceId, 'System · operator provisioning', 'staff.provisioned', userId, { organizationId });
    committing = true;
    await client.query('COMMIT'); return { workspaceId };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already closed */ }
    throw failedTransaction(error, { committing, lost: guard.lost(), write: true });
  } finally { guard.release(); }
}

export async function createPilotLender(ctx: StoreContext, input: { name: string; segment: string }, key: string) {
  const session = sessionFor(ctx);
  if (ctx.role !== 'Admin' || session.access !== 'team') fail('An administrator must set up a lender.', 403);
  // Workspace lock and deterministic ID make a repeated onboarding request safe.
  const id = digest(`onboarding:${session.workspace.id}:${session.owner}:${key}`), fingerprint = digest(canonical(input));
  const found = (await session.client.query<MerchantRow>('SELECT id,info,settings FROM valopay_merchants WHERE workspace_id=$1 AND id=$2', [session.workspace.id, id])).rows[0];
  if (found) { if (found.settings.onboardingFingerprint !== fingerprint) fail('This setup request was already used for different details.', 409); return found.info; }
  const state = seedMerchant(id, true);
  state.records = [];
  Object.assign(state.merchant, { name: input.name, shortName: input.name, segment: input.segment, provider: 'Paystack', mode: 'observation', status: 'onboarding', monthlyVolume: 0, killSwitch: true, preDataReady: false, preLiveReady: false });
  Object.assign(state.settings, { onboardingFingerprint: fingerprint, scheduledCloseEnabled: false, anonymousWorkspace: !ctx.authenticated, nextCloseAt: null });
  await session.client.query('INSERT INTO valopay_merchants(id,workspace_id,info,settings) VALUES($1,$2,$3,$4)', [id, session.workspace.id, state.merchant, state.settings]);
  await loadState(ctx, id, 'update');
  appendAudit(state, ctx, 'lender.created', id, 'Created an empty synthetic lender for pilot rehearsal.');
  await saveState(ctx, state);
  return state.merchant;
}

function principalFor(req: Request, res: Response) {
  const auth = getAuth(req);
  if (staffMode() && !auth.userId) fail('Sign in with your pilot staff account. Anonymous access is unavailable in this environment.', 401);
  if (auth.userId) return { principal: digest(`clerk:${auth.userId}`), authenticated: true, address: req.ip || "unknown" };
  const cookies = req.headers.cookie || "";
  const currentToken = cookieValue(cookies, sandboxCookieName);
  const legacyToken = cookieValue(cookies, legacySandboxCookieName);
  const token = isSandboxToken(currentToken) ? currentToken : isSandboxToken(legacyToken) ? legacyToken : randomBytes(32).toString("hex");
  // The cookie slides: an active sandbox keeps its 30 days from the last visit, matching the expiry sweep below.
  res.cookie(sandboxCookieName, token, { httpOnly: true, secure: req.secure || req.headers["x-forwarded-proto"] === "https", sameSite: "lax", maxAge: ANONYMOUS_WORKSPACE_DAYS * 86400000, path: "/" });
  return { principal: digest(`demo:${token}`), authenticated: false, address: req.ip || "unknown" };
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
  if(canonical(value)!==canonical(opened))fail('The encryption check failed.',503);
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
  const operations=(await session.client.query<OperationRow>(`SELECT o.* FROM valopay_operations o JOIN valopay_merchants m ON m.id=o.merchant_id WHERE m.workspace_id=$1 AND ((NOT(o.request ? 'protectedPayload') AND NOT(o.request ? 'purged')) OR (o.receipt IS NOT NULL AND NOT(o.receipt ? 'protectedPayload') AND NOT(o.receipt ? 'purged'))) ORDER BY o.id LIMIT $2 FOR UPDATE OF o`,[session.workspace.id,batch])).rows;
  for(const row of operations){if(protectedCount)break;const scope={lender:row.merchant_id,record:row.id};const request=isProtectedPayload(row.request)?row.request:await protectStored(row.request,{...scope,field:'request'});const receipt=row.receipt===null||isProtectedPayload(row.receipt)?row.receipt:await protectStored(row.receipt,{...scope,field:'receipt'});await session.client.query('UPDATE valopay_operations SET request=$3,receipt=$4 WHERE id=$1 AND merchant_id=$2',[row.id,row.merchant_id,request,receipt]);protectedCount++;}
  const receipts=(await session.client.query<{id:string;merchant_id:string;response:unknown}>(`SELECT i.* FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id WHERE m.workspace_id=$1 AND NOT(i.response ? 'protectedPayload') AND NOT(i.response ? 'purged') ORDER BY i.id LIMIT $2 FOR UPDATE OF i`,[session.workspace.id,batch])).rows;
  for(const row of receipts){if(protectedCount)break;await session.client.query('UPDATE valopay_idempotency SET response=$3 WHERE id=$1 AND merchant_id=$2',[row.id,row.merchant_id,await protectStored(row.response,{lender:row.merchant_id,record:row.id,field:'response'})]);protectedCount++;}
  await staffEvent(session.client,session.workspace.id,context.actor,'encryption.protected','workspace',{protectedCount,at:context.now});
  return {message:protectedCount?'Protected another batch of stored payloads. Run again until no payloads remain.':'No unprotected import or recovery payloads remain in this workspace.',protectedCount,mayHaveMore:protectedCount>0};
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
 * a busy lender turns its own requests away with a 503 instead of holding up
 * other tenants. */
export async function inWorkspace<T>(req: Request, res: Response, fn: (context: StoreContext) => Promise<T>, access: WorkspaceAccess = "write"): Promise<T> {
  const identity = principalFor(req, res);
  const write = access !== "read", lender = gatedLender(req);
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
      // A new anonymous sandbox seeds two lenders; creation is bounded per client address on top of the request limit.
      if (!identity.authenticated && !creationLimiter.take(identity.address, Date.now())) fail("Too many new sandboxes from this address; please try again in an hour.", 429);
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
 * behind other reads.
 */
async function readMerchant(context: StoreContext, merchantId: string, lock: Exclude<MerchantLock, "none"> = "share"): Promise<MerchantRow> {
  const session = sessionFor(context);
  if (session.access === "read" && lock === "update") conflict("A read transaction cannot acquire a lender write lock.");
  if (session.lockedMerchantId && session.lockedMerchantId !== merchantId) conflict("A transaction may operate on only one lender.");
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
 * them sealed, so overviews, lists, saves, the scheduled close and Paystack
 * test deliveries never depend on the key service. Only a view that shows or
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
    beforeDigest: digest(canonical({ merchant: JSON.parse(snapshot.merchant), settings: JSON.parse(snapshot.settings), records: previous })),
    afterDigest: digest(canonical({ merchant: state.merchant, settings: state.settings, records: [...changed].sort(byId) })),
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
  const conditions = { proposals:"r.kind='allocations' AND r.status='proposed'", duplicates:"r.kind='payments' AND r.status='possible_duplicate'", payments:"r.kind='payments' AND r.status='unallocated'", observations:"r.kind='observations' AND r.status='unresolved'", audit:"r.kind='allocations' AND r.id=ANY($5::text[])", batches:"r.kind='settlement-batches'" };
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

/** paymentMoneyReturned in SQL: reversed by the provider, or refunded (including the legacy spelling). Returned money is no customer's credit. */
const paymentReturnedSql = "(coalesce(r.data->>'reversalStatus','')='reversed' OR coalesce(r.data->>'refundStatus','') IN ('refunded','recorded_externally'))";

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
    coalesce(sum(greatest(0,r.amount_kobo-coalesce((r.data->>'allocatedKobo')::numeric,0))) FILTER(WHERE r.kind='payments' AND NOT ${paymentReturnedSql}),0) AS credit
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

/** The stored answer for an idempotency key, when the request was already made. */
export async function findIdempotency(context: StoreContext, id: string) {
  const session = sessionFor(context);
  const merchantId = lockedMerchant(session);
  const found = (await session.client.query<{ request_hash: string; response: any }>(
    `SELECT i.request_hash,i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id
     JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE i.id=$1 AND i.merchant_id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4`,
    [id, merchantId, session.workspace.id, session.principal],
  )).rows[0];
  if(found?.response?.purged)fail('This request already completed and its retained payload has expired. It cannot run again.',410);
  return found ? {...found,response:await revealStored(found.response,{lender:merchantId,record:id,field:'response'})} : undefined;
}
/** Stores the answer under the key with the request's fingerprint, so a replay with different input is refused. */
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
  return canonical({ ...after, status: before.status, updatedAt: before.updatedAt, data: stableData(after) }) === canonical({ ...before, data: stableData(before) });
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
    const retentionChange=()=>{
      const kind=before.kind==='exports'?'export_file':'raw_csv';
      const receipt=[...final.values()].find(r=>r.kind==='retention-receipts'&&!original.has(r.id)&&r.data.sourceId===before.id&&r.data.kind===kind&&['deleted','already_absent'].includes(r.data.result));
      const run=receipt&&original.get(receipt.data.runId);
      if(!run||run.kind!=='retention-runs'||!['approved','running','attention'].includes(run.status)||!run.data.candidates.some((c:any)=>c.sourceId===before.id&&c.kind===kind&&c.version===before.updatedAt))return false;
      const expected=structuredClone(before);expected.updatedAt=present.updatedAt;
      if(kind==='raw_csv'){delete expected.data.csv;if(expected.data.check)delete expected.data.check.preview;expected.data.rawCsvRemovedAt=now;expected.data.rawCsvRetentionRunId=run.id;}
      else {expected.data.fileDeletedAt=now;expected.data.fileRetentionRunId=run.id;}
      return canonical(expected)===canonical(present);
    };
    if (["audit", "exports", "reviews", "closes", "retry-decisions", "invoices", "connected-credit-assessments", "connected-credit-reviews", "case-events", "import-revisions", "import-corrections", "import-correction-events", "source-manifests", "close-review-events", "work-events", "retention-policies", "retention-holds", "retention-receipts"].includes(before.kind) && canonical(present) !== canonical(before)
      && !(before.kind === "exports" && (isExportRetry(before, present, now)||retentionChange()))) conflict("Evidence records are immutable.");
    if (["policies", "templates", "experiments"].includes(before.kind) && ["approved", "preregistered", "closed"].includes(before.status) && canonical(present) !== canonical(before)) {
      conflict("Approved, preregistered, and closed versions are immutable.");
    }
    if (before.kind === 'provider-events') assertProviderEventChange(before,present);
    if (before.kind === 'source-profiles' && ['source','kind'].some(key=>canonical(before.data[key])!==canonical(present.data[key]))) conflict('A source profile cannot change its source or record type.');
    if (before.kind === 'import-batches' && before.status === 'committed' && canonical(present) !== canonical(before)&&!retentionChange()) conflict('Committed source batches are immutable.');
    if(before.kind==='close-reviews'&&canonical(present)!==canonical(before)){
      const expected=structuredClone(before);expected.status=present.status;expected.updatedAt=present.updatedAt;
      for(const field of ['decidedBy','decidedPrincipal','decidedAt','decisionNote','sourceExceptions'])expected.data[field]=present.data[field];
      if(before.status!=='awaiting_review'||!['approved','changes_requested'].includes(present.status)||canonical(expected)!==canonical(present))conflict('The prepared close snapshot and recorded decision are immutable.');
    }
    if(before.kind==='retention-runs'&&['candidates','previewDigest','policyRevision','expiresAt','preparedBy'].some(key=>canonical(before.data[key])!==canonical(present.data[key])))conflict('The approved retention manifest is immutable.');
    if (before.data.importIdentity && canonical(present.data.importIdentity) !== canonical(before.data.importIdentity)) conflict('Source row provenance is immutable.');
    assertImportedCorrectionChange(before, present, snapshot, state);
  }
  const dueReferences = new Set<string>(), observations = new Set<string>(), inflight = new Set<string>();
  const allocatedPayments = new Map<string, number>(), allocatedDues = new Map<string, number>();
  const changed = (record: ValopayRecord, ...keys: string[]) => {
    if (unchanged.has(record.id)) return false;
    const before = original.get(record.id);
    return !before || keys.some((key) => canonical(before.data[key]) !== canonical(record.data[key]));
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
      if (payment.customerId && due.customerId && payment.customerId !== due.customerId) conflict("Allocation payment and due item must have the same customer.");
      if (record.customerId && (record.customerId !== payment.customerId || record.customerId !== due.customerId)) conflict("Allocation customer must match its parents.");
      if (record.status === "confirmed") {
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
  ...rows.map(row=>({kind:'journal_payload' as const,merchantId,sourceId:row.id,version:row.updated_at.toISOString(),createdAt:row.updated_at.toISOString(),label:'Terminal operation payload',digest:digest(canonical({request:row.request,receipt:row.receipt,key:row.request_key,hash:row.request_hash,status:row.status})),status:row.status as 'completed'|'cancelled'})),
  ...state.records.filter(r=>r.kind==='exports'&&['ready','failed'].includes(r.status)&&!r.data.fileDeletedAt&&r.data.bucket&&r.data.objectName).map(r=>({kind:'export_file' as const,merchantId,sourceId:r.id,version:r.updatedAt,createdAt:String(r.data.generatedAt||r.updatedAt),label:'Private export file',digest:digest(canonical({id:r.id,status:r.status,data:r.data})),status:r.status as 'ready'|'failed'})),
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
 for(const candidate of candidates){
  try{
   if(!assertLifecycleCandidate(state,context,id,candidate,external))continue;
  }catch{return recordLifecycleReceipt(state,context,id,candidate,'blocked','This source changed, is held or no longer meets the approved policy. Review the source and prepare a fresh preview.');}
  try{
   let result:'deleted'|'already_absent'='deleted';
   if(candidate.kind==='raw_csv')eraseLifecycleRawCsv(state,context,id,candidate);
   else if(candidate.kind==='journal_payload'){
    const row=(await session.client.query<OperationRow>('SELECT * FROM valopay_operations WHERE merchant_id=$1 AND id=$2 FOR UPDATE',[merchantId,candidate.sourceId])).rows[0];
    if(!row||!['completed','cancelled'].includes(row.status))fail('The terminal request is no longer eligible.',409);
    const tombstone={purged:true,at:context.now,retentionRunId:id};
    await session.client.query("UPDATE valopay_operations SET request=$3,receipt=$3 WHERE merchant_id=$1 AND id=$2 AND status IN ('completed','cancelled')",[merchantId,row.id,tombstone]);
    await session.client.query('UPDATE valopay_idempotency SET response=$3 WHERE merchant_id=$1 AND id=ANY($2::text[])',[merchantId,[digest(`${merchantId}:${row.request_key}`),digest(`connected:${merchantId}:${row.request_key}`)],tombstone]);
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
 */
export async function sweepExpiredWorkspaces(client: PoolClient, limit: number): Promise<number> {
  const stale = (await client.query<{ id: string }>(
    `SELECT w.id FROM valopay_workspaces w
     WHERE w.created_at < now() - make_interval(days => $1)
       AND EXISTS (SELECT 1 FROM valopay_merchants m WHERE m.workspace_id=w.id AND m.settings->>'anonymousWorkspace'='true')
       AND NOT EXISTS (SELECT 1 FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
                       WHERE m.workspace_id=w.id AND r.kind='audit' AND r.created_at >= now() - make_interval(days => $1)
                         AND COALESCE(r.data->>'actor','') NOT LIKE $3)
     ORDER BY w.created_at LIMIT $2 FOR UPDATE OF w SKIP LOCKED`,
    [ANONYMOUS_WORKSPACE_DAYS, limit, `${SYSTEM_ACTOR_PREFIX}%`],
  )).rows.map((row) => row.id);
  if (!stale.length) return 0;
  await client.query("DELETE FROM valopay_idempotency WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id = ANY($1::text[]))", [stale]);
  await client.query("DELETE FROM valopay_records WHERE merchant_id IN (SELECT id FROM valopay_merchants WHERE workspace_id = ANY($1::text[]))", [stale]);
  await client.query("DELETE FROM valopay_merchants WHERE workspace_id = ANY($1::text[])", [stale]);
  await client.query("DELETE FROM valopay_workspaces WHERE id = ANY($1::text[])", [stale]);
  return stale.length;
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
 * Merchants whose scheduled close is due by their stored cursor, oldest first.
 * A plain read with the system limits (runtimeServiceRead binds the service
 * identity only under runtime isolation): the caller re-checks under the
 * merchant lock before closing.
 */
export async function dueScheduledCloses(limit: number): Promise<string[]> {
  return runtimeServiceRead(async client => (await client.query<{ id: string }>(
    `SELECT m.id FROM valopay_merchants m
     WHERE COALESCE(m.settings->>'scheduledCloseEnabled','true') <> 'false'
       AND (CASE WHEN m.settings->>'nextCloseAt' ~ $2 THEN (m.settings->>'nextCloseAt')::timestamptz END) <= now()
     ORDER BY (CASE WHEN m.settings->>'nextCloseAt' ~ $2 THEN (m.settings->>'nextCloseAt')::timestamptz END), m.id
     LIMIT $1`,
    [limit, ISO_INSTANT_PATTERN],
  )).rows.map((row) => row.id));
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

let readiness: InstanceType<typeof Pool> | undefined;
/**
 * Readiness: one bounded round trip to the database, on its own connection,
 * so a request pool that is busy does not read as a database that cannot be
 * reached. Never throws; the reason stays in the caller's log, not in an answer.
 */
export async function pingDatabase(timeoutMs = 2000): Promise<{ status: "ok" | "failed"; latencyMs: number; error?: string }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!readiness) {
      readiness = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: timeoutMs, idleTimeoutMillis: 10_000, allowExitOnIdle: true });
      // An idle connection that fails is replaced; the next ping reports whether the database answers.
      readiness.on("error", () => {});
    }
    await Promise.race([
      readiness.query("SELECT 1"),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    return { status: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { status: "failed", latencyMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
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
  const body = { sequence: length + 1, actor: ctx.actor, action, objectId, summary, changeDigest: digest(canonical(changes ?? {})), previousHash: previous?.data.hash ?? "GENESIS", timestamp: ctx.now };
  const record: ValopayRecord = { id: randomUUID(), merchantId: state.merchant.id, kind: "audit", name: action, status: "recorded", reference: "", amountKobo: 0, customerId: state.records.find((item) => item.id === objectId)?.customerId || "", createdAt: ctx.now, updatedAt: ctx.now, data: { ...body, hash: digest(canonical(body)) } };
  state.records.push(record);
  return record;
}
/** Walks the chain: valid when every entry's sequence, previous hash and digest agree; returns the count and the head hash. */
export function verifyAudit(state: DomainState) {
  const chain = recordsOf(state, "audit").sort((a, b) => Number(a.data.sequence) - Number(b.data.sequence));
  let hash = "GENESIS", valid = true, index = 0;
  for (const event of chain) {
    const { hash: recorded, ...body } = event.data;
    if (body.sequence !== ++index || body.previousHash !== hash || digest(canonical(body)) !== recorded) { valid = false; break; }
    hash = String(recorded);
  }
  return { valid, count: chain.length, headHash: hash };
}
