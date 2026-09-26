import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const command = path.join(root, "scripts/src/verify-paystack-event.ts");
const tsx = path.join(root, "scripts/node_modules/tsx/dist/cli.mjs");
const clean = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(?:VALOPAY_|PAYSTACK_|DATABASE_URL$)/.test(name),
  ),
);
const id = "a".repeat(64),
  eventId = "synthetic-event-do-not-echo";
const args = ["--", "--connection-id", id, "--event-id", eventId];
let checks = 0;
function run(args, extra = {}) {
  const result = spawnSync(process.execPath, [tsx, command, ...args], {
    cwd: root,
    env: { ...clean, ...extra },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.ifError(result.error);
  checks++;
  return result;
}
assert.match(run(["--help"]).stdout, /^Use: verify-paystack-event/);
for (const input of [
  [],
  ["--key", "synthetic-secret-do-not-echo"],
  ["--connection-id", "not-valid", "--event-id", eventId],
]) {
  const result = run(input);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).result, "not_verified");
  assert.ok(!result.stderr.includes("synthetic-secret-do-not-echo"));
  assert.ok(!result.stderr.includes(eventId));
}
for (const extra of [
  {},
  {
    VALOPAY_PAYSTACK_INGRESS: "test",
    PAYSTACK_TEST_SECRET_KEY: ["sk", "live", "0".repeat(30)].join("_"),
  },
  {
    VALOPAY_PAYSTACK_INGRESS: "test",
    PAYSTACK_TEST_SECRET_KEY: ["sk", "test", "OFFLINE", "0".repeat(30)].join(
      "_",
    ),
  },
  // Even complete test mapping cannot call a provider without the local DB configuration.
  {
    VALOPAY_PAYSTACK_INGRESS: "test",
    PAYSTACK_TEST_SECRET_KEY: ["sk", "test", "OFFLINE", "0".repeat(30)].join(
      "_",
    ),
    VALOPAY_PAYSTACK_CONNECTIONS: JSON.stringify({
      [id]: {
        workspaceId: "synthetic-workspace",
        merchantId: "synthetic-lender",
      },
    }),
  },
]) {
  const result = run(args, extra);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).result, "not_verified");
  assert.ok(!result.stderr.includes(eventId));
  assert.ok(!result.stderr.includes(id));
  assert.ok(
    !result.stderr.includes(extra.PAYSTACK_TEST_SECRET_KEY ?? "never-present"),
  );
}
console.log(
  `Paystack verification command: ${checks} offline help, argument, credential and pre-network refusal checks passed.`,
);
