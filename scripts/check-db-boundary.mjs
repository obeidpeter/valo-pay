// A maintainability guard, not a sandbox against malicious code execution.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const repository = "artifacts/api-server/src/lib/valopay-store.ts";
// Durable export claims and completion use explicit lender-scoped worker transactions.
const exportRepository = "artifacts/api-server/src/lib/export-job-store.ts";
// Opt-in restricted runtime transactions verify and bind the forced-RLS scope.
const isolatedRuntime = "artifacts/api-server/src/lib/runtime-isolation.ts";
// The startup check reads DATABASE_URL only to refuse a missing or malformed value before anything starts;
// like every other module, it may not import the database or query it.
const startupCheck = "artifacts/api-server/src/lib/startup-config.ts";
const violations = [];
let checked = 0;
const databaseImport = /(?:^@workspace\/db(?:\/|$)|^(?:pg|postgres|postgresql|drizzle-orm)(?:\/|$)|(?:^|\/)lib\/db(?:\/|$))/;
const connectionKey = /^(?:DATABASE_URL|PGHOST|PGUSER|PGPASSWORD|PGDATABASE|PGPORT)$/;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.filter(e => !["node_modules", "dist", ".git"].includes(e.name)).map(async entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  }));
  return files.flat();
}

for (const file of [...await walk(path.join(root, "artifacts")), ...await walk(path.join(root, "lib"))]) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  if (!relative.includes("/src/") || !/\.[cm]?[jt]sx?$/.test(relative) || relative.startsWith("lib/db/")) continue;
  const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
  checked++;
  const allowed = relative === repository || relative === exportRepository || relative === isolatedRuntime;
  function reject(node, message) {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push(`${relative}:${line + 1}: ${message}`);
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (databaseImport.test(node.moduleSpecifier.text) && !allowed) reject(node, "Database imports belong only in the scoped repository.");
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression;
      if (specifier && ts.isStringLiteralLike(specifier) && databaseImport.test(specifier.text) && !allowed) reject(node, "Database import-equals declarations belong only in the scoped repository.");
    }
    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if ((target.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(target) && target.text === "require"))
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
        && databaseImport.test(node.arguments[0].text) && !allowed) {
        reject(node, "Dynamic database imports bypass the scoped repository.");
      }
      const member = ts.isPropertyAccessExpression(target) ? target.name.text
        : ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression) ? target.argumentExpression.text : "";
      if (member === "query" && !allowed) reject(node, "Raw query calls belong only in the scoped repository.");
    }
    const namesConnection = allowed || relative === startupCheck;
    if (!namesConnection && ts.isPropertyAccessExpression(node) && connectionKey.test(node.name.text)) reject(node, "Database connection settings belong only in the repository.");
    if (!namesConnection && ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      && connectionKey.test(node.argumentExpression.text)) reject(node, "Database connection settings belong only in the repository.");
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert.equal(violations.length, 0, `Database boundary violations:\n${violations.join("\n")}`);
console.log(`Database boundary passed across ${checked} runtime source files.`);
