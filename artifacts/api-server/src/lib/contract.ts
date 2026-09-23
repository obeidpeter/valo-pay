import type { Request } from "express";
import type { z, ZodError } from "zod";
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeyHeaderSchema, lenderPageQuerySchema, lenderQuerySchema } from "@workspace/valopay-schema";

/**
 * The request and answer rules every route shares, as the contract
 * (lib/api-spec/openapi.json) states them. It imports neither the store nor
 * the database, so the error handler and the offline suites can load it.
 */

/**
 * An answer that does not match the schema its contract gives it: a fault in
 * the service, never in the request. The error handler answers it as a 500 in
 * general words (saying nothing was saved when the transaction was rolled
 * back, as it is when the answer is checked before COMMIT) and logs the paths
 * that failed, never their values.
 */
export class ResponseContractError extends Error {
  readonly issues: ReadonlyArray<{ path: string; code: string }>;
  constructor(error: ZodError) {
    super("An answer did not match its contract.");
    this.name = "ResponseContractError";
    this.issues = error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
  }
}

/** The answer as its schema parses it, or a ResponseContractError. Check it before COMMIT, so an invalid answer saves nothing. */
export function contractAnswer<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ResponseContractError(parsed.error);
  return parsed.data;
}

/** The lender a request is scoped to. Every lender-scoped route reads it first, so a missing merchantId is the same 400, naming the field, everywhere. */
export function lenderQuery(req: Request): z.output<typeof lenderQuerySchema> {
  return lenderQuerySchema.parse(req.query);
}
/** The lender and the rows to skip, for the routes that page by 25. */
export function lenderPage(req: Request): z.output<typeof lenderPageQuerySchema> {
  return lenderPageQuerySchema.parse(req.query);
}

/** The Idempotency-Key a write must carry, refused by name (400) when it is missing or is not 8 to 200 characters. */
export function requiredKey(req: Request): string {
  return idempotencyKeyHeaderSchema.parse({ [IDEMPOTENCY_KEY_HEADER]: req.header(IDEMPOTENCY_KEY_HEADER) })[IDEMPOTENCY_KEY_HEADER];
}
/** The Idempotency-Key of a write that may carry one: undefined when absent or empty, refused by name when it is not 8 to 200 characters. */
export function optionalKey(req: Request): string | undefined {
  return req.header(IDEMPOTENCY_KEY_HEADER) ? requiredKey(req) : undefined;
}
