import app from "./app";
import { logger } from "./lib/logger";
import { BUILD } from "./lib/build-info";
import { markSchedulerOff, startCloseScheduler, type CloseScheduler } from "./lib/close-scheduler";
import { closeDatabase, watchDatabase } from "./lib/valopay-store";
import { startExportWorker } from './lib/export-worker';
import { signInConfiguration } from "./lib/staff-access";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Sign-in must work where it is required: a staff host without Clerk does not start (one fatal line).
const signIn = signInConfiguration();
if (signIn.fatal) {
  logger.fatal({ event: "server.misconfigured" }, signIn.fatal);
  process.exit(1);
}
if (signIn.warning) logger.warn({ event: "sign_in.off" }, signIn.warning);

// A connection that fails while idle is a log line, not the end of the process.
watchDatabase(logger);

let scheduler: CloseScheduler | undefined;
let exportWorker: ReturnType<typeof startExportWorker> | undefined;
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ event: "server.started", port, build: BUILD, node: process.version }, "Server listening");
  exportWorker = startExportWorker({ log: logger });
  // REC-01: the daily close runs at each lender's configured time unless this process is told not to schedule it.
  if (process.env["VALOPAY_CLOSE_SCHEDULER"] === "off") {
    markSchedulerOff();
    logger.warn({ event: "scheduler.off" }, "VALOPAY_CLOSE_SCHEDULER=off: daily closes must be triggered by hand from this process.");
  } else {
    scheduler = startCloseScheduler({ log: logger });
  }
});

/**
 * A stop signal drains rather than drops: no new connections, the requests in
 * flight finish, a scheduled close pass ends after the lender close in
 * progress, then the pool ends. The lenders the pass had not reached are
 * still due and close as a catch-up after restart (NFR-AVA-02). A close that
 * will not finish in time is abandoned by the deadline; its transaction rolls
 * back with the connection and it runs again after restart the same way. An
 * export attempt in progress is cancelled and its job handed back to the
 * queue for the next worker, never failed; if that write cannot be made
 * before the deadline, the job keeps its lease and a later poll recovers it
 * when the lease expires.
 */
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ event: "server.stopping", signal }, "Shutting down: finishing requests and any close in progress; unfinished exports return to the queue");
  const deadline = setTimeout(() => { logger.error({ event: "server.stop_timeout" }, "Shutdown deadline passed; exiting"); process.exit(1); }, 10_000);
  deadline.unref();
  scheduler?.stop();
  exportWorker?.stop();
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
  await scheduler?.settle();
  // settle() waits for the hand-back writes of the cancelled exports, which need the pool: ending the
  // pool first would leave every stopped export 'interrupted', waiting up to five minutes for its lease.
  await exportWorker?.settle();
  await closeDatabase();
  logger.info({ event: "server.stopped" }, "Shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

// A failure nothing caught is written as a structured line before the process ends, not as a bare stack on stderr.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ event: "process.unhandled_rejection", err: reason instanceof Error ? reason : new Error(String(reason)) }, "Unhandled promise rejection");
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  logger.fatal({ event: "process.uncaught_exception", err: error }, "Uncaught exception");
  process.exit(1);
});
