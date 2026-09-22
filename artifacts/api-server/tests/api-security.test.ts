// Offline security regression checks for the API shell (see docs/security-review.md):
// how a thrown error is answered, and the headers and origin rule on every /api/v1 answer.
// No database: the webhook ingress routes answer without one, and the error handler is
// exercised with a fake request and response.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { ZodError } from "zod";
import { errorHandler } from "../src/lib/error-handler.js";
import { validateRecord } from "../src/domain/validation.js";
import { markRolledBack } from "../src/lib/transaction-outcome.js";
import { storageFailure } from "../src/lib/export-download.js";

let checks = 0;
type Answer = { status?: number; body?: unknown };
function answer(error: unknown): Answer {
  const out: Answer = {};
  const logged: unknown[] = [];
  const req = { id: "test-request", log: { error: (...args: unknown[]) => logged.push(args), warn: (...args: unknown[]) => logged.push(args), info: (...args: unknown[]) => logged.push(args) } };
  const res = { headersSent: false, status(code: number) { out.status = code; return this; }, json(body: unknown) { out.body = body; return this; } };
  errorHandler(error, req as never, res as never, () => undefined);
  return out;
}

{
  const raised = Object.assign(new Error("Only an Admin can change lender settings."), { status: 403 });
  assert.deepEqual(answer(raised), { status: 403, body: { error: "Only an Admin can change lender settings.", requestId: "test-request" } }, "an error raised with a status is answered in its own words, with the request id");
  assert.deepEqual(answer(new Error("A reason is required for this business or destructive action.")), { status: 400, body: { error: "A reason is required for this business or destructive action.", requestId: "test-request" } }, "a domain rule without a status is a 400 in its own words");
  assert.equal(answer(new Error("Execution is not permitted in observation mode.")).status, 400, "a refusal without a status is a 400, whatever its wording");
  assert.equal(answer(new Error("Unsupported domain action: open_gate.")).status, 400, "words from the request never choose the status");
  const typeError = answer(new TypeError("Cannot read properties of undefined (reading 'merchant')"));
  assert.equal(typeError.status, 500, "a programming error is a 500");
  assert.equal((typeError.body as { error: string }).error, "We could not confirm this action. Check Operations or retry the same request before submitting a new one.", "a programming error's message stays out of the response and does not claim an unconfirmed write was rolled back");
  assert.equal(answer(new ReferenceError("x is not defined")).status, 500);
  assert.equal(answer("a string thrown by mistake").status, 500, "something that is not an Error is a 500");
  assert.equal(answer(Object.assign(new Error("duplicate key"), { code: "23505" })).status, 409, "a database safety constraint is a conflict");
  assert.equal(answer(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).status, 500, "an error with a code the application does not own is a 500");
  // The body parser's errors are the request's fault, even the JSON SyntaxError.
  const parserError = (type: string, status: number) => Object.assign(new SyntaxError("Unexpected token } in JSON at position 9"), { type, status, statusCode: status, expose: true });
  assert.deepEqual(answer(parserError("entity.parse.failed", 400)), { status: 400, body: { error: "The request body is not valid JSON. Check its format and try again.", requestId: "test-request" } }, "malformed JSON is a 400 in plain words");
  assert.equal(answer(parserError("entity.too.large", 413)).status, 413);
  assert.equal(answer(parserError("charset.unsupported", 415)).status, 415);
  assert.equal(answer(Object.assign(new Error("invalid byte sequence"), { code: "22021" })).status, 400, "a NUL that reached PostgreSQL text is the request's fault");
  assert.equal((answer(Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" })).body as { error: string }).error, "Text cannot contain the NUL character (\\u0000). Remove it and try again.");
  // A service the application found unavailable keeps its status and words; the store says when nothing was saved.
  const unconfigured = answer(Object.assign(new Error("Private export storage is not configured. Contact the workspace administrator."), { status: 503 }));
  assert.deepEqual(unconfigured, { status: 503, body: { error: "Private export storage is not configured. Contact the workspace administrator.", requestId: "test-request" } }, "an application 503 is not flattened to a general 500");
  const rolledBack = answer(markRolledBack(Object.assign(new Error("Protected data cannot be opened. Ask the administrator to check the configured encryption key."), { status: 503 })));
  assert.equal((rolledBack.body as { committed?: boolean }).committed, false, "a refusal inside a rolled-back transaction says nothing was saved");
  const rolledBackBug = answer(markRolledBack(new TypeError("Cannot read properties of undefined")));
  assert.deepEqual(rolledBackBug, { status: 500, body: { error: "This action failed and nothing was saved. Try again, and quote this reference if it happens again.", committed: false, requestId: "test-request" } }, "a programming error whose transaction rolled back says nothing was saved, still in general words");
  // Storage failures and integrity failures are server-side, never a 400.
  assert.equal(answer(storageFailure(503)).status, 503, "a storage outage is a 503");
  assert.equal(answer(storageFailure(404)).status, 502, "a missing export object is the service's failure");
  assert.equal(answer(storageFailure(403)).status, 502);
  assert.equal(answer(Object.assign(new Error("Export object could not be downloaded."), { statusCode: 500 })).status, 502, "an upstream status alone is never the request's fault");
  const integrity = answer(Object.assign(new Error("Export checksum verification failed. The file was not sent: generate the export again, and quote this reference if it happens again."), { status: 500, expose: true }));
  assert.equal(integrity.status, 500);
  assert.match((integrity.body as { error: string }).error, /checksum verification failed/, "an integrity failure explains itself");
  const zod = answer(new ZodError([{ code: "custom", path: ["data", "amountKobo"], message: "Expected number" }]));
  assert.equal(zod.status, 400);
  assert.deepEqual((zod.body as { details: unknown[] }).details, [{ field: "data.amountKobo", message: "Expected number" }], "validation failures name their fields");
  checks += 29;
}

{
  // A record's data cannot smuggle a key that names an object's own machinery.
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const data = JSON.parse(`{"${key}": {"polluted": true}, "note": "x"}`) as Record<string, unknown>;
    assert.throws(() => validateRecord({} as never, { role: "Admin" } as never, "customers", { data }), new RegExp(`data\\.${key} is not an allowed field`), `${key} is refused before anything else looks at the data`);
  }
  checks += 3;
}

// The shell over HTTP: placeholder Clerk keys make the middleware compute "signed out" locally, and a
// placeholder database address satisfies the store's start-up check; no query is ever made here.
process.env["DATABASE_URL"] ??= "postgres://postgres@127.0.0.1:1/valopay-unused";
// The log is not this test's subject; the observability test reads it back.
process.env["LOG_LEVEL"] ??= "silent";
process.env["CLERK_SECRET_KEY"] ??= "sk_test_placeholder";
process.env["CLERK_PUBLISHABLE_KEY"] ??= `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`;
const { default: app } = await import("../src/app.js");
const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;
const server = app.listen(0);
try {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const same = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(same.status, 403, "provider webhook ingress fails closed");
  assert.match(await errorOf(same), /ingress is disabled/);
  for (const [header, value] of [["cache-control", "private, no-store"], ["x-content-type-options", "nosniff"], ["referrer-policy", "no-referrer"], ["x-frame-options", "DENY"], ["cross-origin-resource-policy", "same-origin"]]) {
    assert.equal(same.headers.get(header!), value, `${header} on every /api/v1 answer`);
  }
  assert.equal(same.headers.get("x-powered-by"), null, "no server fingerprint");
  const own = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" });
  assert.match(await errorOf(own), /ingress is disabled/, "the console's own origin passes the origin rule");
  const foreign = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
  assert.equal(foreign.status, 403);
  assert.equal(await errorOf(foreign), "Cross-origin requests are not permitted.", "a request from another origin is refused before any route runs");
  const malformed = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "not a url" }, body: "{}" });
  assert.equal(await errorOf(malformed), "Invalid request origin.");
  const tooLarge = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: `{"pad":"${"x".repeat(2 * 1024 * 1024 + 10)}"}` });
  assert.equal(tooLarge.status, 413, "a body over the 2 MB limit is refused");
  assert.equal(tooLarge.headers.get("x-content-type-options"), "nosniff", "an oversized body is answered with the security headers");
  const brokenJson = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":' });
  assert.equal(brokenJson.status, 400, "malformed JSON is a 400, not a server failure");
  assert.equal(await errorOf(brokenJson), "The request body is not valid JSON. Check its format and try again.");
  for (const [header, value] of [["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["cache-control", "private, no-store"]]) assert.equal(brokenJson.headers.get(header!), value, `${header} on a malformed-body answer`);
  const foreignBroken = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: '{"action":' });
  assert.equal(await errorOf(foreignBroken), "Cross-origin requests are not permitted.", "the origin rule runs before the body is read");
  const nul = await fetch(`${base}/api/v1/webhooks/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { name: "Ada\u0000" } }) });
  assert.equal(nul.status, 400, "a NUL character is refused at the edge");
  assert.equal(await errorOf(nul), "Text cannot contain the NUL character (\\u0000). Remove it from data.name and try again.");
  checks += 21;

  // The Paystack test ingress checks a delivery's signature on its raw bytes before it touches a lender:
  // with the database unreachable, a forged delivery to a mapped connection is still a 401, not a 500.
  const paystackNames = ["VALOPAY_PAYSTACK_INGRESS", "PAYSTACK_TEST_SECRET_KEY", "VALOPAY_PAYSTACK_CONNECTIONS"] as const;
  const paystackSaved = Object.fromEntries(paystackNames.map((name) => [name, process.env[name]]));
  try {
    const key = ["sk", "test", "OFFLINE", "0".repeat(20)].join("_"), connection = "c".repeat(64);
    process.env["VALOPAY_PAYSTACK_INGRESS"] = "test";
    process.env["PAYSTACK_TEST_SECRET_KEY"] = key;
    process.env["VALOPAY_PAYSTACK_CONNECTIONS"] = JSON.stringify({ [connection]: { workspaceId: "unreachable-workspace", merchantId: "unreachable-lender" } });
    const event = JSON.stringify({ event: "charge.success", data: { domain: "test", id: "800001", status: "success", amount: 10000, currency: "NGN", reference: "OFFLINE-INGRESS-001", channel: "direct_debit" } });
    const deliver = (bytes: string, signature: string) => fetch(`${base}/api/v1/providers/paystack/${connection}/events`, { method: "POST", headers: { "Content-Type": "application/json", "X-Paystack-Signature": signature }, body: bytes });
    const forged = await deliver(event, "f".repeat(128));
    assert.equal(forged.status, 401, "a forged delivery is refused before the lender is locked or read");
    assert.equal(await errorOf(forged), "The Paystack webhook signature is invalid.");
    assert.equal(forged.headers.get("cache-control"), "no-store");
    assert.equal(forged.headers.get("x-content-type-options"), "nosniff");
    const live = event.replace('"domain":"test"', '"domain":"live"');
    assert.equal((await deliver(live, createHmac("sha512", key).update(live).digest("hex"))).status, 400, "a signed live-mode event is refused before the lender is opened");
    checks += 5;
  } finally {
    for (const name of paystackNames) { const value = paystackSaved[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`API security tests passed (${checks} checks): error answers and statuses, body-parser and NUL refusals, unavailable services and storage failures, prototype keys, response headers, origin rule before the body, body limit, webhook ingress, Paystack signature before any lender work.`);
