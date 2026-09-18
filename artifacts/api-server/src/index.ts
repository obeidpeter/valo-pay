import app from "./app";
import { logger } from "./lib/logger";
import { BUILD } from "./lib/build-info";
import { markSchedulerOff, startCloseScheduler, type CloseScheduler } from "./lib/close-scheduler";
import { closeDatabase, watchDatabase } from "./lib/valopay-store";
import { startExportWorker } from './lib/export-worker';

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
 * flight finish, a close pass in progress completes, then the pool ends. A
 * pass that will not finish in time is abandoned by the deadline; its
 * transaction rolls back with the connection and the close runs again as a
 * catch-up after restart (NFR-AVA-02).
 */
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ event: "server.stopping", signal }, "Shutting down: finishing requests and any close in progress");
  const deadline = setTimeout(() => { logger.error({ event: "server.stop_timeout" }, "Shutdown deadline passed; exiting"); process.exit(1); }, 10_000);
  deadline.unref();
  scheduler?.stop();
  exportWorker?.stop();
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });
  await scheduler?.settle();
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
