/**
 * The one-shot close pass's checked settings. close-pass.ts imports this
 * module first, for the same reason server-settings.ts is imported first.
 */
import { startupConfigOrExit } from "./startup-config";

export const closePassSettings = startupConfigOrExit("close-pass");
