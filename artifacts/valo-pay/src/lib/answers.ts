import type { z, ZodError, ZodTypeAny } from "zod";

/** Shown instead of a read whose answer the page's schema does not describe. */
export const UNREADABLE_ANSWER = "The service's answer was incomplete, so this page shows nothing from it. Try again; if it happens again, the service may be changing.";
/** Shown for a write whose answer is not the confirmation its schema describes: the write may have been saved. */
export const INCOMPLETE_CONFIRMATION = "The service returned an incomplete confirmation. Check Operations before submitting again.";

/** Only fields a newer service added: every issue is an unrecognised key, in this answer or in one alternative of it. */
function onlyAdditions(error: ZodError): boolean {
  return error.issues.every((issue) => issue.code === "unrecognized_keys" || (issue.code === "invalid_union" && issue.unionErrors.some(onlyAdditions)));
}

/**
 * An answer read through the shared schema the API checked it with
 * (lib/valopay-schema). A field a newer service added is accepted, so an open
 * page keeps working across a deployment; a missing, mistyped or impossible
 * field is not: the answer is undefined, and the caller shows a problem (a
 * read) or holds the outcome as unconfirmed (a write), never the data.
 */
export function readAnswer<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  return onlyAdditions(parsed.error) ? (value as z.output<S>) : undefined;
}

/** An error the console shows in these words (saidBy reads data.error); it carries no status, so a read is not repeated and a write stays unconfirmed. */
export function answerProblem(message: string): Error {
  return Object.assign(new Error(message), { data: { error: message } });
}
