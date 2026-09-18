import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

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
const GENERAL_FAILURE = "The operation could not be completed. No partial change has been committed.";

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Validation failed.", details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })) });
    return;
  }
  if (!(error instanceof Error) || programmingErrors.some((kind) => error instanceof kind)) {
    req.log.error({ name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) }, "Valopay operation failed");
    res.status(500).json({ error: GENERAL_FAILURE });
    return;
  }
  const failure = error as Error & { code?: string; status?: number };
  if (failure.code && databaseCodes.includes(failure.code)) {
    req.log.warn({ code: failure.code }, "Database safety constraint rejected operation");
    res.status(409).json({ error: "Operation conflicts with an existing record, immutable evidence or allocation limit." });
    return;
  }
  if (failure.code || (failure.status ?? 0) >= 500) {
    req.log.error({ code: failure.code, name: failure.name }, "Valopay operation failed");
    res.status(500).json({ error: GENERAL_FAILURE });
    return;
  }
  const status = failure.status || (/not permitted|requires.*role|only.*admin|read-only|disabled|gate|instruction mode/i.test(failure.message) ? 403 : 400);
  res.status(status).json({ error: failure.message || "The operation was rejected." });
};
