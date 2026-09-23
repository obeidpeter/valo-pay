/**
 * The server's checked settings. index.ts imports this module first, so the
 * check runs, and a bad value ends the process with its one fatal line,
 * before the logger, the database pool or anything else that reads a setting
 * has loaded (startup-config.ts).
 */
import { startupConfigOrExit } from "./startup-config";

export const serverSettings = startupConfigOrExit("server");
