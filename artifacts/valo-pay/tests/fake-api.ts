// An in-memory Valo Pay API for the console tests: the real domain code (seed,
// validation, actions, reconciliation, reports, paging) behind the console's
// routes, with every response validated by the same zod contract the server
// uses, so a page is tested against what the API actually returns.  No
// database and no network.  What the server owns and this stands in for: the
// sandbox cookie and locks, the audit hash chain (a local chain here) and
// object storage (exports get a descriptor and a record, no file).
import { createHash, randomUUID } from "node:crypto";
import * as S from "@workspace/api-zod";
import { ZodError } from "zod";
import {
  ABSOLUTE_TICKET_FLOOR_KOBO, authorisationModes, closeTimeOf, defaultStatus, executionWindow, handBackOwners, isCloseTime,
  nextCloseInstant, recordKinds, roles,
} from "@workspace/valopay-schema";
import { customerTimeline, executeAction, makeRecord, rescheduleAfterSettings, validateRecord } from "../../api-server/src/domain";
import { enrolEligibleFailures } from "../../api-server/src/domain/policy-engine";
import type { Context, DomainState, ValopayRecord } from "../../api-server/src/domain/types";
import { seedMerchant } from "../../api-server/src/lib/valopay-seed";
import { getGates } from "../../api-server/src/lib/valopay-readiness";
import { pageRecords } from "../../api-server/src/lib/valopay-list";
import { importCsv } from "../../api-server/src/lib/valopay-import";
import { buildConsoleOverview, buildConsoleReports, buildConsoleSettings } from "../../api-server/src/lib/valopay-close-views";
import type { CloseRuntime } from "../../api-server/src/domain/effective-close-schedule";

export interface FakeCall { method: string; path: string; query: Record<string, string>; body: unknown; status: number }
export interface FakeApi {
  /** Lender ids in the order the workspace lists them. */
  merchantIds: string[];
  /** The persona every request runs as; set_role changes it like the server does. */
  role: string;
  /** The instant every request sees, fixed at install unless setNow is called. */
  now: string;
  scheduler: CloseRuntime;
  calls: FakeCall[];
  /** The current state of a lender (the first by default); mutations replace it, so read it fresh. */
  state(merchantId?: string): DomainState;
  /** Applies a change as a committed mutation with an audit entry, the way a request would. */
  mutate<T>(fn: (state: DomainState, ctx: Context) => T, merchantId?: string): T;
  setNow(iso: string): void;
  /** Makes the next request whose path (and method, when given) matches fail: with an API-style error body and status, or as a network failure ("offline"). */
  failNext(pattern: RegExp, failure: { status: number; error: string; details?: Array<{ field: string; message: string }> } | "offline", method?: string): void;
  /** Holds every request whose path matches until the returned function is called, so a loading or busy state can be seen. */
  hold(pattern: RegExp): () => void;
  uninstall(): void;
}

const kinds = new Set<string>(recordKinds);
const packKinds = ["dispute-pack", "customer-pack"];
const exportKinds = ["gate-pack", "billing", ...packKinds];
/** A declared function returning never, so a check such as `if (!old) fail(...)` narrows the way the server's does. */
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }

/** Same shape of canonical digest the repository uses; only consistency within this fake matters. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => (item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item));
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function appendAudit(state: DomainState, ctx: Context, action: string, objectId: string, summary: string, changes?: unknown): ValopayRecord {
  const chain = state.records.filter((record) => record.kind === "audit").sort((a, b) => Number(a.data.sequence || 0) - Number(b.data.sequence || 0));
  const previous = chain.at(-1);
  const body = { sequence: chain.length + 1, actor: ctx.actor, action, objectId, summary, changeDigest: digest(canonical(changes ?? {})), previousHash: previous?.data.hash ?? "GENESIS", timestamp: ctx.now };
  const record: ValopayRecord = { id: randomUUID(), merchantId: state.merchant.id, kind: "audit", name: action, status: "recorded", reference: "", amountKobo: 0, customerId: state.records.find((item) => item.id === objectId)?.customerId || "", createdAt: ctx.now, updatedAt: ctx.now, data: { ...body, hash: digest(canonical(body)) } };
  state.records.push(record);
  return record;
}
function verifyAudit(state: DomainState): { valid: boolean; count: number; headHash: string } {
  const chain = state.records.filter((record) => record.kind === "audit").sort((a, b) => Number(a.data.sequence) - Number(b.data.sequence));
  let hash = "GENESIS", valid = true, index = 0;
  for (const event of chain) {
    const { hash: recorded, ...body } = event.data;
    if (body.sequence !== ++index || body.previousHash !== hash || digest(canonical(body)) !== recorded) { valid = false; break; }
    hash = String(recorded);
  }
  return { valid, count: chain.length, headHash: hash };
}

/** Mirrors the server's error handler: zod details, a status carried by the error, or the permission wording that maps to 403. */
function toHttpError(error: unknown): { status: number; body: unknown } {
  if (error instanceof ZodError) return { status: 400, body: { error: "Validation failed.", details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })) } };
  const message = error instanceof Error ? error.message : String(error);
  const carried = (error as { status?: number } | null)?.status;
  const status = carried || (/not permitted|requires.*role|only.*admin|read-only|disabled|gate|instruction mode/i.test(message) ? 403 : 400);
  return { status, body: { error: message || "The operation was rejected." } };
}

type Handler = (params: Record<string, string>, query: Record<string, string>, body: any) => unknown;

export function installFakeApi(options: { now?: string; role?: string } = {}): FakeApi {
  const states = new Map<string, DomainState>();
  const failures: Array<{ pattern: RegExp; method?: string; failure: { status: number; error: string; details?: Array<{ field: string; message: string }> } | "offline" }> = [];
  const holds: Array<{ pattern: RegExp; promise: Promise<void> }> = [];
  const api: FakeApi = {
    merchantIds: [], role: options.role ?? "Admin", now: options.now ?? new Date().toISOString(), calls: [],
    scheduler: { state: 'running', intervalMs: 60_000, lastTickAt: options.now ?? new Date().toISOString(), lastSuccessAt: options.now ?? new Date().toISOString(), lastErrorAt: null },
    state(merchantId) { const id = merchantId ?? api.merchantIds[0]!; return states.get(id) ?? fail("Lender not found in this workspace.", 404); },
    mutate(fn, merchantId) { return withState(merchantId ?? api.merchantIds[0]!, fn, { action: "test.mutation", objectId: "workspace", summary: "Arranged by a console test" }); },
    setNow(iso) { api.now = iso; if (api.scheduler.state === 'running') { api.scheduler.lastTickAt = iso; api.scheduler.lastSuccessAt = iso; } },
    failNext(pattern, failure, method) { failures.push({ pattern, failure, method: method?.toUpperCase() }); },
    hold(pattern) {
      let release = (): void => { /* replaced by the promise's resolver */ };
      const entry = { pattern, promise: new Promise<void>((resolve) => { release = resolve; }) };
      holds.push(entry);
      return () => { holds.splice(holds.indexOf(entry), 1); release(); };
    },
    uninstall() { globalThis.fetch = originalFetch; },
  };
  const context = (): Context => ({ actor: `Sandbox ${api.role}`, role: api.role, now: api.now });

  // Two lenders, as the repository seeds a workspace, each with its first close cursor.
  for (const smaller of [false, true]) {
    const state = seedMerchant(randomUUID(), smaller);
    state.settings.anonymousWorkspace = true;
    state.settings.nextCloseAt = nextCloseInstant(api.now, closeTimeOf(state.settings));
    appendAudit(state, { actor: "System · sandbox seed", role: "Admin", now: api.now }, "sandbox.created", "workspace", "Created an isolated synthetic lender. Not live evidence.");
    states.set(state.merchant.id, state);
  }
  api.merchantIds = [...states.keys()].sort();

  /** A request-shaped mutation: work on a copy, and only a completed operation replaces the lender's state (the server rolls back otherwise). */
  function withState<T>(merchantId: string, fn: (state: DomainState, ctx: Context) => T, audit?: { action: string; objectId: string; summary: string }): T {
    const current = states.get(merchantId) ?? fail("Lender not found in this workspace.", 404);
    const ctx = context();
    if (!audit) return fn(current, ctx);
    const draft = structuredClone(current);
    const before = digest(canonical(draft));
    const result = fn(draft, ctx);
    enrolEligibleFailures(draft, ctx);
    appendAudit(draft, ctx, audit.action, audit.objectId, audit.summary, { beforeDigest: before, afterDigest: digest(canonical(draft)) });
    states.set(merchantId, draft);
    return result;
  }
  const merchantOf = (query: Record<string, string>) => S.GetOverviewQueryParams.parse(query).merchantId;

  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/v1\/workspace$/, () => S.GetWorkspaceResponse.parse({
      name: "Valo Pay", environment: "sandbox", actor: `Sandbox ${api.role}`, role: api.role, authenticated: false,
      merchants: api.merchantIds.map((id) => states.get(id)!.merchant), roles: [...roles], productionEnabled: false,
    })],
    ["GET", /^\/v1\/overview$/, (_p, query) => S.GetOverviewResponse.parse(withState(merchantOf(query), (state, ctx) => buildConsoleOverview(state, ctx.now, verifyAudit(state), api.scheduler)))],
    ["GET", /^\/v1\/records\/(?<kind>[^/]+)$/, (params, query) => {
      if (!kinds.has(params.kind!)) fail("Unknown resource.", 404);
      const parsed = S.ListRecordsQueryParams.parse(query);
      return S.ListRecordsResponse.parse(withState(parsed.merchantId, (state) => {
        const page = pageRecords(state.records.filter((record) => record.kind === params.kind), parsed);
        return { ...page, items: page.items.map((record) => record.kind === "exports" ? { ...record, data: { ...record.data, objectName: undefined, bucket: undefined } } : record) };
      }));
    }],
    ["POST", /^\/v1\/records\/(?<kind>[^/]+)$/, (params, query, raw) => {
      const kind = params.kind!;
      if (!kinds.has(kind)) fail("Unknown resource.", 404);
      const body = S.CreateRecordBody.parse(raw);
      return S.CreateRecordResponse.parse(withState(merchantOf(query), (state, ctx) => {
        const input = { ...body, status: body.status || defaultStatus[kind as keyof typeof defaultStatus] || "draft", data: { ...body.data, synthetic: true } as Record<string, any>, createdAt: ctx.now, updatedAt: ctx.now };
        if (["policies", "templates"].includes(kind)) { input.data.author = ctx.actor; input.data.version = 1; }
        if (kind === "due-items") input.data.outstandingKobo = body.amountKobo;
        if (kind === "attempts") { input.data.source = "external"; input.data.simulated = true; }
        validateRecord(state, ctx, kind, input);
        if (body.reference && state.records.some((record) => record.kind === kind && record.reference === body.reference && kind !== "observations")) fail("Reference already exists. Use an idempotency key for safe replay.", 409);
        return makeRecord(state, kind, input);
      }, { action: `post.records.${kind}`, objectId: "workspace", summary: "Synthetic workspace operation" }));
    }],
    ["PATCH", /^\/v1\/records\/(?<kind>[^/]+)\/(?<id>[^/]+)$/, (params, query, raw) => {
      const kind = params.kind!;
      if (!kinds.has(kind)) fail("Unknown resource.", 404);
      const body = S.UpdateRecordBody.parse(raw);
      return S.UpdateRecordResponse.parse(withState(merchantOf(query), (state, ctx) => {
        const old = state.records.find((record) => record.kind === kind && record.id === params.id);
        if (!old) fail("Record not found.", 404);
        const input = { ...old, ...body, data: { ...old.data, ...body.data, synthetic: true } as Record<string, any>, updatedAt: ctx.now };
        if (kind === "due-items") {
          const allocated = state.records.filter((record) => record.kind === "allocations" && record.status === "confirmed" && record.data.dueItemId === old.id).reduce((sum, record) => sum + record.amountKobo, 0);
          if (input.amountKobo < allocated) fail("Due amount cannot be reduced below confirmed allocations.");
          for (const key of ["experimentId", "experimentArm", "firstFailureAt"]) if (JSON.stringify(input.data[key]) !== JSON.stringify(old.data[key])) fail("Experiment assignment is immutable.");
          input.data.outstandingKobo = input.amountKobo - allocated;
          if (input.amountKobo !== old.amountKobo || String(input.data.dueDate) !== String(old.data.dueDate)) input.data.amendedAt = ctx.now;
        }
        validateRecord(state, ctx, kind, input, true);
        Object.assign(old, input);
        return old;
      }, { action: `patch.records.${kind}.${params.id}`, objectId: params.id!, summary: "Synthetic workspace operation" }));
    }],
    ["POST", /^\/v1\/actions$/, (_p, query, raw) => {
      const body = S.PerformActionBody.parse(raw);
      const merchantId = merchantOf(query);
      if (body.action === "set_role") {
        const role = String(body.data?.role);
        if (!(roles as readonly string[]).includes(role)) fail("Unknown sandbox persona.");
        return S.PerformActionResponse.parse(withState(merchantId, () => { api.role = role; return { message: `Now using ${role} demo persona. No real-world permissions were changed.`, data: { role } }; }, { action: "set_role", objectId: "workspace", summary: body.reason || "Synthetic workspace operation" }));
      }
      if (body.action === "verify_audit") return S.PerformActionResponse.parse(withState(merchantId, (state) => ({ message: "Audit-chain verification completed.", data: verifyAudit(state) }), { action: "verify_audit", objectId: "workspace", summary: body.reason || "Synthetic workspace operation" }));
      if (body.action === "mark_pack_used") fail("Synthetic packs cannot be recorded as evidence used in a real case.", 403);
      return S.PerformActionResponse.parse(withState(merchantId, (state, ctx) => executeAction(state, ctx, body), { action: body.action, objectId: body.recordId || "workspace", summary: body.reason || "Synthetic workspace operation" }));
    }],
    ["POST", /^\/v1\/imports$/, (_p, query, raw) => {
      const body = S.ImportRecordsBody.parse(raw);
      return S.ImportRecordsResponse.parse(withState(merchantOf(query), (state, ctx) => importCsv(state, ctx, body), body.commit ? { action: 'post.imports', objectId: 'workspace', summary: 'Synthetic CSV import' } : undefined));
    }],
    ["GET", /^\/v1\/customers\/(?<id>[^/]+)\/timeline$/, (params, query) => S.GetCustomerTimelineResponse.parse(withState(merchantOf(query), (state) => customerTimeline(state, params.id!)))],
    ["GET", /^\/v1\/reports$/, (_p, query) => S.GetReportsResponse.parse(withState(merchantOf(query), (state, ctx) => buildConsoleReports(state, ctx.now, api.scheduler)))],
    ["GET", /^\/v1\/gates$/, (_p, query) => S.GetGatesResponse.parse(withState(merchantOf(query), (state) => getGates(state)))],
    ["GET", /^\/v1\/settings$/, (_p, query) => S.GetSettingsResponse.parse(withState(merchantOf(query), (state, ctx) => buildConsoleSettings(state, ctx.role, ctx.now, api.scheduler)))],
    ["PATCH", /^\/v1\/settings$/, (_p, query, raw) => {
      const body = S.UpdateSettingsBody.parse(raw);
      return S.UpdateSettingsResponse.parse(withState(merchantOf(query), (state, ctx) => {
        if (ctx.role !== "Admin") fail("Only an Admin can change lender settings.", 403);
        const start = body.executionStart ?? state.settings.executionStart ?? executionWindow.defaultStartHour, end = body.executionEnd ?? state.settings.executionEnd ?? executionWindow.defaultEndHour;
        if (start < executionWindow.earliestHour || end > executionWindow.latestHour || start >= end) fail(`Execution window must be WAT hours within ${executionWindow.earliestHour}:00 to ${executionWindow.latestHour}:00 with the start before the end (DEB-01).`);
        if (body.minimumTicketKobo !== undefined && body.minimumTicketKobo < ABSOLUTE_TICKET_FLOOR_KOBO) fail("The ₦5,000 floor cannot be overridden.");
        if (body.defaultOwner && !(handBackOwners as readonly string[]).includes(body.defaultOwner)) fail("Valo execution ownership requires a verified production cutover.");
        if (body.authorisationMode && !(authorisationModes as readonly string[]).includes(body.authorisationMode)) fail(`Authorisation mode must be one of: ${authorisationModes.join(", ")}.`);
        for (const key of ["unallocatedAlertThreshold", "notificationCostAlertKobo"] as const) if (body[key] !== undefined && (!Number.isInteger(body[key]) || Number(body[key]) < 0)) fail(`${key} must be a non-negative integer.`);
        if (body.closeTime !== undefined && !isCloseTime(body.closeTime)) fail("closeTime must be a WAT time as HH:MM, for example 07:00 (REC-01).");
        const previous = { time: closeTimeOf(state.settings), enabled: state.settings.scheduledCloseEnabled !== false };
        Object.assign(state.settings, body);
        rescheduleAfterSettings(state, previous, ctx.now);
        return buildConsoleSettings(state, ctx.role, ctx.now, api.scheduler);
      }, { action: "patch.settings", objectId: "workspace", summary: "Synthetic workspace operation" }));
    }],
    ["POST", /^\/v1\/exports$/, (_p, query, raw) => {
      const body = S.CreateExportBody.parse(raw);
      if (!kinds.has(body.kind) && !exportKinds.includes(body.kind)) fail("Unknown export kind.");
      if (packKinds.includes(body.kind) && !body.customerId) fail("customerId is required for a pack.");
      const merchantId = merchantOf(query);
      return S.CreateExportResponse.parse(withState(merchantId, (state, ctx) => {
        if (body.customerId && !state.records.some((record) => record.kind === "customers" && record.id === body.customerId)) fail("Customer not found.", 404);
        const checksum = digest(canonical({ kind: body.kind, format: body.format, customerId: body.customerId ?? null, at: ctx.now, records: state.records.length }));
        const record = makeRecord(state, "exports", { name: `${body.kind} ${body.format}`, status: "ready", customerId: body.customerId ?? "", createdAt: ctx.now, data: { kind: body.kind, format: body.format, checksum, usedInRealCase: false, byteLength: 0, generationMs: 0, synthetic: true } });
        return { id: record.id, downloadUrl: `/api/v1/exports/${record.id}/download?merchantId=${merchantId}`, checksum, generatedAt: ctx.now };
      }, { action: "post.exports", objectId: "workspace", summary: "Synthetic workspace operation" }));
    }],
    ["GET", /^\/v1\/openapi\.json$/, () => ({ openapi: "3.1.0", info: { title: "Api", version: "1.0.0" }, paths: {} })],
  ];

  let failureCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const query = Object.fromEntries(url.searchParams.entries());
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const path = url.pathname.startsWith("/api") ? url.pathname.slice(4) : url.pathname;
    for (const entry of holds.filter((held) => held.pattern.test(path))) await entry.promise;
    // A planned failure stands in for the server refusing or the network dropping the request.
    const planned = failures.findIndex((entry) => entry.pattern.test(path) && (!entry.method || entry.method === method));
    if (planned >= 0) {
      const { failure } = failures.splice(planned, 1)[0]!;
      if (failure === "offline") { api.calls.push({ method, path, query, body, status: 0 }); throw new TypeError("Failed to fetch"); }
      api.calls.push({ method, path, query, body, status: failure.status });
      // As the API does: the request id in the body and on the answer, so the console can quote it.
      const requestId = `fake-${(++failureCount).toString(16).padStart(4, "0")}`;
      return new Response(JSON.stringify({ error: failure.error, ...(failure.details ? { details: failure.details } : {}), requestId }), { status: failure.status, headers: { "content-type": "application/json", "x-request-id": requestId } });
    }
    let status = 200, payload: unknown;
    try {
      if (!url.pathname.startsWith("/api")) fail("Not found.", 404);
      const route = routes.find(([verb, pattern]) => verb === method && pattern.test(path));
      if (!route) fail(path.startsWith("/v1/webhooks/") ? "Disabled until a provider-specific signed adapter is configured." : "Unknown resource.", path.startsWith("/v1/webhooks/") ? 403 : 404);
      payload = route[2](path.match(route[1])?.groups ?? {}, query, body);
    } catch (error) {
      ({ status, body: payload } = toHttpError(error));
    }
    api.calls.push({ method, path, query, body, status });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return api;
}
