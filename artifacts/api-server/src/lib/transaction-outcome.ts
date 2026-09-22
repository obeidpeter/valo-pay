/**
 * Errors thrown inside a workspace transaction that was rolled back before its
 * COMMIT was sent: nothing the request did was saved. The error handler can
 * then say so, the operations journal can close the entry, and the console
 * need not hold the request as unconfirmed. An error from the COMMIT itself is
 * never marked, because the server may have committed before the connection
 * failed. Kept apart from the store so the error handler never imports the
 * database.
 */
const rolledBack = new WeakSet<object>();

/** Records that the transaction this error ended was rolled back; returns the error. */
export function markRolledBack<T>(error: T): T {
  if (error !== null && typeof error === "object") rolledBack.add(error);
  return error;
}

/** Whether nothing the failed request did was saved. */
export function wasRolledBack(error: unknown): boolean {
  return error !== null && typeof error === "object" && rolledBack.has(error);
}
