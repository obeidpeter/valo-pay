import { execFileSync } from "node:child_process";

/**
 * The build stamp the API reports on every log line and on /api/healthz: the
 * commit, marked "-dirty" when a tracked file differs from it (as
 * `git describe --dirty` marks it; an untracked file cannot reach the bundle
 * without a tracked file importing it), and the build time. "unknown" outside
 * a git checkout.
 */
export function buildStamp(cwd, now = new Date()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let commit = "unknown";
  try {
    commit = git("rev-parse", "--short", "HEAD");
    if (git("status", "--porcelain", "--untracked-files=no")) commit += "-dirty";
  } catch { /* not a git checkout */ }
  return `${commit} ${now.toISOString()}`;
}
