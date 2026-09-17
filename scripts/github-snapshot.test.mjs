import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { allowedPath, assertSafeText, snapshot } from "./github-snapshot.mjs";
import { target, assertDestination, selectSyncFiles, changedFiles } from "./github-sync-policy.mjs";

const approvedRepo = { full_name: target, private: false, archived: false, permissions: { push: true } };
assert.doesNotThrow(() => assertDestination(approvedRepo));
for (const override of [{ full_name: "other/repo" }, { private: true }, { private: undefined }, { archived: true }, { permissions: { push: false } }]) {
  assert.throws(() => assertDestination({ ...approvedRepo, ...override }), /approved public writable destination/);
}
const source = { path: "README.md", type: "blob", mode: "100644", sha: "source-new", content: "reviewed" };
const workflow = { path: ".github/workflows/ci.yml", type: "blob", mode: "100644", sha: "workflow-new", content: "reviewed workflow" };
const remoteWorkflow = { ...workflow, sha: "workflow-old" };
delete remoteWorkflow.content;
const otherRemoteWorkflow = { ...remoteWorkflow, path: ".github/workflows/other.yml" };
assert.deepEqual(selectSyncFiles([source, workflow], [], false), [source, workflow]);
assert.deepEqual(selectSyncFiles([source, workflow], [], true), [source]);
const preserved = selectSyncFiles([source, workflow], [remoteWorkflow, otherRemoteWorkflow], true);
assert.deepEqual(preserved, [source, remoteWorkflow, otherRemoteWorkflow]);
assert.deepEqual(changedFiles(preserved, [remoteWorkflow, otherRemoteWorkflow]), [source]);
assert.deepEqual(changedFiles([source, workflow], [source, remoteWorkflow]), [workflow]);
assert.deepEqual(changedFiles(preserved, preserved), []);

for (const path of ["README.md", "artifacts/api-server/src/app.ts", "lib/db/src/schema/index.ts", "scripts/github-sync.mjs", ".github/workflows/ci.yml"]) assert.equal(allowedPath(path), true);
for (const path of [".agents/memory/MEMORY.md", ".conversation/file.md", "docs/source/business.txt", "docs/PUBLISHED_SANDBOX_VERIFICATION.md", "artifacts/valo-pay/.env.local", "artifacts/api-server/dist/index.js", "lib/backups/records.json", "scripts/password.key", "lib/../private.json", ".github/workflows/deploy.yml", ".github/workflows/ci.yaml", ".github/actions/custom/action.yml", ".github/workflows/../private.yml"]) assert.equal(allowedPath(path), false, path);
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
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: Approved CI\n");
  writeFileSync(join(root, ".github/workflows/deploy.yml"), "name: Unreviewed deployment\n");
  execFileSync("git", ["add", ".github"], { cwd: root });
  assert.equal(snapshot(root).files.length, 3);
  assert.equal(snapshot(root).files.find(f => f.path === ".github/workflows/ci.yml").content, "name: Approved CI\n");
  assert.deepEqual(snapshot(root).excluded, [".agents/internal.md", ".github/workflows/deploy.yml"]);
  writeFileSync(join(root, ".github/workflows/ci.yml"), "ghp_" + "a".repeat(36));
  assert.throws(() => snapshot(root), /Potential credential/);
  writeFileSync(join(root, ".github/workflows/ci.yml"), "name: Approved CI\n");
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