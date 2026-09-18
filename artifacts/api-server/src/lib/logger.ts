import { hostname } from "node:os";
import pino from "pino";
import { BUILD } from "./build-info";

/**
 * The process's one logger. Lines are JSON on stdout for the host to collect;
 * a developer gets them pretty-printed (NODE_ENV=development, or LOG_FORMAT=pretty
 * anywhere); LOG_FILE writes them synchronously to a file instead, so a test or a
 * local run can read them back. LOG_LEVEL sets the level. Every line names the
 * service and the build. Cookies and authorisation headers are never written.
 */
const pretty = process.env.LOG_FORMAT === "pretty" || (process.env.LOG_FORMAT === undefined && process.env.NODE_ENV === "development");

const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  base: { pid: process.pid, hostname: hostname(), service: "valopay-api", build: BUILD },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
};

export const logger = process.env.LOG_FILE
  ? pino(options, pino.destination({ dest: process.env.LOG_FILE, sync: true, mkdir: true }))
  : pino(pretty ? { ...options, transport: { target: "pino-pretty", options: { colorize: true } } } : options);
