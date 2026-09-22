// The documentation check: what a document names must exist, what the code
// reads must be documented, the contract must describe itself, the shared
// schema must be documented, every document must reach the snapshot, and the
// prose must keep the spelling the console uses. Pure, run by `test:pure`.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { allowedPath } from "./github-snapshot.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const problems = [];
let checks = 0;
const check = (condition, message) => { checks += 1; if (!condition) problems.push(message); };

function walk(dir, keep) {
  const out = [];
  for (const entry of readdirSync(join(root, dir))) {
    if (["node_modules", "dist", ".git", "generated"].includes(entry)) continue;
    const path = join(dir, entry).replaceAll('\\', '/');
    if (statSync(join(root, path)).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

// ---- The documents ----
const documents = ["README.md", "replit.md", ...walk("docs", (p) => p.endsWith(".md")), "artifacts/api-server/src/fonts/README.md"];
const prose = (text) => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/\(https?:\/\/[^)]*\)/g, "").replace(/https?:\/\/\S+/g, "");

// ---- 1. Every path a document names exists (build outputs excepted: they exist only after a build) ----
const buildOutput = /(?:^|\/)(?:dist|node_modules|coverage)(?:\/|$)/;
for (const doc of documents) {
  const text = read(doc);
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].replace(/[.,;:]$/, "");
    if (!/^(?:artifacts|lib|scripts|docs|\.github|\.githooks)\/[\w./\[\]*-]+$/.test(token) || token.includes("*") || buildOutput.test(token)) continue;
    const shorthand = ["artifacts/valo-pay/src", "artifacts/api-server/src"].some((base) => existsSync(join(root, base, token)));
    check(existsSync(join(root, token)) || shorthand, `${doc} names a path that does not exist: ${token}`);
  }
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    check(existsSync(resolve(root, dirname(doc), target)), `${doc} links to a file that does not exist: ${target}`);
  }
}

// ---- 2. Every command a document names is a script ----
const rootScripts = new Set(Object.keys(JSON.parse(read("package.json")).scripts));
const packageScripts = new Map();
for (const file of ["artifacts", "lib", "scripts"].flatMap((d) => walk(d, (p) => p.endsWith("/package.json") || p === "scripts/package.json"))) {
  const pkg = JSON.parse(read(file));
  if (pkg.name) packageScripts.set(pkg.name, new Set(Object.keys(pkg.scripts ?? {})));
}
for (const doc of documents) {
  const text = read(doc);
  for (const match of text.matchAll(/pnpm run ([a-z][\w:-]*)|pnpm (test)\b/g)) {
    const name = match[1] ?? match[2];
    check(rootScripts.has(name), `${doc} names a root script that does not exist: pnpm run ${name}`);
  }
  for (const match of text.matchAll(/pnpm --filter (@workspace\/[\w-]+) run ([\w:-]+)/g)) {
    check(packageScripts.get(match[1])?.has(match[2]), `${doc} names a package script that does not exist: pnpm --filter ${match[1]} run ${match[2]}`);
  }
}

// ---- 3. Environment variables: documented when read, read when documented ----
const sources = ["artifacts", "lib"].flatMap((d) => walk(d, (p) => /\/src\/.*\.(?:ts|tsx|mjs|cjs)$/.test(p) && !/\.d\.ts$/.test(p)));
const readVariables = new Set();
for (const file of sources) for (const match of read(file).matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\["([A-Z][A-Z0-9_]*)"\])|import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) readVariables.add(match[1] ?? match[2] ?? match[3]);
const readme = read("README.md");
for (const name of readVariables) check(readme.includes(name), `README.md does not mention ${name}, which the code reads`);
const documented = [...readme.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => m[1]);
// Variables a test runner, a browser fixture or a script reads count as read: the table documents them for the person running those.
const otherReaders = [".github/workflows/ci.yml", ".replit", ...walk("scripts", (p) => /\.(?:mjs|cjs|sh|ts)$/.test(p)), ...walk("artifacts", (p) => /\/(?:tests|e2e)\/.*\.(?:ts|tsx|mjs)$/.test(p) || /\/(?:playwright[^/]*|vitest)\.config\.ts$/.test(p))].map((p) => read(p)).join("\n");
for (const name of documented) check(readVariables.has(name) || otherReaders.includes(name), `README.md documents ${name}, which nothing reads`);

// ---- 4. The contract describes itself ----
const spec = JSON.parse(read("lib/api-spec/openapi.json"));
check(spec.info.title !== "Api", "the contract's title is the generator's placeholder");
for (const [path, methods] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(methods)) {
  check(operation.summary && operation.description, `${method.toUpperCase()} ${path} has no summary or description`);
  for (const parameter of operation.parameters ?? []) check(parameter.description, `${method.toUpperCase()} ${path}: parameter ${parameter.name} is not described`);
}
for (const [name, schema] of Object.entries(spec.components.schemas)) check(schema.description, `schema ${name} is not described`);

// ---- 5. The shared schema's exports carry a doc comment ----
for (const file of walk("lib/valopay-schema/src", (p) => p.endsWith(".ts"))) {
  const text = read(file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const node of source.statements) {
    if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) || ts.isExportDeclaration(node)) continue;
    const name = node.name?.text ?? (ts.isVariableStatement(node) ? node.declarationList.declarations.map((d) => d.name.getText(source)).join(",") : "?");
    const leading = text.slice(node.getFullStart(), node.getStart(source));
    check(/\/\*\*[\s\S]*?\*\/\s*$/.test(leading), `${file}: export ${name} has no doc comment`);
  }
}

// ---- 6. Every document reaches the GitHub snapshot ----
for (const doc of documents) check(allowedPath(doc), `${doc} is not in the snapshot tool's list and would be left out of a source upload`);

// ---- 7. The console's routes and the actions are in the contract ----
const contract = read("docs/frontend-contract.md");
for (const match of read("artifacts/valo-pay/src/App.tsx").matchAll(/path: '(\/[^']+)'/g)) check(contract.includes(`\`${match[1]}\``), `docs/frontend-contract.md does not list the route ${match[1]}`);
const actionsSource = read("artifacts/api-server/src/domain/actions.ts");
const reasoned = actionsSource.match(/const requiresReason = new Set\(\[([\s\S]*?)\]\);/)[1].match(/"([a-z_]+)"/g).map((s) => s.slice(1, -1));
const mutations = contract.slice(contract.indexOf("## Mutations"), contract.indexOf("## Imports & exports"));
for (const action of reasoned) check(mutations.includes(`\`${action}\``), `docs/frontend-contract.md does not describe the action ${action}`);
for (const match of mutations.matchAll(/`([a-z]+_[a-z_]+)`/g)) check(actionsSource.includes(`"${match[1]}"`), `docs/frontend-contract.md describes an action the code does not have: ${match[1]}`);

// ---- 8. Every route the API mounts is in the contract ----
// The routers index.ts mounts, plus the replay path the recovery middleware serves itself.
const operations = new Set(Object.entries(spec.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)));
const mounted = [...read("artifacts/api-server/src/routes/index.ts").matchAll(/from ["']\.\/([\w-]+)["']/g)].map((m) => `artifacts/api-server/src/routes/${m[1]}.ts`);
for (const file of mounted) for (const match of read(file).matchAll(/router\.(get|post|patch|put|delete)\(\s*["'`]([^"'`$]+)["'`]/g)) {
  const route = `${match[1].toUpperCase()} ${match[2].replace(/:(\w+)/g, "{$1}")}`;
  check(operations.has(route), `${file} serves ${route}, which lib/api-spec/openapi.json does not describe`);
}
check(!read("artifacts/api-server/src/lib/operation-recovery.ts").includes("/retry$/") || operations.has("POST /v1/operations/{id}/retry"), "the recovery middleware serves POST /v1/operations/{id}/retry, which lib/api-spec/openapi.json does not describe");

// ---- 9. British spelling in prose ----
const american = /\b(colou?rs?(?<!colour)(?<!colours)|behaviors?|organi[sz]ations?(?<!organisation)(?<!organisations)|organize[ds]?|centered|analyzed?|catalogs?|favorites?|honor(?:ed|s)?|labeled|labeling|canceled|fulfill(?:ed|s)?|authoriz(?:e[ds]?|ation|ing)|unauthorized|initializ(?:e[ds]?|ation|ing)|serializ(?:e[ds]?|ation)|normaliz(?:e[ds]?|ation)|optimiz(?:e[ds]?|ation)|customiz(?:e[ds]?|ation)|recogniz(?:e[ds]?|ation)|standardiz(?:e[ds]?|ation)|minimiz(?:e[ds]?|ation)|maximiz(?:e[ds]?|ation)|synchroniz(?:e[ds]?|ation)|sanitiz(?:e[ds]?|ation)|summariz(?:e[ds]?|ation)|prioritiz(?:e[ds]?|ation)|utiliz(?:e[ds]?|ation)|finaliz(?:e[ds]?|ation)|categoriz(?:e[ds]?|ation)|visualiz(?:e[ds]?|ation)|capitaliz(?:e[ds]?|ation)|emphasiz(?:e[ds]?|ation)|realiz(?:e[ds]?|ation)|gray|defense|traveled|traveling|signaled|signaling|modeling|enrollment|installments?)\b/gi;
for (const doc of documents) {
  for (const match of prose(read(doc)).matchAll(american)) check(false, `${doc} uses an American spelling in prose: ${match[0]}`);
}
checks += 1;

if (problems.length) {
  console.error(problems.join("\n"));
  assert.fail(`Documentation check found ${problems.length} problem(s)`);
}
console.log(`Documentation checks passed (${checks} checks): paths, links and commands the documents name exist, environment variables are documented and read, the contract describes every operation, parameter and schema, the shared schema's exports are documented, every document reaches the snapshot, the contract lists every route and action, every mounted API route is in the contract, and the prose is British.`);
