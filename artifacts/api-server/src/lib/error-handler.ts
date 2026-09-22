import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { PilotAccessError } from './pilot-access';
import { closeRefusedOperation } from './refused-operations';
import { wasRolledBack } from './transaction-outcome';
import { DatabaseLimitError } from './database-limits';

/**
 * One place that turns a thrown error into an HTTP answer.
 *
 * Validation failures name their fields, and a body the parser could not read
 * is the request's fault, not the code's. Database safety constraints are a
 * conflict; text PostgreSQL cannot store is a 400. An error the application
 * raised is answered in its own words with the status it carries: a refusal
 * without one is a 400, whatever its wording, and a service the application
 * found unavailable keeps its 502, 503 or 504. A programming error (a
 * TypeError, a ReferenceError and their kin) or anything that is not an Error
 * at all is answered as a 500 in general words: its message describes the
 * code, not the request, and belongs in the log, not in the response
 * (security review).
 *
 * When the store rolled back the request's transaction before committing, a
 * 5xx answer says `committed: false`: nothing was saved, so the console need
 * not hold the request as unconfirmed.
 *
 * A request the store turned away at a database limit (a busy lender, a lock
 * or statement past its limit, an idle or lost connection, no free connection)
 * is a 503 with Retry-After in plain words. A raw PostgreSQL code is never
 * guessed at here: the store translates it where it knows whether COMMIT was
 * sent.
 *
 * Before a definitive refusal, or any answer for a request that saved
 * nothing, is sent, the request's operations-journal entry (when the recovery
 * middleware bound one) is closed, so it never lingers as pending. The
 * middleware registers how; this module never imports the store or the
 * database, so the offline suites can load it.
 */
const programmingErrors = [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError];
const databaseCodes = ["23503", "23505", "23514", "P0001"];
/** PostgreSQL could not store a character: a NUL in text (22021) or in a JSON string (22P05). */
const characterCodes = ["22021", "22P05"];
const GENERAL_FAILURE = "We could not confirm this action. Check Operations or retry the same request before submitting a new one.";
const NOT_SAVED = "This action failed and nothing was saved. Try again, and quote this reference if it happens again.";
/** The body parser's refusals, in the words a person needs. */
const bodyRefusals: Record<string, { status: number; error: string }> = {
  "entity.parse.failed": { status: 400, error: "The request body is not valid JSON. Check its format and try again." },
  "entity.too.large": { status: 413, error: "The request body is too large. Send a smaller request." },
  "encoding.unsupported": { status: 415, error: "The request body's encoding is not supported. Send UTF-8 JSON." },
  "charset.unsupported": { status: 415, error: "The request body's character set is not supported. Send UTF-8 JSON." },
  "request.aborted": { status: 400, error: "The request was cancelled before its body arrived." },
};
type Answer = { status: number; headers?: Record<string, string>; body: Record<string, unknown> & { error: string } };
type Raised = Error & { code?: unknown; status?: unknown; expose?: unknown; type?: unknown };

/** A body-parser error: a client error the parser marks safe to expose, with its type. */
function bodyRefusal(error: unknown): { status: number; error: string; type: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const raised = error as Raised, status = Number(raised.status);
  if (typeof raised.type !== "string" || raised.expose !== true || !(status >= 400 && status < 500)) return undefined;
  return { ...(bodyRefusals[raised.type] ?? { status, error: "The request body could not be read." }), type: raised.type };
}

function describe(error: unknown, req: Parameters<ErrorRequestHandler>[1]): Answer {
  const requestId = req.id;
  if (error instanceof PilotAccessError) return { status: error.status, body: { error: error.message, code: error.code, requestId } };
  if (error instanceof ZodError) {
    req.log.info({ event: "request.rejected", status: 400, issues: error.issues.length }, "Validation failed");
    return { status: 400, body: { error: "Validation failed.", details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })), requestId } };
  }
  // Checked before programming errors: the parser's JSON failure is a SyntaxError about the request.
  const unreadable = bodyRefusal(error);
  if (unreadable) {
    req.log.info({ event: "request.rejected", status: unreadable.status, reason: unreadable.type }, "Request body refused");
    return { status: unreadable.status, body: { error: unreadable.error, requestId } };
  }
  const notSaved = wasRolledBack(error);
  if (error instanceof DatabaseLimitError) {
    // A busy lender or a lock wait is load, not a fault: a warning. A stopped statement, a lost connection or a full pool is an error.
    const level = ["lender_busy", "lock_timeout", "lock_conflict"].includes(error.limit) ? "warn" : "error";
    req.log[level]({ event: "request.busy", status: 503, limit: error.limit, reason: error.message, ...(error.cause === undefined ? {} : { err: error.cause }) }, "Request turned away: a database limit was reached");
    return { status: 503, headers: { "Retry-After": String(error.retryAfterSeconds) }, body: { error: error.message, ...(notSaved ? { committed: false } : {}), requestId } };
  }
  const general = (): Answer => ({ status: 500, body: notSaved ? { error: NOT_SAVED, committed: false, requestId } : { error: GENERAL_FAILURE, requestId } });
  // A failure is logged with its stack, which is what locates it; the answer stays general.
  if (!(error instanceof Error) || programmingErrors.some((kind) => error instanceof kind)) {
    req.log.error({ event: "request.failed", err: error instanceof Error ? error : new Error(String(error)) }, "Valopay operation failed");
    return general();
  }
  const failure = error as Raised;
  const code = typeof failure.code === "string" ? failure.code : undefined;
  if (code && databaseCodes.includes(code)) {
    req.log.warn({ event: "request.rejected", status: 409, code }, "Database safety constraint rejected operation");
    return { status: 409, body: { error: "This change conflicts with an existing record, protected evidence or an allocation limit. Refresh the record and check the details before trying again.", requestId } };
  }
  if (code && characterCodes.includes(code)) {
    req.log.info({ event: "request.rejected", status: 400, code }, "Text PostgreSQL cannot store was refused");
    return { status: 400, body: { error: "Text cannot contain the NUL character (\\u0000). Remove it and try again.", requestId } };
  }
  const status = Number(failure.status) || 0;
  // A service the application found unavailable, or a check it failed on purpose, keeps its status and words.
  if (failure.code === undefined && ((status >= 502 && status <= 504) || (status >= 500 && status <= 599 && failure.expose === true))) {
    req.log.error({ event: "request.unavailable", status, reason: failure.message, err: failure }, "Request refused: a service is unavailable or a check failed");
    return { status, body: { error: failure.message, ...(notSaved ? { committed: false } : {}), requestId } };
  }
  if (failure.code !== undefined || status >= 500) {
    req.log.error({ event: "request.failed", code: failure.code, err: failure }, "Valopay operation failed");
    return general();
  }
  // An upstream status (storage, identity) with none of our own is never the request's fault.
  if (!status && Number((failure as { statusCode?: unknown }).statusCode) >= 400) {
    req.log.error({ event: "request.failed", upstreamStatus: Number((failure as { statusCode?: unknown }).statusCode), err: failure }, "A service this request depends on failed");
    return { status: 502, body: { error: "A service this request depends on did not respond as expected. Try again shortly.", ...(notSaved ? { committed: false } : {}), requestId } };
  }
  // A refusal without a status is a 400: its wording is never read to choose one.
  const answered = status >= 400 && status < 500 ? status : 400;
  // A rejection is the rule doing its job: one info line with the reason, for the question "why was this refused?".
  req.log.info({ event: "request.rejected", status: answered, reason: failure.message }, "Request rejected");
  return { status: answered, body: { error: failure.message || "The operation was rejected.", requestId } };
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;
  // Every error body carries the request id, so the reference a person quotes finds the request's log lines.
  const answer = describe(error, req);
  const send = () => {
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(answer.headers ?? {})) res.setHeader(name, value);
    res.status(answer.status).json(answer.body);
  };
  // A refusal with a journal entry waits for the entry to close; every other refusal is answered at once.
  const closing = closeRefusedOperation(req, answer.status, answer.body.error, answer.body.committed === false);
  if (closing) void closing.then(send, send); else send();
};
