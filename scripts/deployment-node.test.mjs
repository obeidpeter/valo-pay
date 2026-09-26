// Offline deployment runtime checks: never build/download or touch the database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wrapper = join(root, "scripts", "deployment-node.sh");
const version = readFileSync(join(root, ".node-version"), "utf8").trim();
const archive = `node-v${version}-linux-x64`;
const fixture = mkdtempSync(join(tmpdir(), "deployment-node-test-"));
const bin = join(fixture, "test-bin");
const fixtureWrapper = join(fixture, "scripts", "deployment-node.sh");
const pin = join(fixture, ".node-version");
const marker = join(fixture, "curl-was-invoked");

function invoke(script, mode, args = []) {
  const result = spawnSync("/bin/bash", [script, mode, ...args], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
  });
  assert.ifError(result.error);
  assert.equal(existsSync(marker), false, "runtime tests must never fetch an archive");
  return result;
}

function refused(result, message) {
  assert.notEqual(result.status, 0, `unexpected success: ${result.stdout} ${result.stderr}`);
  assert.match(result.stderr, message);
  assert.equal(result.stdout, "");
}

try {
  mkdirSync(dirname(fixtureWrapper), { recursive: true });
  mkdirSync(bin);
  copyFileSync(wrapper, fixtureWrapper);
  writeFileSync(pin, `${version}\n`);
  // An attempted download is an immediate failure, not a network request.
  writeFileSync(join(bin, "curl"), `#!/bin/sh\n: > '${marker}'\nexit 91\n`, { mode: 0o755 });

  refused(invoke(fixtureWrapper, "run", ["node", "--version"]), /Verified Node runtime missing/);

  const runtimeBin = join(fixture, ".deployment-runtime", archive, "bin");
  mkdirSync(runtimeBin, { recursive: true });
  writeFileSync(join(runtimeBin, "node"), `#!/bin/sh\necho v${version}\n`, { mode: 0o755 });
  refused(invoke(fixtureWrapper, "run", ["node", "--version"]), /checksum mismatch/);
  rmSync(join(fixture, ".deployment-runtime"), { recursive: true });

  writeFileSync(pin, "24.15.1\n");
  refused(invoke(fixtureWrapper, "build", ["node", "--version"]), /Unsupported deployment Node pin or platform/);
  writeFileSync(pin, `${version}\n`);
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
  refused(invoke(fixtureWrapper, "build", ["node", "--version"]), /Unsupported deployment Node pin or platform/);
  rmSync(join(bin, "uname"));

  const installed = join(root, ".deployment-runtime", archive, "bin", "node");
  if (existsSync(installed)) {
    const result = invoke(wrapper, "run", ["node", "--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `v${version}`);
    assert.ok(result.stderr.includes(`deployment-node: mode=run version=v${version} executable=`));
  } else {
    console.log("Installed runtime run-mode check skipped (runtime not present).");
  }
  console.log("Deployment Node offline fail-closed checks passed.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}