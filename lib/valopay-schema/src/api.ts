import { z } from "zod";

/**
 * Building blocks the API and the console share for requests and answers: the
 * date-time a caller sends, the lender query value, the Idempotency-Key header,
 * the error body, and the stored record, lender and assignee shapes that many
 * answers carry. The contract (scripts/create-valopay-spec.cjs) is generated
 * from these, so the routes, the console and the contract read one definition.
 */

/**
 * An RFC 3339 date and time a caller sends: Z or an offset such as +01:00,
 * with any fraction of a second. It becomes the UTC instant the service stores
 * and compares (milliseconds and Z, as every stored timestamp is written), so
 * a version sent with an offset matches the stored version it names.
 */
export const instantInputSchema = z
  .string()
  .datetime({ offset: true, message: "Use a date and time such as 2026-09-18T07:00:00Z or 2026-09-18T08:00:00+01:00." })
  .transform((value, context) => {
    const instant = new Date(value);
    const utc = Number.isFinite(instant.getTime()) ? instant.toISOString() : "";
    if (!/^\d{4}-/.test(utc)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Use a date and time between the years 0000 and 9999." });
      return z.NEVER;
    }
    return utc;
  })
  .describe("An RFC 3339 date and time with Z or an offset, such as 2026-09-18T08:00:00+01:00. The service stores and compares the UTC instant.");

const utcInstant = z.string().datetime();
/**
 * A timestamp read back from storage in the form every answer gives it. One
 * already in UTC is returned exactly as stored, since stored values are also
 * compared word for word. One with an offset (as data written by an earlier
 * build may hold it) names the same instant, so it becomes that UTC instant,
 * as instantInputSchema makes an input. Anything else is returned unchanged,
 * so the answer's own check refuses it as the fault it is.
 */
export function storedInstant(value: unknown): unknown {
  if (utcInstant.safeParse(value).success) return value;
  const parsed = instantInputSchema.safeParse(value);
  return parsed.success ? parsed.data : value;
}

/** The lender a request is scoped to, as its merchantId query value. */
export const merchantIdSchema = z
  .string({ required_error: "Choose a lender: merchantId is required.", invalid_type_error: "Send merchantId once, as text." })
  .min(1, "Choose a lender: merchantId is required.")
  .max(100, "A merchantId is at most 100 characters.");
/** The query of a lender-scoped request: every route reads it first, so a missing merchantId is the same 400 everywhere. */
export const lenderQuerySchema = z.object({ merchantId: merchantIdSchema });
/** A lender-scoped page of 25 rows: merchantId and the rows to skip. */
export const lenderPageQuerySchema = lenderQuerySchema.extend({ offset: z.coerce.number().int().min(0).max(100000).default(0) });

/** The header that makes a write repeatable and recoverable. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
/** One key per unchanged intention: 8 to 200 characters. */
export const idempotencyKeySchema = z
  .string({ required_error: "Send an Idempotency-Key header: one key of 8 to 200 characters for each unchanged request.", invalid_type_error: "Send one Idempotency-Key header." })
  .min(8, "An Idempotency-Key is 8 to 200 characters.")
  .max(200, "An Idempotency-Key is 8 to 200 characters.");
/** The header parsed under its own name, so a refusal names the header. */
export const idempotencyKeyHeaderSchema = z.object({ [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema });

/** The staff-access refusals a code names (PilotAccessError). */
export const pilotAccessFailureCodes = ["pilot_disabled", "configuration_invalid", "authentication_required", "session_invalid", "membership_required", "membership_inactive", "role_not_permitted", "mfa_required", "reverification_required"] as const;
/** A staff-access refusal's code. */
export type PilotAccessFailureCode = (typeof pilotAccessFailureCodes)[number];

/** One field a request got wrong, as a validation refusal names it. */
export const errorDetailSchema = z.object({
  field: z.string().describe("The field, query value or header, as a dotted path; empty for the body as a whole."),
  message: z.string(),
}).strict();
/** The body of every refusal and failure the service answers (lib/error-handler.ts and the app's own refusals). */
export const errorBodySchema = z.object({
  error: z.string().describe("What happened, in plain words: a refusal in its rule's own wording, a failure in general words."),
  requestId: z.string().describe("The request's reference, also sent as X-Request-Id; quoting it finds the request in the log."),
  details: z.array(errorDetailSchema).optional().describe("Present when validation failed: each field and what is wrong with it."),
  code: z.enum(pilotAccessFailureCodes).optional().describe("Present when staff access was refused: why."),
  committed: z.literal(false).optional().describe("Present on a failure that saved nothing: the transaction was rolled back, so the request may be sent again as new. A read's 500 never carries it, nor does the repeat of a request that was saved."),
  operation: z.literal("cancelled").optional().describe("Present when the request's operations-journal entry is cancelled: nothing sent with its Idempotency-Key was or can be saved."),
}).strict();
/** A refusal or failure as the service answers it. */
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** A record's data: the fields its kind declares and anything else a caller stored. */
export const recordDataSchema = z.record(z.unknown());
/** A stored record of any kind, exactly as an answer carries it. */
export const valopayRecordSchema = z.object({
  id: z.string(), merchantId: z.string(), kind: z.string(), name: z.string(), status: z.string(), reference: z.string(),
  amountKobo: z.number().int(), customerId: z.string(), createdAt: z.string(), updatedAt: z.string(), data: recordDataSchema,
}).strict();
/** A stored record as an answer carries it. */
export type ValopayRecordView = z.infer<typeof valopayRecordSchema>;
/** A lender (a merchant in the API): its mode, provider, volume, emergency stop and readiness flags. */
export const merchantSchema = z.object({
  id: z.string(), name: z.string(), shortName: z.string(), segment: z.string(), mode: z.string(), status: z.string(), provider: z.string(),
  monthlyVolume: z.number().int(), killSwitch: z.boolean(), preDataReady: z.boolean(), preLiveReady: z.boolean(),
}).strict();
/** A lender as an answer carries it. */
export type MerchantView = z.infer<typeof merchantSchema>;
/** A confirmation in plain words, when nothing else changed that the caller needs to read back. */
export const messageSchema = z.object({ message: z.string() }).strict();
/** A person who can own a case or review a close: a demo role in the sandbox, an active staff member with lender access on a staff host. */
export const assigneeSchema = z.object({ actor: z.string(), name: z.string(), role: z.string() }).strict();
/** A possible case owner or reviewer. */
export type Assignee = z.infer<typeof assigneeSchema>;
