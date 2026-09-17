// Runs every offline check: no database, no network, no Replit services.
// Database-backed integration tests stay opt-in (see README).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "scripts", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
if (!existsSync(tsx)) throw new Error("tsx is missing; run pnpm install first.");
const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgres://unused:unused@127.0.0.1:1/unused" };
const steps = [
  ["node", ["scripts/check-db-boundary.mjs"]],
  ["node", ["scripts/github-snapshot.test.mjs"]],
  [tsx, ["artifacts/api-server/tests/valopay-store-guards.test.ts"]],
  [tsx, ["artifacts/api-server/tests/export-download.test.ts"]],
  [tsx, ["artifacts/api-server/tests/validation-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/retry-engine-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/reconciliation-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/measurement-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/dispute-pack.test.ts"]],
  [tsx, ["artifacts/api-server/tests/billing-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/test5-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/ret07-alerts-golden.test.ts"]],
  [tsx, ["artifacts/api-server/tests/api-shell-golden.test.ts"]],
];
for (const [command, args] of steps) {
  console.log(`\n▶ ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) { console.error(`✕ ${args.join(" ")} failed`); process.exit(result.status ?? 1); }
}
console.log("\nAll offline checks passed.");
