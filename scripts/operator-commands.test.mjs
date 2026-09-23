// The operator commands as an operator runs them, offline: each script's own
// entry point, its options after the `--` that `pnpm run x -- --flag` passes
// on, a mistyped option, and the refusals that come before any provider or
// database is reached. Nothing here leaves this machine: the monitor probes a
// closed loopback port, and the other checks stop before they would connect.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
// Nothing the operator's shell holds reaches the scripts: each case sets what it needs.
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:VALOPAY_|PAYSTACK_|DATABASE_URL$|REPLIT_DEV_DOMAIN$)/.test(name)));
const unusableDatabase = "postgres://unused:unused@127.0.0.1:1/unused";

function run(script, args, env = {}) {
  const child = spawn(process.execPath, script.endsWith(".ts") ? [tsx, script, ...args] : [script, ...args], { cwd: root, env: { ...clean, ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 60_000);
  return new Promise((resolve) => child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, output: stdout + stderr }); }));
}

// ---- pnpm run check:operations ----
const monitor = "scripts/monitor-valopay.mjs";
let result = await run(monitor, ["--"], { VALOPAY_MONITOR_ORIGIN: "https://127.0.0.1:1" });
assert.equal(result.status, 0, result.output);
const probe = JSON.parse(result.stdout);
assert.equal(probe.mode, "dry-run");
assert.deepEqual(probe.codes, ["database_unready", "service_unavailable"], "a dry run reports an unreachable service by its codes");
// `--deliver` after the `--` is accepted; with no receiver it stops at the configuration, in the general words, and prints no key.
result = await run(monitor, ["--", "--deliver"], { VALOPAY_MONITOR_ORIGIN: "https://127.0.0.1:1", VALOPAY_ALERT_RESEND_KEY: "synthetic-provider-key" });
assert.equal(result.status, 1);
assert.match(result.stderr, /^Operational monitoring failed\. Check configuration/);
assert.ok(!result.output.includes("synthetic-provider-key"));
result = await run(monitor, ["--", "--delivr"]);
assert.equal(result.status, 1);
assert.match(result.stderr, /^Unknown option --delivr\. Use: pnpm run check:operations \[--deliver\]/, "a mistyped option is named, with the usage");
// A word that is not an option is counted, not repeated: it could be a receiver address or a key.
result = await run(monitor, ["https://alerts.example/synthetic-receiver-token"], { VALOPAY_MONITOR_ORIGIN: "https://127.0.0.1:1" });
assert.equal(result.status, 1);
assert.match(result.stderr, /^Argument 1 is not an option/);
assert.ok(!result.output.includes("synthetic-receiver-token"));

// ---- pnpm run check:paystack ----
const paystack = "scripts/src/check-paystack.ts";
// The options after the `--` are read; without a key the check stops before any request, and never prints the reference.
result = await run(paystack, ["--", "--mandate-reference", "SYNTHETIC_MANDATE_REFERENCE"]);
assert.equal(result.status, 1);
assert.equal(JSON.parse(result.stderr).code, "configuration");
assert.ok(!result.output.includes("SYNTHETIC_MANDATE_REFERENCE"));
result = await run(paystack, ["--", "--reference", "SYNTHETIC_REFERENCE"]);
assert.equal(result.status, 1);
assert.equal(JSON.parse(result.stderr).code, "invalid_input", "a reference needs its expected amount");
assert.ok(!result.output.includes("SYNTHETIC_REFERENCE"));
result = await run(paystack, ["--", "--help"]);
assert.equal(result.status, 0);
assert.match(result.stdout, /^Use: check-paystack /);

// ---- provision-pilot.ts ----
const provision = "scripts/provision-pilot.ts";
for (const args of [[], ["--synthetic-staging", "org_Synthetic", "user_Synthetic"], ["--", "--staging", "org_Synthetic", "user_Synthetic", "Synthetic workspace"], ["--synthetic-staging", "org_Synthetic", "user_Synthetic", "Synthetic", "workspace"]]) {
  result = await run(provision, args);
  assert.equal(result.status, 1, args.join(" "));
  assert.match(result.stderr, /^Usage: VALOPAY_STAFF_ACCESS=staging pnpm --filter @workspace\/scripts exec tsx \.\/provision-pilot\.ts --synthetic-staging/);
}
// Right arguments without staff access stop before the store loads: there is no DATABASE_URL, which loading it would need.
result = await run(provision, ["--", "--synthetic-staging", "org_Synthetic", "user_Synthetic", "Synthetic workspace"]);
assert.equal(result.status, 1);
assert.match(result.stderr, /^Set VALOPAY_STAFF_ACCESS=staging/);
// With staff access, the store loads (the import that once failed to resolve) and refuses a malformed organisation before it opens a connection.
result = await run(provision, ["--synthetic-staging", "organisation", "user_Synthetic", "Synthetic workspace"], { VALOPAY_STAFF_ACCESS: "staging", DATABASE_URL: unusableDatabase });
assert.equal(result.status, 1);
assert.match(result.stderr, /Provide a staging organisation, administrator user ID and workspace name\./);
assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|ECONNREFUSED/);

console.log("Operator commands passed offline: options after pnpm's --, a named mistyped option, uncopied values, the monitor's dry run and careful failure, the Paystack check's refusals before any request, and provision-pilot's usage, staff-access check and store refusal before any connection.");
