import type { IncomingHttpHeaders } from "node:http";
import type { Request } from "express";
import { getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  authorizePilotAccess,
  type VerifiedClerkSession,
  type ProvisionedMembership,
  type PilotAccessPolicy,
} from "./pilot-access";

export function staffMode(): boolean {
  const mode = process.env.VALOPAY_STAFF_ACCESS;
  if (mode && mode !== "off" && mode !== "staging")
    throw Object.assign(new Error("Staff access configuration is invalid."), {
      status: 503,
    });
  return mode === "staging";
}
export function staffPolicy(write = false): PilotAccessPolicy {
  return {
    enabled: staffMode(),
    environment: "staging",
    issuer: process.env.VALOPAY_STAFF_ISSUER || "",
    authorisedParties: (process.env.VALOPAY_STAFF_ORIGINS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    maxFactorAgeMinutes: write ? 10 : 720,
    maxSensitiveFactorAgeMinutes: 10,
  };
}
export function verifyStaff(
  auth: VerifiedClerkSession,
  membership: ProvisionedMembership,
  write: boolean,
  now: string,
) {
  // Domain services enforce the specific operation's role. This check requires
  // fresh MFA for every write, including actions pilot-access.ts does not list.
  return authorizePilotAccess(
    auth,
    membership,
    { tenantId: membership.tenantId, action: "read" },
    staffPolicy(write),
    Date.parse(now),
  );
}

/** Clerk is configured on this host: its secret key is set. */
export function clerkConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY);
}
const httpsOrigin = (value: string) => {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; } catch { return false; }
};
/**
 * The HTTPS origins this deployment's console is served at, outside staff
 * mode: VALOPAY_APP_ORIGINS, comma-separated, or, when that is unset, https://
 * and each host Replit lists in REPLIT_DOMAINS. A listed value that is not an
 * HTTPS origin (such as https://valopay.example) is a configuration error.
 */
export function appOrigins(): string[] {
  const listed = (process.env.VALOPAY_APP_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (listed.length) {
    if (!listed.every(httpsOrigin)) throw Object.assign(new Error("Application origin configuration is invalid."), { status: 503 });
    return listed;
  }
  return (process.env.REPLIT_DOMAINS || "").split(",").map((host) => `https://${host.trim().toLowerCase()}`).filter(httpsOrigin);
}
/**
 * The origins Clerk sessions are accepted from (its authorizedParties), which
 * the Clerk proxy names itself by and publishable keys are derived for: the
 * staff policy's in staff mode (VALOPAY_STAFF_ORIGINS), otherwise appOrigins().
 */
export function signInOrigins(): string[] {
  return staffMode() ? [...staffPolicy().authorisedParties] : appOrigins();
}
/**
 * Whether this host checks Clerk sessions: Clerk is configured and, outside
 * staff mode, so is an origin to accept them from. Otherwise every request is
 * anonymous; a staff host, which refuses anonymous requests, does not start
 * without Clerk (signInConfiguration).
 */
export function signInEnabled(): boolean {
  return clerkConfigured() && (staffMode() || appOrigins().length > 0);
}
const clerkAuth = Symbol.for("@clerk/express.auth");
/** The signed-in Clerk user of a request, or null: always null when Clerk's middleware did not run on it, as on a host with sign-in off. */
export function signedInUser(req: Request): string | null {
  const auth = (req as { auth?: unknown }).auth;
  return typeof auth === "function" && (auth as { [clerkAuth]?: unknown })[clerkAuth] === true ? getAuth(req).userId : null;
}
/**
 * The configured origin a request is for: the first host it names (each
 * X-Forwarded-Host entry, then Host) that is a configured origin's, else the
 * first configured origin. The request only chooses between configured
 * values; what Clerk is told never comes from its headers.
 */
export function originFor(req: { headers: IncomingHttpHeaders }, origins = signInOrigins()): URL | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  const named = [...(Array.isArray(forwarded) ? forwarded : [forwarded ?? ""]).flatMap((value) => value.split(",")), req.headers.host ?? ""]
    .map((host) => host.trim().toLowerCase()).filter(Boolean);
  // A staff origin that does not parse is left to the staff policy, which refuses the configuration.
  const configured = origins.flatMap((origin) => { try { return [new URL(origin)]; } catch { return []; } });
  return named.map((host) => configured.find((origin) => origin.host === host)).find(Boolean) ?? configured[0];
}
/** Clerk's options for a request: sessions accepted only from the configured origins, and the publishable key derived only for a configured host. */
export function clerkOptions(req: { headers: IncomingHttpHeaders }): { publishableKey: string; authorizedParties: string[] } {
  const origins = signInOrigins(), origin = originFor(req, origins), configured = process.env.CLERK_PUBLISHABLE_KEY;
  return { publishableKey: origin ? publishableKeyFromHost(origin.host, configured) : configured ?? "", authorizedParties: origins };
}
/**
 * What the process says about sign-in before it listens: `fatal` when it must
 * not start (staff mode without Clerk, where no one could sign in, or an
 * invalid staff or origin setting), `warning` when it runs with sign-in off
 * (Clerk is configured, but no origin to accept sessions from).
 */
export function signInConfiguration(): { fatal?: string; warning?: string } {
  let staff: boolean;
  try { staff = staffMode(); } catch { return { fatal: "VALOPAY_STAFF_ACCESS must be unset, off or staging, so the server did not start." }; }
  if (staff && !clerkConfigured()) return { fatal: "Staff mode (VALOPAY_STAFF_ACCESS=staging) needs CLERK_SECRET_KEY: without it no one can sign in, so the server did not start." };
  if (staff || !clerkConfigured()) return {};
  let origins: string[];
  try { origins = appOrigins(); } catch { return { fatal: "VALOPAY_APP_ORIGINS must list HTTPS origins separated by commas, such as https://valopay.example, so the server did not start." }; }
  if (!origins.length) return { warning: "CLERK_SECRET_KEY is set but no application origin is (VALOPAY_APP_ORIGINS, or REPLIT_DOMAINS on Replit): sign-in is off and every request is an anonymous sandbox." };
  return {};
}
