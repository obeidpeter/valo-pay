// Runs the database-backed suites against the database in DATABASE_URL, in
// order.  Opt-in only: each suite creates fresh synthetic fixtures in that
// database, so it must be a disposable development database with the schema
// pushed, never production.  The export-stream suite (App Storage credentials)
// and the HTTP suites (Replit development domain and Clerk) stay outside; see
// the README.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "scripts", "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
if (!existsSync(tsx)) throw new Error("tsx is missing; run pnpm install first.");
if (process.env.VALOPAY_RUN_INTEGRATION !== "1") {
  throw new Error("Set VALOPAY_RUN_INTEGRATION=1 to run the database-backed suites; they write synthetic fixtures to DATABASE_URL.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must point at a disposable development database that carries the pushed schema.");
}
const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || "development" };
const suites = [
  "artifacts/api-server/tests/record-index-migration.integration.test.ts",
  "artifacts/api-server/tests/valopay-store.integration.test.ts",
  "artifacts/api-server/tests/close-scheduler.integration.test.ts",
  "artifacts/api-server/tests/record-lists.integration.test.ts",
  "artifacts/api-server/tests/priority-queues.integration.test.ts",
  "artifacts/api-server/tests/workspace-concurrency.integration.test.ts",
  "artifacts/api-server/tests/export-jobs.integration.test.ts",
  "artifacts/api-server/tests/workflow-performance.integration.test.ts",
];
for (const suite of suites) {
  console.log(`\n▶ ${suite}`);
  const result = spawnSync(tsx, [suite], { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) { console.error(`✕ ${suite} failed`); process.exit(result.status ?? 1); }
}
console.log("\nDatabase-backed suites passed.");
