/**
 * What this process is running: the commit and time esbuild stamped into the
 * bundle (build.mjs), or "source" when run from the source tree, as the tests
 * do. It is on every log line and on /api/healthz, so a report can say which
 * build it is about.
 */
declare const __VALOPAY_BUILD__: string | undefined;

export const BUILD: string = typeof __VALOPAY_BUILD__ === "string" ? __VALOPAY_BUILD__ : "source";
export const STARTED_AT: string = new Date().toISOString();
