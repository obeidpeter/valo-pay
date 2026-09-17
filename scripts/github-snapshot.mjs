import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

const roots = new Set([".gitignore", ".npmrc", ".replit", ".replitignore", "README.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "tsconfig.json", "replit.md"]);
const docs = new Set(["docs/BUILD_STATUS.md", "docs/DATABASE_SECURITY.md", "docs/frontend-contract.md"]);
// Workflows execute code on GitHub. Review each file before approving its export.
const workflows = new Set([".github/workflows/ci.yml"]);
const sourceExtension = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|css|html|svg|sh|md)$/;
const excludedSegment = /^(?:\.git|\.agents|\.conversation|\.local|\.cache|\.config|node_modules|dist|coverage|attached_assets|uploads|backups|exports)$/;

export function allowedPath(path) {
  if (path.split("/").some(p => excludedSegment.test(p) || p === ".." || p.startsWith(".env"))) return false;
  if (/\.(?:pem|key|p12|pfx|log|dump|sqlite3?|tsbuildinfo)$/i.test(path)) return false;
  return roots.has(path) || docs.has(path) || workflows.has(path) || (
    /^(?:artifacts\/(?:api-server|valo-pay|mockup-sandbox)\/|lib\/|scripts\/)/.test(path) &&
    sourceExtension.test(path)
  );
}

export function assertSafeText(path, text) {
  // A deliberately unusable fixture, not a real credential.
  const reviewed = text.replaceAll("postgres://unused:unused@127.0.0.1:1/unused", "[dummy fixture]");
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
    /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/,
    /(?:postgres(?:ql)?|https?):\/\/[^\s/:]+:[^\s/@]+@/,
    /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/,
    /\bAKIA[0-9A-Z]{16}\b/,
  ];
  if (patterns.some(pattern => pattern.test(reviewed))) throw new Error(`Potential credential in ${path}; upload refused. Review locally without printing the match.`);
}

export function snapshot(root) {
  const entries = execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = [];
  const excluded = [];
  for (const entry of entries) {
    const [info, path] = entry.split("\t");
    const [mode, , stage] = info.split(" ");
    if (stage !== "0") throw new Error("Resolve Git conflicts before uploading.");
    if (!allowedPath(path)) { excluded.push(path); continue; }
    const absolute = resolve(root, path);
    if (!realpathSync(absolute).startsWith(realpathSync(root) + sep) || !lstatSync(absolute).isFile() || !["100644", "100755"].includes(mode)) {
      throw new Error(`Unsupported link or file mode: ${path}`);
    }
    const bytes = readFileSync(absolute);
    if (bytes.length > 2 * 1024 * 1024) throw new Error(`File needs a separate size review: ${path}`);
    if (bytes.includes(0)) throw new Error(`Binary file needs a separate review: ${path}`);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!Buffer.from(content).equals(bytes)) throw new Error(`Text conversion would change ${path}`);
    assertSafeText(path, content);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    files.push({ path, mode, type: "blob", content, sha });
  }
  if (!files.some(f => f.path === "README.md") || !files.some(f => f.path === "pnpm-lock.yaml")) throw new Error("Incomplete source snapshot.");
  if (files.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0) > 8 * 1024 * 1024) throw new Error("Snapshot requires a separate size review.");
  return { files, excluded };
}