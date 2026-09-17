import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { allowedPath, assertSafeText, snapshot } from "./github-snapshot.mjs";

for (const path of ["README.md", "artifacts/api-server/src/app.ts", "lib/db/src/schema/index.ts", "scripts/github-sync.mjs"]) assert.equal(allowedPath(path), true);
for (const path of [".agents/memory/MEMORY.md", ".conversation/file.md", "docs/source/business.txt", "docs/PUBLISHED_SANDBOX_VERIFICATION.md", "artifacts/valo-pay/.env.local", "artifacts/api-server/dist/index.js", "lib/backups/records.json", "scripts/password.key", "lib/../private.json"]) assert.equal(allowedPath(path), false, path);
assert.throws(() => assertSafeText("fixture", "ghp_" + "a".repeat(36)), /Potential credential/);
assert.throws(() => assertSafeText("fixture", ["postgres:", "//real:password", "@example.invalid/db"].join("")), /Potential credential/);
assert.doesNotThrow(() => assertSafeText("fixture", 'process.env.CLERK_SECRET_KEY'));
const root = mkdtempSync(join(tmpdir(), "valopay-github-test-"));
try {
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, ".agents"));
  for (const [path, text] of [["README.md", "# Example\n"], ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n"], [".agents/internal.md", "private local material"]]) writeFileSync(join(root, path), text);
  execFileSync("git", ["add", "."], { cwd: root });
  assert.equal(snapshot(root).files.length, 2);
  assert.deepEqual(snapshot(root).excluded, [".agents/internal.md"]);
  // Source uses working files, not stale staged bytes.
  writeFileSync(join(root, "README.md"), "# Updated\n");
  assert.equal(snapshot(root).files.find(f => f.path === "README.md").content, "# Updated\n");
  writeFileSync(join(root, "README.md"), Buffer.from([0]));
  assert.throws(() => snapshot(root), /Binary file/);
  rmSync(join(root, "README.md"));
  symlinkSync("/etc/hosts", join(root, "README.md"));
  assert.throws(() => snapshot(root), /Unsupported link/);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("Snapshot safeguards passed: exclusion rules, secret markers, current bytes, binary and symlink refusal.");