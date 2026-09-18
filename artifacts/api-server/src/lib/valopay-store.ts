import { pool, type PoolClient } from "@workspace/db";
import { getAuth } from "@clerk/express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { closeTimeOf, nextCloseInstant } from "@workspace/valopay-schema";
import type { Context, DomainState, ValopayRecord } from "../domain/types";
import { recordsOf } from "../domain/records";
import { seedMerchant } from "./valopay-seed";
import { createCreationLimiter } from "./creation-limit";
import { foldForSearch, LIST_PAGE_CEILING, type ListQuery } from "./valopay-list";
import { advanceRecordVersions } from "./edit-versions";

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
type MerchantRow = { id: string; info: DomainState["merchant"]; settings: Record<string, any> };
type RecordRow = {
  id: string; merchant_id: string; kind: string; name: string; status: string; reference: string;
  amount_kobo: string | number; customer_id: string; data: Record<string, any>; created_at: Date; updated_at: Date;
};
type Session = {
  client: PoolClient; workspace: WorkspaceRow; principal: string; active: boolean;
  access: WorkspaceAccess;
  lockedMerchantId?: string; snapshot?: DomainState;
};

/**
 * This is an opaque transaction capability.  Its database handle and locked
 * merchant are deliberately private to this module; a route cannot construct a
 * useful context or issue an unscoped query.
 */
export interface StoreContext extends Context {
  readonly authenticated: boolean;
}
const sessions = new WeakMap<StoreContext, Session>();
const databaseConflictCodes = new Set(["23503", "23505", "23514", "P0001"]);

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

function principalFor(req: Request, res: Response) {
  const auth = getAuth(req);
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
export type WorkspaceAccess = "read" | "write" | "persona";
function scopedMerchantQuery(lock: MerchantLock = "none") {
  return `SELECT m.id,m.info,m.settings FROM valopay_merchants m
    JOIN valopay_workspaces w ON w.id=m.workspace_id
    WHERE m.id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3${lock === "update" ? " FOR UPDATE OF m" : lock === "share" ? " FOR SHARE OF m" : ""}`;
}

/** Persona changes lock the workspace exclusively. Ordinary work shares that
 * lock, fixing the persona for the transaction while lender locks serialize
 * mutations. Only first-visit bootstrap needs the principal advisory lock. */
export async function inWorkspace<T>(req: Request, res: Response, fn: (context: StoreContext) => Promise<T>, access: WorkspaceAccess = "write"): Promise<T> {
  const identity = principalFor(req, res);
  const client = await pool.connect();
  let context: StoreContext | undefined;
  try {
    await client.query("BEGIN");
    // Single source of time: the database clock, read once per transaction.
    const now = (await client.query<{ now: Date }>("SELECT now() AS now")).rows[0]!.now.toISOString();
    const workspaceQuery = `SELECT id,principal_hash,role FROM valopay_workspaces WHERE principal_hash=$1 FOR ${access === "persona" ? "UPDATE" : "SHARE"}`;
    let workspace = (await client.query<WorkspaceRow>(workspaceQuery, [identity.principal])).rows[0];
    if (!workspace) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [identity.principal]);
      // Another first visit may have finished seeding while we waited.
      workspace = (await client.query<WorkspaceRow>(workspaceQuery, [identity.principal])).rows[0];
    }
    if (!workspace) {
      // A new anonymous sandbox seeds two lenders; creation is bounded per client address on top of the request limit.
      if (!identity.authenticated && !creationLimiter.take(identity.address, Date.now())) fail("Too many new sandboxes from this address; please try again in an hour.", 429);
      const inserted = (await client.query<WorkspaceRow>(
        `INSERT INTO valopay_workspaces(id,principal_hash,role) VALUES($1,$2,'Admin')
         ON CONFLICT (principal_hash) DO NOTHING RETURNING id,principal_hash,role`,
        [randomUUID(), identity.principal],
      )).rows[0];
      workspace = inserted || (await client.query<WorkspaceRow>(
        workspaceQuery,
        [identity.principal],
      )).rows[0];
      if (!workspace) throw new Error("Workspace bootstrap could not be completed.");
      if (inserted) {
        await seedWorkspace(client, workspace, identity.principal, !identity.authenticated, now);
        // When explicitly enabled, each new anonymous sandbox pays for a few expired ones without a scheduler.
        if (!identity.authenticated && expiredWorkspaceCleanupEnabled(process.env["VALOPAY_EXPIRED_WORKSPACE_CLEANUP"])) {
          await sweepExpiredWorkspaces(client, SWEEP_BATCH);
        }
      }
    }
    context = Object.freeze({
      authenticated: identity.authenticated, role: workspace.role,
      actor: `Sandbox ${workspace.role}`, now,
    });
    sessions.set(context, { client, workspace, principal: identity.principal, active: true, access });
    const result = await fn(context);
    const committed = await client.query("COMMIT");
    // PostgreSQL accepts COMMIT after a caught statement error by returning
    // ROLLBACK.  Do not let a caller that swallowed that error observe success.
    if (committed.command !== "COMMIT") throw new Error("The workspace transaction was rolled back.");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction is already closed */ }
    if (databaseConflictCodes.has((error as { code?: string } | undefined)?.code || "")) {
      conflict("Operation conflicts with the current lender state.");
    }
    throw error;
  } finally {
    if (context) {
      const session = sessions.get(context);
      if (session) { session.active = false; session.snapshot = undefined; session.lockedMerchantId = undefined; }
    }
    client.release();
  }
}

/** List is explicitly constrained by the server-derived workspace principal. */
export async function listMerchants(context: StoreContext) {
  const session = sessionFor(context);
  return (await session.client.query<{ info: DomainState["merchant"] }>(
    `SELECT m.info FROM valopay_merchants m JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE m.workspace_id=$1 AND w.id=$1 AND w.principal_hash=$2 ORDER BY m.id`,
    [session.workspace.id, session.principal],
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
    scopedMerchantQuery(lock),
    [merchantId, session.workspace.id, session.principal],
  )).rows[0];
  if (!merchant) fail("Lender not found in this workspace.", 404);
  session.lockedMerchantId = merchantId;
  if (merchant.info.id !== merchantId) conflict("Lender identity does not match its stored scope.");
  return merchant;
}

export async function loadState(context: StoreContext, merchantId: string, lock: Exclude<MerchantLock, "none"> = "update"): Promise<DomainState> {
  const session = sessionFor(context);
  const merchant = await readMerchant(context, merchantId, lock);
  const records = (await session.client.query<RecordRow>(
    `SELECT r.id,r.merchant_id,r.kind,r.name,r.status,r.reference,r.amount_kobo,r.customer_id,r.data,r.created_at,r.updated_at
     FROM valopay_records r JOIN valopay_merchants m ON m.id=r.merchant_id
     JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE r.merchant_id=$1 AND m.workspace_id=$2 AND w.id=$2 AND w.principal_hash=$3 ORDER BY r.created_at,r.id`,
    [merchantId, session.workspace.id, session.principal],
  )).rows.map(rowToRecord);
  const state: DomainState = { merchant: merchant.info, settings: merchant.settings, records };
  if (state.merchant.id !== merchantId) conflict("Lender identity does not match its stored scope.");
  // A shared load is read-only, even in an otherwise write-capable context.
  // Avoid cloning the entire history just to serve a dashboard or export lookup.
  session.snapshot = lock === "update" ? structuredClone(state) : undefined;
  return state;
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
  return (await session.client.query<{ request_hash: string; response: any }>(
    `SELECT i.request_hash,i.response FROM valopay_idempotency i JOIN valopay_merchants m ON m.id=i.merchant_id
     JOIN valopay_workspaces w ON w.id=m.workspace_id
     WHERE i.id=$1 AND i.merchant_id=$2 AND m.workspace_id=$3 AND w.id=$3 AND w.principal_hash=$4`,
    [id, merchantId, session.workspace.id, session.principal],
  )).rows[0];
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
      [id, merchantId, requestHash, response, session.workspace.id, session.principal],
    );
    if (!rowsAffected(inserted)) fail("Lender not found in this workspace.", 404);
  } catch (error: any) {
    if (error?.code === "23505") conflict("This idempotency key is already in use.");
    throw error;
  }
}
/** Switches the workspace's demo persona. */
export async function changeRole(context: StoreContext, role: string) {
  const session = sessionFor(context);
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
  const stableData = (record: ValopayRecord) => Object.fromEntries(Object.entries(record.data).filter(([key]) => !cleared.includes(key)));
  // A retry cannot change the request, private object identity, attempts,
  // checksum, customer or any prior evidence; it only clears the old lease/error.
  return canonical({ ...after, status: before.status, updatedAt: before.updatedAt, data: stableData(after) }) === canonical({ ...before, data: stableData(before) });
}

export function assertFinalState(snapshot: DomainState, state: DomainState, merchantId: string, now?: string) {
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
    if (present.id !== before.id || present.merchantId !== before.merchantId || present.kind !== before.kind || present.createdAt !== before.createdAt) {
      conflict("Record identity, lender, kind, and creation time are immutable.");
    }
    if (["audit", "exports", "reviews", "closes", "retry-decisions", "invoices"].includes(before.kind) && canonical(present) !== canonical(before)
      && !(before.kind === "exports" && isExportRetry(before, present, now))) conflict("Evidence records are immutable.");
    if (["policies", "templates", "experiments"].includes(before.kind) && ["approved", "preregistered", "closed"].includes(before.status) && canonical(present) !== canonical(before)) {
      conflict("Approved, preregistered, and closed versions are immutable.");
    }
  }
  const dueReferences = new Set<string>(), observations = new Set<string>(), inflight = new Set<string>();
  const allocatedPayments = new Map<string, number>(), allocatedDues = new Map<string, number>();
  const changed = (record: ValopayRecord, ...keys: string[]) => {
    const before = original.get(record.id);
    return !before || keys.some((key) => canonical(before.data[key]) !== canonical(record.data[key]));
  };
  const changedCustomer = (record: ValopayRecord) => {
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
  for (const [id, amount] of allocatedPayments) if (amount > final.get(id)!.amountKobo) conflict("Allocations exceed the payment amount.");
  for (const [id, amount] of allocatedDues) if (amount > final.get(id)!.amountKobo) conflict("Allocations exceed the due-item amount.");
}

/** Persist only a checked diff against the repository-owned snapshot. */
export async function saveState(context: StoreContext, state: DomainState): Promise<void> {
  const session = sessionFor(context);
  const merchantId = lockedMerchant(session);
  const snapshot = session.snapshot!;
  advanceRecordVersions(snapshot, state, context.now);
  assertFinalState(snapshot, state, merchantId, context.now);
  const owned = await session.client.query(scopedMerchantQuery(), [merchantId, session.workspace.id, session.principal]);
  if (!owned.rows[0]) fail("Lender not found in this workspace.", 404);
  const old = new Map(snapshot.records.map((record) => [record.id, canonical(record)]));
  const sorted = [...state.records].sort((a, b) => {
    const priority = (record: ValopayRecord) => record.kind === "allocations" ? (record.status === "confirmed" ? 3 : 0) : record.kind === "audit" ? 4 : 1;
    return priority(a) - priority(b);
  });
  for (const record of sorted) {
    if (old.get(record.id) === canonical(record)) continue;
    const values = [record.id, merchantId, record.kind, record.name, record.status, record.reference, record.amountKobo, record.customerId, record.data, record.createdAt, record.updatedAt];
    if (old.has(record.id)) {
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
  // A subsequent repository save in this transaction validates against this
  // fresh authoritative snapshot, never a caller-supplied "previous" array.
  session.snapshot = structuredClone(state);
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
 * merchant is locked elsewhere or no longer exists.
 */
export async function inMerchantAsSystem<T>(merchantId: string, actor: string, fn: (context: StoreContext) => Promise<T>): Promise<T | undefined> {
  if (!actor.startsWith(SYSTEM_ACTOR_PREFIX)) throw new Error("A system transaction needs a system actor.");
  const client = await pool.connect();
  let context: StoreContext | undefined;
  try {
    await client.query("BEGIN");
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
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT") throw new Error("The system transaction was rolled back.");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction is already closed */ }
    throw error;
  } finally {
    if (context) {
      const session = sessions.get(context);
      if (session) { session.active = false; session.snapshot = undefined; session.lockedMerchantId = undefined; }
    }
    client.release();
  }
}

/**
 * Merchants whose scheduled close is due by their stored cursor, oldest first.
 * A plain read: the caller re-checks under the merchant lock before closing.
 */
export async function dueScheduledCloses(limit: number): Promise<string[]> {
  return (await pool.query<{ id: string }>(
    `SELECT m.id FROM valopay_merchants m
     WHERE COALESCE(m.settings->>'scheduledCloseEnabled','true') <> 'false'
       AND (CASE WHEN m.settings->>'nextCloseAt' ~ $2 THEN (m.settings->>'nextCloseAt')::timestamptz END) <= now()
     ORDER BY (CASE WHEN m.settings->>'nextCloseAt' ~ $2 THEN (m.settings->>'nextCloseAt')::timestamptz END), m.id
     LIMIT $1`,
    [limit, ISO_INSTANT_PATTERN],
  )).rows.map((row) => row.id);
}

/**
 * Merchants created before the scheduler existed carry no cursor.  Each gets
 * the next configured time after the database clock, without a close, so the
 * first scheduled close comes at its time rather than at the next tick.
 */
export async function initialiseCloseCursors(): Promise<number> {
  const rows = (await pool.query<{ id: string; settings: Record<string, unknown>; now: Date }>(
    "SELECT m.id,m.settings,now() AS now FROM valopay_merchants m WHERE m.settings->>'nextCloseAt' IS NULL",
  )).rows;
  if (!rows.length) return 0;
  const updated = await pool.query(
    `UPDATE valopay_merchants m SET settings = m.settings || jsonb_build_object('nextCloseAt', v.next_at)
     FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS next_at) v
     WHERE m.id = v.id AND m.settings->>'nextCloseAt' IS NULL`,
    [rows.map((row) => row.id), rows.map((row) => nextCloseInstant(row.now.toISOString(), closeTimeOf(row.settings)))],
  );
  return updated.rowCount || 0;
}

/** Readiness: one bounded round trip to the database. Never throws; the reason stays in the caller's log, not in an answer. */
export async function pingDatabase(timeoutMs = 2000): Promise<{ status: "ok" | "failed"; latencyMs: number; error?: string }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
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

/** Ends the pool on shutdown, after the last transaction. */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

/** Appends a hash-chained audit entry for an action to the lender's state. */
export function appendAudit(state: DomainState, ctx: Context, action: string, objectId: string, summary: string, changes?: unknown): ValopayRecord {
  const chain = recordsOf(state, "audit").sort((a, b) => Number(a.data.sequence || 0) - Number(b.data.sequence || 0));
  const previous = chain.at(-1);
  const body = { sequence: chain.length + 1, actor: ctx.actor, action, objectId, summary, changeDigest: digest(canonical(changes ?? {})), previousHash: previous?.data.hash ?? "GENESIS", timestamp: ctx.now };
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
