import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inspectEffectBoundaries } from './check-effect-boundaries.mjs';

const fixture = mkdtempSync(join(tmpdir(), 'valopay-effect-boundary-'));
const prefix = 'artifacts/api-server/src/';
const write = (path, text) => { const full = join(fixture, prefix, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); };
const refused = (source, pattern) => { write('domain/example.ts', source); assert.match(inspectEffectBoundaries(fixture).issues.join('\n'), pattern); };
try {
  write('domain/example.ts', 'import { createHash } from "node:crypto"; export const fingerprint = createHash;');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  refused('import "node:https";', /Effect-capable/);
  refused('import client = require("pg");', /Effect-capable/);
  refused('export { request } from "undici";', /Effect-capable/);
  refused('const send = fetch; send("https://example.invalid");', /Network APIs/);
  refused('globalThis["fetch"]("https://example.invalid");', /Computed network/);
  refused('globalThis[`fetch`]("https://example.invalid");', /Computed network/);
  refused('const key = process.env.SECRET;', /ambient credentials/);
  refused('const key = process["env"]["SECRET"];', /Computed process/);
  refused('import(name);', /Dynamic imports/);
  refused('import(`pg`);', /Dynamic imports/);
  refused('const code = new Function("return 1");', /Dynamic code/);
  write('lib/helper.ts', 'import "node:fs";');
  refused('import "../lib/helper";', /Effect-capable/);
  write('lib/helper.ts', 'export const pure = 1;');
  write('domain/example.ts', 'import "../lib/helper";');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  write('providers/read-only.ts', 'export const read = 1;');
  refused('import "../providers/read-only";', /cannot depend on a provider/);
  write('domain/example.ts', 'export const pure = 1;');
  write('domain/connected-cash.ts', 'export const payroll = 1;');
  write('domain/connected-credit.ts', 'import { payroll } from "./connected-cash";');
  assert.match(inspectEffectBoundaries(fixture).issues.join('\n'), /Credit computation cannot import/);
  // Visit records through an ordinary root first, then through credit. Its
  // generic purity visit cannot waive credit's transitive workflow boundary.
  write('domain/aaa.ts', 'import "./records";');
  write('domain/records.ts', 'export { payroll } from "./connected-cash";');
  write('domain/connected-credit.ts', 'import { payroll } from "./records";');
  const transitive = inspectEffectBoundaries(fixture).issues.join('\n');
  assert.match(transitive, /records\.ts:1: Credit computation cannot import/);
  assert.match(transitive, /via .*connected-credit\.ts -> .*records\.ts/);
  write('domain/records.ts', 'export const pure = 1;');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  write('domain/connected-credit.ts', 'import type { Payroll } from "./types";');
  assert.deepEqual(inspectEffectBoundaries(fixture).issues, []);
  console.log('Effect-boundary mutation fixtures passed: direct/transitive imports, re-exports, ambient keys, dynamic code, network aliases and credit isolation.');
} finally { rmSync(fixture, { recursive: true, force: true }); }
