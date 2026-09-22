import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { PilotAccessError } from './pilot-access';

/**
 * One place that turns a thrown error into an HTTP answer.
 *
 * Validation failures name their fields. Database safety constraints are a
 * conflict. An error the application raised with a status, or a plain Error
 * from the domain rules, is answered in its own words with the status it
 * carries or the one its wording implies. A programming error (a TypeError,
 * a ReferenceError and their kin) or anything that is not an Error at all is
 * answered as a 500 in general words: its message describes the code, not the
 * request, and belongs in the log, not in the response (security review).
 */
const programmingErrors = [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError];
const databaseCodes = ["23503", "23505", "23514", "P0001"];
const GENERAL_FAILURE = "We could not confirm this action. Check Operations or retry the same request before submitting a new one.";

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof PilotAccessError) { res.status(error.status).json({ error: error.message, code: error.code, requestId: req.id }); return; }
  // Every error body carries the request id, so the reference a person quotes finds the request's log lines.
  const requestId = req.id;
  if (error instanceof ZodError) {
    req.log.info({ event: "request.rejected", status: 400, issues: error.issues.length }, "Validation failed");
    res.status(400).json({ error: "Validation failed.", details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })), requestId });
    return;
  }
  // A failure is logged with its stack, which is what locates it; the answer stays general.
  if (!(error instanceof Error) || programmingErrors.some((kind) => error instanceof kind)) {
    req.log.error({ event: "request.failed", err: error instanceof Error ? error : new Error(String(error)) }, "Valopay operation failed");
    res.status(500).json({ error: GENERAL_FAILURE, requestId });
    return;
  }
  const failure = error as Error & { code?: string; status?: number };
  if (failure.code && databaseCodes.includes(failure.code)) {
    req.log.warn({ event: "request.rejected", status: 409, code: failure.code }, "Database safety constraint rejected operation");
    res.status(409).json({ error: "This change conflicts with an existing record, protected evidence or an allocation limit. Refresh the record and check the details before trying again.", requestId });
    return;
  }
  if (failure.code || (failure.status ?? 0) >= 500) {
    req.log.error({ event: "request.failed", code: failure.code, err: failure }, "Valopay operation failed");
    res.status(500).json({ error: GENERAL_FAILURE, requestId });
    return;
  }
  const status = failure.status || (/not permitted|requires.*role|only.*admin|read-only|disabled|gate|instruction mode/i.test(failure.message) ? 403 : 400);
  // A rejection is the rule doing its job: one info line with the reason, for the question "why was this refused?".
  req.log.info({ event: "request.rejected", status, reason: failure.message }, "Request rejected");
  res.status(status).json({ error: failure.message || "The operation was rejected.", requestId });
};
