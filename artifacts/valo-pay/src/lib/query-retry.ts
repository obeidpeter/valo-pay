/** Reads are repeated at most this many times, with TanStack Query's growing delay (1 s, then 2 s). */
export const QUERY_RETRIES = 2;

/**
 * Whether a failed read is worth repeating: only when no answer arrived (a
 * network failure or a timeout) or the service failed or timed out (5xx, 408).
 * A refusal (400, 401, 403, 404, 409, 410 ...) answers the same way again, and
 * a 429 asks for a minute's wait, so they show at once. An answer that arrived
 * but could not be read or checked is not repeated either.
 */
export function retryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_RETRIES) return false;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status >= 500 || status === 408;
  return error instanceof TypeError
    || (typeof DOMException !== 'undefined' && error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'NetworkError'));
}
