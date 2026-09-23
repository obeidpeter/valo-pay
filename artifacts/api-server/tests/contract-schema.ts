// Reads the generated contract (lib/api-spec/openapi.json) for the contract
// tests: finds the operation a request addresses and checks a JSON answer
// against the schema the contract gives it. Only the parts of JSON Schema the
// generator emits are supported; anything else fails loudly, so a check can
// never pass by ignoring a keyword it does not know.
import { readFileSync } from "node:fs";

export type JsonSchema = Record<string, any>;
export interface ContractOperation { path: string; method: string; operation: Record<string, any> }

const known = new Set(["type", "properties", "required", "additionalProperties", "items", "prefixItems", "minItems", "maxItems", "enum", "const", "$ref", "allOf", "anyOf", "oneOf", "minLength", "maxLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "format", "description", "default"]);

export function loadContract(): Record<string, any> {
  return JSON.parse(readFileSync(new URL("../../../lib/api-spec/openapi.json", import.meta.url), "utf8"));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const typeOf = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
function hasType(type: string, value: unknown): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
}

/** Every way a value departs from a contract schema, as "path: problem" lines; none when it conforms. */
export function contractErrors(spec: Record<string, any>, schema: JsonSchema | boolean | undefined, value: unknown, at = "$"): string[] {
  if (schema === undefined || schema === true) return [];
  if (schema === false) return [`${at}: no value is allowed here`];
  for (const keyword of Object.keys(schema)) if (!known.has(keyword)) throw new Error(`The contract check does not understand the keyword ${keyword} at ${at}.`);
  if (schema.$ref) {
    const name = String(schema.$ref).replace("#/components/schemas/", "");
    const target = spec.components.schemas[name];
    if (!target) return [`${at}: the contract names a missing component ${name}`];
    return contractErrors(spec, target, value, at);
  }
  const out: string[] = [];
  for (const part of schema.allOf ?? []) out.push(...contractErrors(spec, part, value, at));
  if (schema.anyOf && !schema.anyOf.some((part: JsonSchema) => !contractErrors(spec, part, value, at).length)) out.push(`${at}: matches none of its alternatives`);
  if (schema.oneOf && schema.oneOf.filter((part: JsonSchema) => !contractErrors(spec, part, value, at).length).length !== 1) out.push(`${at}: matches not exactly one of its alternatives`);
  if ("const" in schema && !same(schema.const, value)) out.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item: unknown) => same(item, value))) out.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => hasType(type, value))) return [...out, `${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) out.push(`${at}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) out.push(`${at}: not above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) out.push(`${at}: not below ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    value.forEach((item, index) => {
      const itemSchema = schema.prefixItems?.[index] ?? schema.items;
      out.push(...contractErrors(spec, itemSchema, item, `${at}[${index}]`));
    });
  }
  if (typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) out.push(`${at}.${key}: required but missing`);
    for (const [key, item] of Object.entries(record)) {
      if (schema.properties && key in schema.properties) out.push(...contractErrors(spec, schema.properties[key], item, `${at}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${key}: not in the contract`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.push(...contractErrors(spec, schema.additionalProperties, item, `${at}.${key}`));
    }
  }
  return out;
}

/** Every operation in the contract with its path template and upper-case method. */
export function contractOperations(spec: Record<string, any>): ContractOperation[] {
  return Object.entries(spec.paths as Record<string, Record<string, any>>).flatMap(([path, methods]) => Object.entries(methods).map(([method, operation]) => ({ path, method: method.toUpperCase(), operation })));
}

/** The operation a concrete request addresses (a literal segment beats a path parameter), or undefined. */
export function operationFor(spec: Record<string, any>, method: string, url: string): ContractOperation | undefined {
  const path = url.split("?")[0]!.replace(/^\/api(?=\/)/, "");
  const segments = path.split("/");
  const candidates = contractOperations(spec).filter((entry) => {
    const template = entry.path.split("/");
    return entry.method === method.toUpperCase() && template.length === segments.length && template.every((part, index) => /^\{\w+\}$/.test(part) || part === segments[index]);
  });
  return candidates.sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0))[0];
}

/** The problems with an answer to a request: an undocumented status, or a body the contract does not describe. */
export function answerErrors(spec: Record<string, any>, method: string, url: string, status: number, body: unknown): string[] {
  const entry = operationFor(spec, method, url);
  if (!entry) return [`${method} ${url}: no operation in the contract`];
  const response = entry.operation.responses?.[String(status)];
  if (!response) return [`${method} ${entry.path}: answered ${status}, which the contract does not list (${Object.keys(entry.operation.responses ?? {}).join(", ")})`];
  const schema = response.content?.["application/json"]?.schema;
  if (!schema) return [];
  return contractErrors(spec, schema, body).map((problem) => `${method} ${entry.path} ${status}: ${problem}`);
}
