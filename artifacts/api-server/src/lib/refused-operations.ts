import type { Request } from "express";

/** How to close the journal entry bound to a request once the request is refused, or failed having saved nothing.
 * It resolves to whether the entry is cancelled after it ran; nothing is returned when there is no entry to close. */
type RefusalCloser = (status: number, message: string, notSaved: boolean) => Promise<boolean> | undefined;
const closers = new WeakMap<Request, RefusalCloser>();

/** The recovery middleware registers, for a request it journaled, how to close
 * that entry after a definitive refusal. Kept apart from the store so the error
 * handler, which every route and offline test loads, never imports the database. */
export function registerRefusalCloser(req: Request, closer: RefusalCloser) { closers.set(req, closer); }

/** Closes the journal entry bound to this request after a refusal, or a failure
 * that saved nothing, when there is one to close, and resolves to whether the
 * entry is cancelled afterwards; returns nothing otherwise, so an ordinary
 * refusal is answered at once. */
export function closeRefusedOperation(req: Request, status: number, message: string, notSaved = false): Promise<boolean> | undefined {
  return closers.get(req)?.(status, message, notSaved);
}

const closedRefusals = new WeakSet<object>();
/** Records that this refusal is of a request key whose journal entry is
 * already cancelled: no request with this key completed or can complete.
 * Returns the error. */
export function markOperationClosed<T>(error: T): T {
  if (error !== null && typeof error === "object") closedRefusals.add(error);
  return error;
}
/** Whether this refusal is of a request key whose journal entry is already
 * cancelled: no request with this key completed or can complete. */
export function operationClosed(error: unknown): boolean {
  return error !== null && typeof error === "object" && closedRefusals.has(error);
}
