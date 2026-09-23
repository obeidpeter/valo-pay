// The settings are checked once, at startup, before any module reads them: a
// bad value ends the process with one structured fatal line naming the
// setting, never its value; the close scheduler's switch takes on or off in
// any case and refuses anything else instead of failing open; and the export
// worker slows down while its queue cannot be read, logging the outage once
// and the recovery once instead of an error at every poll. Offline: the
// processes this starts use an unusable loopback database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { InvalidConfiguration, invalidConfigurationLine, readStartupConfig } from "../src/lib/startup-config";

let checks = 0;
const database = "postgres://unused:unused@127.0.0.1:1/unused";
// The export worker's modules load the database pool, which needs an address; nothing connects to it.
process.env["DATABASE_URL"] ??= database;
const { EXPORT_QUEUE_MAX_BACKOFF_MS, exportQueueDelay, startExportWorker } = await import("../src/lib/export-worker");
const base = { PORT: "8080", DATABASE_URL: database };
const problems = (env: Record<string, string | undefined>, purpose: "server" | "close-pass" = "server") => {
  try { readStartupConfig(env, purpose); return []; } catch (error) { assert.ok(error instanceof InvalidConfiguration); return error.problems; }
};

// ---- The defaults, and the switch that used to fail open ----
const defaults = readStartupConfig(base, "server");
assert.deepEqual(defaults, { port: 8080, closeScheduler: "on", logLevel: "info", logFormat: null, nodeEnv: null, databasePoolSize: 10, expiredWorkspaceCleanup: "off", staffAccess: "off", runtimeIsolation: "off", payloadEncryption: "off" });
for (const value of ["off", "OFF", "Off"]) assert.equal(readStartupConfig({ ...base, VALOPAY_CLOSE_SCHEDULER: value }, "server").closeScheduler, "off", value);
for (const value of ["on", "ON", ""]) assert.equal(readStartupConfig({ ...base, VALOPAY_CLOSE_SCHEDULER: value }, "server").closeScheduler, "on", value);
for (const value of ["false", "0", "no", "disabled", "of"]) assert.deepEqual(problems({ ...base, VALOPAY_CLOSE_SCHEDULER: value }), ["VALOPAY_CLOSE_SCHEDULER must be on or off (in any case)."], value);
checks += 11;

// ---- Each rule, named without the value ----
const rules: Array<[Record<string, string>, string]> = [
  [{ PORT: "70000" }, "PORT must be a whole number from 1 to 65535."],
  [{ PORT: "0" }, "PORT must be a whole number from 1 to 65535."],
  [{ PORT: "80a" }, "PORT must be a whole number from 1 to 65535."],
  [{ PORT: "" }, "PORT is required: the port this server listens on."],
  [{ DATABASE_URL: "" }, "DATABASE_URL is required: the PostgreSQL connection URL."],
  [{ DATABASE_URL: "mysql://synthetic-secret@db/x" }, "DATABASE_URL must be a postgres:// or postgresql:// connection URL."],
  [{ DATABASE_URL: "synthetic-secret" }, "DATABASE_URL must be a postgres:// or postgresql:// connection URL."],
  [{ VALOPAY_DATABASE_POOL_SIZE: "1" }, "VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100."],
  [{ VALOPAY_DATABASE_POOL_SIZE: "101" }, "VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100."],
  [{ LOG_LEVEL: "verbose" }, "LOG_LEVEL must be fatal, error, warn, info, debug, trace or silent."],
  [{ LOG_FORMAT: "text" }, "LOG_FORMAT must be pretty or json."],
  [{ NODE_ENV: "staging" }, "NODE_ENV must be development, production or test."],
  [{ VALOPAY_EXPIRED_WORKSPACE_CLEANUP: "ON" }, "VALOPAY_EXPIRED_WORKSPACE_CLEANUP must be on or off."],
  [{ VALOPAY_STAFF_ACCESS: "on" }, "VALOPAY_STAFF_ACCESS must be off or staging."],
  [{ VALOPAY_APP_ORIGINS: "https://valopay.example.test, valopay.example.test" }, "VALOPAY_APP_ORIGINS must list HTTPS origins, separated by commas, such as https://valopay.example."],
  [{ VALOPAY_PAYLOAD_ENCRYPTION: "yes" }, "VALOPAY_PAYLOAD_ENCRYPTION must be off or kms."],
  [{ VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: "synthetic-secret" }, "VALOPAY_KMS_KEY must be a Cloud KMS CryptoKey name (projects/…/locations/…/keyRings/…/cryptoKeys/…) when VALOPAY_PAYLOAD_ENCRYPTION is kms."],
  [{ VALOPAY_KMS_PREVIOUS_KEYS: "projects/p/locations/l/keyRings/r/cryptoKeys/k, synthetic-secret" }, "VALOPAY_KMS_PREVIOUS_KEYS must list Cloud KMS CryptoKey names, separated by commas."],
  [{ VALOPAY_RUNTIME_ISOLATION: "true" }, "VALOPAY_RUNTIME_ISOLATION must be off or staging."],
];
for (const [change, problem] of rules) {
  const found = problems({ ...base, ...change });
  assert.deepEqual(found, [problem], JSON.stringify(change));
  assert.ok(!found.join(" ").includes("synthetic-secret"), "a value is never repeated: it may be a credential");
  checks += 2;
}
// The close pass listens on no port, so it needs none.
assert.equal(readStartupConfig({ DATABASE_URL: database }, "close-pass").port, null);
assert.deepEqual(problems({ DATABASE_URL: database, PORT: "not a port" }, "close-pass"), []);
checks += 2;

// Staff access and the restricted runtime need their companions, checked here instead of on every request.
assert.deepEqual(problems({ ...base, VALOPAY_STAFF_ACCESS: "staging" }), [
  "VALOPAY_STAFF_ISSUER must be the Clerk issuer's HTTPS origin when VALOPAY_STAFF_ACCESS is staging.",
  "VALOPAY_STAFF_ORIGINS must list one or more HTTPS origins, separated by commas, when VALOPAY_STAFF_ACCESS is staging.",
  "CLERK_SECRET_KEY is required when VALOPAY_STAFF_ACCESS is staging: without it no one can sign in.",
]);
const staff = { ...base, VALOPAY_STAFF_ACCESS: "staging", VALOPAY_STAFF_ISSUER: "https://clerk.example.test", VALOPAY_STAFF_ORIGINS: "https://valopay.example.test, https://staff.example.test", CLERK_SECRET_KEY: "sk_test_synthetic" };
assert.equal(readStartupConfig(staff, "server").staffAccess, "staging");
// The close pass signs no one in, so a staff host's close pass needs no Clerk key.
const { CLERK_SECRET_KEY: _clerk, ...staffWithoutClerk } = staff;
assert.deepEqual(problems(staffWithoutClerk, "close-pass"), []);
checks += 1;
assert.deepEqual(problems({ ...staff, VALOPAY_STAFF_ORIGINS: "http://valopay.example.test" }), ["VALOPAY_STAFF_ORIGINS must list one or more HTTPS origins, separated by commas, when VALOPAY_STAFF_ACCESS is staging."]);
assert.deepEqual(problems({ ...base, VALOPAY_RUNTIME_ISOLATION: "staging" }).length, 6, "every missing companion of the restricted runtime is named at once");
const isolated = { ...staff, VALOPAY_RUNTIME_ISOLATION: "staging", VALOPAY_RUNTIME_SCHEMA: "valopay_runtime_staging_pilot", VALOPAY_RUNTIME_ROLE: "valopay_runtime_login", VALOPAY_PAYLOAD_ENCRYPTION: "kms", VALOPAY_KMS_KEY: "projects/p/locations/l/keyRings/r/cryptoKeys/k", VALOPAY_RUNTIME_SERVICE_ORG: "org_Synthetic", VALOPAY_RUNTIME_SERVICE_USER: "user_Synthetic" };
assert.equal(readStartupConfig(isolated, "server").runtimeIsolation, "staging");
assert.deepEqual(problems({ ...isolated, VALOPAY_RUNTIME_SCHEMA: "valopay_runtime_staging" }), ["VALOPAY_RUNTIME_SCHEMA must name a valopay_runtime_staging_<suffix> schema when VALOPAY_RUNTIME_ISOLATION is staging."]);
// Several problems are one line, all of them named.
assert.equal(problems({ PORT: "70000", DATABASE_URL: database, LOG_LEVEL: "verbose", VALOPAY_CLOSE_SCHEDULER: "false" }).length, 3);
const line = JSON.parse(invalidConfigurationLine(["PORT must be a whole number from 1 to 65535."], "server", 0));
assert.deepEqual([line.level, line.event, line.service, line.purpose, line.problems], [60, "config.invalid", "valopay-api", "server", ["PORT must be a whole number from 1 to 65535."]]);
checks += 8;

// ---- The processes: one fatal line before anything loads, and the switch as the health answer reports it ----
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const tsx = path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|LOG_|PORT$|DATABASE_URL$|NODE_ENV$|CLERK_)/.test(name)));
function start(entry: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [tsx, path.join(root, "artifacts", "api-server", "src", entry)], { cwd: root, env: { ...clean, ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.on("close", (status) => resolve(status)));
  return { child, exited, output: () => ({ stdout, stderr }) };
}
const refusals: Array<[string, Record<string, string>, string]> = [
  ["index.ts", { PORT: "70000", DATABASE_URL: database }, "PORT must be a whole number from 1 to 65535."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, LOG_LEVEL: "verbose" }, "LOG_LEVEL must be fatal, error, warn, info, debug, trace or silent."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, VALOPAY_DATABASE_POOL_SIZE: "1" }, "VALOPAY_DATABASE_POOL_SIZE must be a whole number from 2 to 100."],
  ["index.ts", { PORT: "18093", DATABASE_URL: database, VALOPAY_CLOSE_SCHEDULER: "false" }, "VALOPAY_CLOSE_SCHEDULER must be on or off (in any case)."],
  ["index.ts", { PORT: "18093" }, "DATABASE_URL is required: the PostgreSQL connection URL."],
  ["close-pass.ts", { DATABASE_URL: database, VALOPAY_RUNTIME_ISOLATION: "on" }, "VALOPAY_RUNTIME_ISOLATION must be off or staging."],
];
for (const [entry, env, problem] of refusals) {
  const refused = start(entry, env);
  const status = await refused.exited, { stdout, stderr } = refused.output();
  assert.equal(status, 1, `${entry} ${JSON.stringify(env)}: ${stdout}${stderr}`);
  const lines = stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `one line, nothing before it: ${stdout}`);
  const fatal = JSON.parse(lines[0]!);
  assert.deepEqual([fatal.level, fatal.event, fatal.problems], [60, "config.invalid", [problem]]);
  assert.doesNotMatch(stderr, /\n\s+at /, "no stack");
  checks += 4;
}

// OFF, in capitals, is off: the health answer and the log say so, and nothing is scheduled.
const free = createServer();
free.listen(0, "127.0.0.1");
await once(free, "listening");
const port = (free.address() as { port: number }).port;
free.close();
const server = start("index.ts", { PORT: String(port), DATABASE_URL: database, VALOPAY_CLOSE_SCHEDULER: "OFF", LOG_FORMAT: "json", CLERK_SECRET_KEY: "sk_test_placeholder", CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from("clerk.example.test$").toString("base64")}`, CLERK_TELEMETRY_DISABLED: "1" });
try {
  let health: { scheduler?: { state?: string } } | undefined;
  for (let attempt = 0; attempt < 100 && !health; attempt++) {
    health = await fetch(`http://127.0.0.1:${port}/api/healthz`).then((response) => response.ok ? response.json() as Promise<typeof health> : undefined, () => undefined);
    if (!health) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(health?.scheduler?.state, "off", server.output().stdout);
  const events = server.output().stdout.split("\n").filter((text) => text.startsWith("{")).map((text) => JSON.parse(text).event);
  assert.ok(events.includes("scheduler.off") && !events.includes("scheduler.started"), events.join(","));
  checks += 2;
} finally {
  server.child.kill("SIGTERM");
  await server.exited;
}

// ---- The export worker: slower looks at a queue that cannot be read, and two lines for the whole outage ----
assert.deepEqual([0, 1, 2, 3, 6, 7, 40].map((failures) => exportQueueDelay(failures, 1500)), [1500, 3000, 6000, 12000, 60000, 60000, 60000]);
assert.equal(EXPORT_QUEUE_MAX_BACKOFF_MS, 60_000);
checks += 2;
const logged: Array<Record<string, unknown>> = [];
const log = { info: (fields: Record<string, unknown>) => logged.push({ level: "info", ...fields }), error: (fields: Record<string, unknown>) => logged.push({ level: "error", ...fields }) } as any;
let looks = 0, failedLooks = 0, failing = true;
const outage = new Error("connect ECONNREFUSED 127.0.0.1:1");
const repository = { candidates: async () => { looks += 1; if (failing) { failedLooks += 1; throw outage; } return []; } } as any;
const worker = startExportWorker({ intervalMs: 10, maxBackoffMs: 80, log, repository });
await new Promise((resolve) => setTimeout(resolve, 400));
// Without the backoff a look every 10 ms is about 40 looks; with it, 0, 20, 60, 140, 220 and 300 ms.
assert.ok(looks >= 3 && looks <= 8, `looks while failing: ${looks}`);
failing = false;
for (let wait = 0; wait < 50 && !logged.some((line) => line.event === "export.queue_recovered"); wait++) await new Promise((resolve) => setTimeout(resolve, 20));
worker.stop();
await worker.settle();
assert.deepEqual(logged.map((line) => [line.level, line.event]), [["error", "export.queue_error"], ["info", "export.queue_recovered"]]);
assert.equal(logged[0]!.err, outage);
assert.equal(logged[0]!.retryInMs, 20);
assert.equal(logged[1]!.failures, failedLooks);
checks += 5;

console.log(`Startup configuration checks passed (${checks}): every setting checked once with one fatal line that names it and never its value, the close scheduler's switch in any case and refusing anything but on or off, and an export queue outage slowing the worker's looks and logged once when it starts and once when it ends.`);
