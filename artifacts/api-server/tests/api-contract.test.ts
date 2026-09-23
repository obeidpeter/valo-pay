// Offline checks that the contract (lib/api-spec/openapi.json) says what the
// routes do (audit item 24): which writes need an Idempotency-Key, that a
// missing merchantId is the same 400 everywhere, that date-times with an
// offset are accepted, and that every error answer has the documented body
// and status. The app runs against an unreachable database, so every request
// here is answered before any query or by the database-limit answer.
import assert from "node:assert/strict";
import { answerErrors, contractErrors, contractOperations, loadContract } from "./contract-schema.js";

process.env["DATABASE_URL"] ??= "postgres://postgres@127.0.0.1:1/valopay-unused";
process.env["LOG_LEVEL"] ??= "silent";
process.env["CLERK_SECRET_KEY"] ??= "sk_test_placeholder";
process.env["CLERK_PUBLISHABLE_KEY"] ??= `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
// Loaded after the placeholder database address is set: the store reads it on import (no query is ever made).
const { recoverableRequest } = await import("../src/lib/operation-recovery.js");

let checks = 0;
const failures: string[] = [];
/** Runs one group of checks; a failure is recorded and the next group still runs, so every gap shows at once. */
async function section(title: string, run: () => void | Promise<void>) {
  try { await run(); } catch (error) { failures.push(`${title}: ${error instanceof Error ? error.message : String(error)}`); }
}
const spec = loadContract();
const operations = contractOperations(spec);
const schemas = spec.components.schemas as Record<string, any>;
const label = (entry: { method: string; path: string }) => `${entry.method} ${entry.path}`;
const parameter = (operation: Record<string, any>, name: string) => (operation.parameters ?? []).find((item: any) => item.name === name);
const lenderScoped = (operation: Record<string, any>) => parameter(operation, "merchantId")?.required === true;
const writes = operations.filter((entry) => entry.method === "POST" || entry.method === "PATCH");
/** Operations answered without a workspace transaction: they never meet a database limit. */
const noDatabase = new Set(["GET /healthz", "GET /v1/openapi.json", "POST /v1/webhooks/{provider}", "POST /v1/team/verify"]);
/** A concrete path for a template: the first value of an enumerated parameter, a customer kind, or a 64-character hex id. */
function concrete(entry: { path: string; operation: Record<string, any> }): string {
  return entry.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const schema = parameter(entry.operation, name)?.schema ?? {};
    if (schema.enum) return String(schema.enum[0]);
    return name === "kind" ? "customers" : "a".repeat(64);
  });
}
/** A body the journal treats as recoverable, where the route needs one to be. */
const journalBody = (path: string) => path === "/v1/imports" ? { commit: true } : path === "/v1/actions" ? { action: "confirm_allocation" } : {};

// ---- 1. The error body and the statuses every operation can return ----
await section("error body and statuses", () => {
  const error = schemas.ErrorBody;
  assert.ok(error, "the contract describes the error body every refusal and failure carries");
  assert.deepEqual([...error.required].sort(), ["error", "requestId"]);
  assert.deepEqual(Object.keys(error.properties).sort(), ["code", "committed", "details", "error", "operation", "requestId"]);
  assert.deepEqual(error.properties.committed.const, false, "committed is only ever false: nothing was saved");
  assert.deepEqual(error.properties.operation.const, "cancelled");
  checks += 5;
  for (const entry of operations) {
    const { responses } = entry.operation;
    assert.ok(responses["500"], `${label(entry)} lists the 500 every route can answer`);
    for (const [status, response] of Object.entries(responses as Record<string, any>)) {
      if (Number(status) < 400) continue;
      const schema = response.content?.["application/json"]?.schema;
      // Readiness answers its own body, and staff re-verification answers the identity provider's instruction.
      const own = (label(entry) === "GET /readyz" && status === "503") || (label(entry) === "POST /v1/team/verify" && status === "403");
      if (!own) assert.deepEqual(schema, { $ref: "#/components/schemas/ErrorBody" }, `${label(entry)} ${status} names the error body`);
    }
    if (entry.path.startsWith("/v1/")) {
      assert.ok(responses["429"]?.headers?.["Retry-After"], `${label(entry)} lists 429 with Retry-After`);
      assert.ok(responses["403"], `${label(entry)} lists 403: another origin is refused`);
    }
    if (!noDatabase.has(label(entry)) && label(entry) !== "GET /readyz") assert.ok(responses["503"]?.headers?.["Retry-After"], `${label(entry)} lists the database-limit 503 with Retry-After`);
    if (lenderScoped(entry.operation)) {
      assert.ok(responses["400"] && responses["404"], `${label(entry)} lists 400 and 404 for its lender`);
      assert.deepEqual({ minLength: parameter(entry.operation, "merchantId").schema.minLength, maxLength: parameter(entry.operation, "merchantId").schema.maxLength }, { minLength: 1, maxLength: 100 }, `${label(entry)}: merchantId is 1 to 100 characters`);
    }
    if (entry.operation.requestBody) assert.ok(responses["400"] && responses["413"] && responses["415"], `${label(entry)} lists the body refusals 400, 413 and 415`);
    checks += 1;
  }
  for (const path of ["/v1/operations/{id}/retry", "/v1/operations/{id}/cancel"]) assert.ok(spec.paths[path].post.responses["410"], `${path} lists 410 for a request whose stored payload expired`);
  checks += 2;
});

// ---- 2. Every write says exactly what its route does with an Idempotency-Key ----
await section("keys in the contract", () => {
  for (const entry of operations) {
    const key = parameter(entry.operation, "Idempotency-Key");
    if (entry.method === "GET") { assert.equal(key, undefined, `${label(entry)} is a read: no key`); continue; }
    if (recoverableRequest(entry.method, concrete(entry), journalBody(entry.path))) assert.ok(key, `${label(entry)} is journaled when it carries a key, so the contract lists the header`);
    if (key) assert.deepEqual({ minLength: key.schema.minLength, maxLength: key.schema.maxLength }, { minLength: 8, maxLength: 200 }, `${label(entry)}: a key is 8 to 200 characters`);
    checks += 1;
  }
});

// ---- 3. The routes, answered before any query ----
const { default: app } = await import("../src/app.js");
const server = app.listen(0);
try {
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api`;
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  const fields = (data: any): string[] => (data?.details ?? []).map((detail: { field: string }) => detail.field);
  const documented = (method: string, path: string, answer: { status: number; data: unknown }) => {
    const problems = answerErrors(spec, method, path, answer.status, answer.data);
    assert.deepEqual(problems, [], `${method} ${path} answered as the contract documents`);
  };

  // A missing merchantId is a 400 naming the field on every lender-scoped operation.
  await section("missing merchantId", async () => { for (const entry of operations.filter((item) => lenderScoped(item.operation))) {
    const others = (entry.operation.parameters as any[]).filter((item) => item.in === "query" && item.required && item.name !== "merchantId").map((item) => `${item.name}=a`);
    const path = `${concrete(entry)}${others.length ? `?${others.join("&")}` : ""}`;
    const answer = await send(entry.method, path, entry.method === "GET" ? undefined : journalBody(entry.path));
    assert.equal(answer.status, 400, `${label(entry)} without merchantId: ${JSON.stringify(answer.data)}`);
    assert.ok(fields(answer.data).includes("merchantId"), `${label(entry)} names merchantId: ${JSON.stringify(answer.data)}`);
    documented(entry.method, path, answer);
    const empty = await send(entry.method, `${path}${path.includes("?") ? "&" : "?"}merchantId=`, entry.method === "GET" ? undefined : journalBody(entry.path));
    assert.equal(empty.status, 400, `${label(entry)} with an empty merchantId`);
    assert.ok(fields(empty.data).includes("merchantId"));
    // Sent twice, it is the same refusal, never the two values joined into one lender's name.
    const twice = await send(entry.method, `${path}${path.includes("?") ? "&" : "?"}merchantId=offline-lender&merchantId=other-lender`, entry.method === "GET" ? undefined : journalBody(entry.path));
    assert.equal(twice.status, 400, `${label(entry)} with merchantId sent twice: ${JSON.stringify(twice.data)}`);
    assert.ok(fields(twice.data).includes("merchantId"));
    checks += 7;
  } });

  // A write whose contract requires a key refuses a request without one, naming the header, before reading
  // its body; a write whose key is optional never asks for one. A key of the wrong length is refused by name.
  await section("keys the routes take", async () => { for (const entry of writes) {
    const key = parameter(entry.operation, "Idempotency-Key");
    const path = `${concrete(entry)}${lenderScoped(entry.operation) ? "?merchantId=offline-lender" : ""}`;
    const answer = await send(entry.method, path, journalBody(entry.path));
    if (key?.required) {
      assert.equal(answer.status, 400, `${label(entry)} requires a key: ${JSON.stringify(answer.data)}`);
      assert.deepEqual(fields(answer.data), ["Idempotency-Key"], `${label(entry)} names the missing header`);
    } else assert.ok(!fields(answer.data).includes("Idempotency-Key"), `${label(entry)} does not require a key: ${JSON.stringify(answer.data)}`);
    documented(entry.method, path, answer);
    if (key) {
      const short = await send(entry.method, path, journalBody(entry.path), { "Idempotency-Key": "short" });
      assert.equal(short.status, 400, `${label(entry)} refuses a short key`);
      assert.deepEqual(fields(short.data), ["Idempotency-Key"], `${label(entry)} names the short key: ${JSON.stringify(short.data)}`);
    }
    checks += 3;
  } });

  // Date-times with an offset pass validation and reach the lender (here, the database-limit answer).
  await section("offset date-times", async () => {
  const offset = await send("POST", `/v1/pilot/batches/${"b".repeat(64)}/commit?merchantId=offline-lender`, { expectedUpdatedAt: "2026-09-23T11:00:00.000+01:00" });
  assert.ok(!fields(offset.data).includes("expectedUpdatedAt"), `an offset date-time is accepted: ${JSON.stringify(offset.data)}`);
  assert.equal(offset.status, 503);
  checks += 2;
  });

  // The service's own refusals carry the documented error body.
  await section("documented refusals", async () => {
  assert.ok(schemas.ErrorBody, "the contract describes the error body");
  const refusals: Array<[string, string, unknown, Record<string, string>, number]> = [
    ["GET", "/v1/nowhere", undefined, {}, 404],
    ["POST", "/v1/webhooks/test", {}, {}, 403],
    ["GET", "/v1/workspace", undefined, { Origin: "https://elsewhere.example" }, 403],
    ["POST", "/v1/pilot/lenders", '{"name":', {}, 400],
    ["POST", "/v1/pilot/lenders", { name: "Nul\u0000" }, {}, 400],
    ["POST", "/v1/pilot/lenders", "x".repeat(2_100_000), {}, 413],
    ["POST", "/v1/pilot/lenders", "{}", { "Content-Type": "application/json; charset=latin1" }, 415],
    ["GET", "/v1/overview?merchantId=offline-lender", undefined, {}, 503],
  ];
  for (const [method, path, body, headers, status] of refusals) {
    const answer = await send(method, path, body, headers);
    assert.equal(answer.status, status, `${method} ${path}: ${JSON.stringify(answer.data)}`);
    assert.deepEqual(contractErrors(spec, schemas.ErrorBody, answer.data), [], `${method} ${path} answers the error body: ${JSON.stringify(answer.data)}`);
    if (!path.startsWith("/v1/nowhere")) documented(method, path, answer);
    checks += 2;
  }
  const busy = await send("GET", "/v1/overview?merchantId=offline-lender");
  assert.ok(Number(busy.headers.get("Retry-After")) > 0, "a database-limit 503 says when to retry");
  checks += 1;
  });
} finally {
  server.close();
}
if (failures.length) {
  console.error(failures.join("\n\n"));
  console.error(`API contract checks failed: ${failures.length} group(s).`);
  process.exit(1);
}

console.log(`API contract checks passed (${checks} checks): the error body and statuses, the Idempotency-Key each write takes, a missing merchantId, offset date-times and the documented refusals.`);
process.exit(0);
