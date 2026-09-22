import type { Request } from "express";

/** How to close the journal entry bound to a request once the request is refused, or failed having saved nothing. */
type RefusalCloser = (status: number, message: string, notSaved: boolean) => Promise<void> | undefined;
const closers = new WeakMap<Request, RefusalCloser>();

/** The recovery middleware registers, for a request it journaled, how to close
 * that entry after a definitive refusal. Kept apart from the store so the error
 * handler, which every route and offline test loads, never imports the database. */
export function registerRefusalCloser(req: Request, closer: RefusalCloser) { closers.set(req, closer); }

/** Closes the journal entry bound to this request after a refusal, or a failure
 * that saved nothing, when there is one to close; returns nothing otherwise, so
 * an ordinary refusal is answered at once. */
export function closeRefusedOperation(req: Request, status: number, message: string, notSaved = false): Promise<void> | undefined {
  return closers.get(req)?.(status, message, notSaved);
}
