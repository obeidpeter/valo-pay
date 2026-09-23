/**
 * Every API router matches the path after `/api` strictly and in its case: a
 * trailing slash or another spelling of a literal segment is another path,
 * which no route answers (404). The operations journal matches that path the
 * same way (recoverableRequest, lib/operation-recovery.ts), so a keyed write
 * reaches a journaled route only journaled.
 */
export const routerOptions = { strict: true, caseSensitive: true } as const;
