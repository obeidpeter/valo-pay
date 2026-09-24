/**
 * The background worker thread: the scheduled daily close and the export
 * worker, off the event loop that answers requests and health probes, so a
 * month-end close or a large export never holds them up. The main thread
 * starts it, starts it again after a crash and stops it on shutdown
 * (lib/background-worker.ts). It has its own database pool, which the main
 * thread sizes (BACKGROUND_POOL_SIZE), and it keeps to the same repository
 * modules and limits as before; its log lines go through the main thread
 * (lib/logger.ts), and it posts each change of the scheduler's state there,
 * where /api/healthz and the console read it. A stop ends a close pass after
 * the lender close in progress and hands every unfinished export back to the
 * queue, then ends the pool, and with it the thread.
 */
import { parentPort, workerData } from "node:worker_threads";
import { logger } from "./lib/logger";
import { observeScheduler, startCloseScheduler } from "./lib/close-scheduler";
import { startExportWorker } from "./lib/export-worker";
import { closeDatabase, watchDatabase } from "./lib/valopay-store";
import type { BackgroundMessage, BackgroundOptions } from "./lib/background-worker";

if (!parentPort) throw new Error("background.ts runs as the API's worker thread (lib/background-worker.ts), not on its own.");
const port = parentPort, options = workerData as BackgroundOptions;
const post = (message: BackgroundMessage) => port.postMessage(message);

// As on the main thread: an idle connection that fails is a log line, not the end of the thread.
watchDatabase(logger);
if (options.closes) observeScheduler((event) => post({ type: "scheduler", event }));
const scheduler = options.closes ? startCloseScheduler({ ...options.closes, log: logger }) : undefined;
const exportWorker = options.exports ? startExportWorker({ ...options.exports, log: logger }) : undefined;

let stopping: Promise<void> | undefined;
async function stop(): Promise<void> {
  try {
    scheduler?.stop();
    exportWorker?.stop();
    // The close in progress finishes and the stopped exports' hand-back writes are made before the pool ends.
    await Promise.all([scheduler?.settle(), exportWorker?.settle()]);
    await closeDatabase();
  } finally {
    // Nothing else holds the thread open, so it ends here.
    port.close();
  }
}
port.on("message", (message: { type?: unknown }) => {
  if (message?.type === "stop") stopping ??= stop();
});
