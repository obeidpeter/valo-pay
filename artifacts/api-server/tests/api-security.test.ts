// Offline security regression checks for the API shell (see docs/security-review.md):
// how a thrown error is answered, and the headers and origin rule on every /api/v1 answer.
// No database: the webhook ingress route answers without one, and the error handler is
// exercised with a fake request and response.
import assert from "node:assert/strict";
import { ZodError } from "zod";
import { errorHandler } from "../src/lib/error-handler.js";
import { validateRecord } from "../src/domain/validation.js";

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
  assert.equal(answer(new Error("Execution is not permitted in observation mode.")).status, 403, "the wording of a refusal implies 403");
  const typeError = answer(new TypeError("Cannot read properties of undefined (reading 'merchant')"));
  assert.equal(typeError.status, 500, "a programming error is a 500");
  assert.equal((typeError.body as { error: string }).error, "We could not complete this action. No changes were saved. Try again.", "a programming error's message stays out of the response");
  assert.equal(answer(new ReferenceError("x is not defined")).status, 500);
  assert.equal(answer("a string thrown by mistake").status, 500, "something that is not an Error is a 500");
  assert.equal(answer(Object.assign(new Error("duplicate key"), { code: "23505" })).status, 409, "a database safety constraint is a conflict");
  assert.equal(answer(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).status, 500, "an error with a code the application does not own is a 500");
  const zod = answer(new ZodError([{ code: "custom", path: ["data", "amountKobo"], message: "Expected number" }]));
  assert.equal(zod.status, 400);
  assert.deepEqual((zod.body as { details: unknown[] }).details, [{ field: "data.amountKobo", message: "Expected number" }], "validation failures name their fields");
  checks += 11;
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
  checks += 11;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`API security tests passed (${checks} checks): error answers, prototype keys, response headers, origin rule, body limit, webhook ingress.`);
