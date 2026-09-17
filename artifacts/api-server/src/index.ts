import app from "./app";
import { logger } from "./lib/logger";
import { startCloseScheduler } from "./lib/close-scheduler";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // REC-01: the daily close runs at each lender's configured time unless this process is told not to schedule it.
  if (process.env["VALOPAY_CLOSE_SCHEDULER"] === "off") {
    logger.warn("VALOPAY_CLOSE_SCHEDULER=off: daily closes must be triggered by hand from this process.");
  } else {
    startCloseScheduler({ log: logger });
  }
});
