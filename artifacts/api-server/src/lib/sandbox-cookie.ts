import type { Request, Response } from "express";
import { sha256Hex } from "./digests";

/**
 * The anonymous sandbox's cookie holds a 32-byte random token; the sandbox is
 * found by its digest, never by the token. On a secure request the cookie is
 * `__Host-valopay_sandbox`: Secure, Path=/ and no Domain, so no other host, a
 * sibling subdomain included, can set or shadow it. On a plain-HTTP request (a
 * local run) it is `valopay_sandbox`. Every answer renews it for its lifetime.
 */
export const SANDBOX_COOKIE = "valopay_sandbox";
export const HOST_SANDBOX_COOKIE = `__Host-${SANDBOX_COOKIE}`;
/** The name before the rename to valopay_sandbox. */
export const LEGACY_SANDBOX_COOKIE = "valo_sandbox";
/**
 * Until the end of 2026 (UTC) the older names are still read, to move a
 * browser's sandbox to the current name once: `valo_sandbox` anywhere, and
 * `valopay_sandbox` on a secure request. The answer then issues the same token
 * under the current name and clears the old cookie. From 1 January 2027 they
 * are not read, and a browser that still holds only an old cookie starts a new
 * sandbox; the cookie lasts 30 days from the last visit, so any browser that
 * visits in the meantime keeps its sandbox.
 */
export const LEGACY_SANDBOX_COOKIES_UNTIL = Date.parse("2027-01-01T00:00:00.000Z");
const TOKEN = /^[a-f0-9]{64}$/;

/** The principal an anonymous sandbox's token stands for. */
export const sandboxPrincipal = (token: string): string => sha256Hex(`demo:${token}`);

/** A secure request: TLS here, or at the host's edge, which says so in X-Forwarded-Proto. */
export const secureRequest = (req: Pick<Request, "secure" | "headers">): boolean => Boolean(req.secure) || req.headers["x-forwarded-proto"] === "https";

/** Every value the Cookie header carries under a name, in order. */
function cookieValues(header: string, name: string): string[] {
  return header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
}

/** What a request's cookies say about its sandbox. */
export interface SandboxCookie {
  /** The cookie's name for this request. */
  name: string;
  /** The token that names the sandbox, when the request carries one. */
  token?: string;
  /** Older cookies the request carries, which the answer clears. */
  stale: string[];
}

/**
 * Which sandbox a request's cookies name. The current name decides when it
 * carries a token; on a secure request only this host can have set it, so a
 * cookie under an older name beside it is ignored and cleared. Otherwise,
 * until LEGACY_SANDBOX_COOKIES_UNTIL, an older name's token is taken over.
 * Two different tokens under the name that decides are refused (400), not
 * guessed between: a cookie planted for a parent domain with a longer path is
 * sent first, and taking it would put the visitor in a sandbox someone else
 * can read. A value that is not a token names no sandbox and is ignored.
 */
export function readSandboxCookie(header: string | undefined, secure: boolean, nowMs = Date.now()): SandboxCookie {
  const cookies = header ?? "";
  const name = secure ? HOST_SANDBOX_COOKIE : SANDBOX_COOKIE;
  const older = secure ? [SANDBOX_COOKIE, LEGACY_SANDBOX_COOKIE] : [LEGACY_SANDBOX_COOKIE];
  const stale = older.filter((old) => cookieValues(cookies, old).length > 0);
  for (const candidate of [name, ...(nowMs < LEGACY_SANDBOX_COOKIES_UNTIL ? older : [])]) {
    const tokens = [...new Set(cookieValues(cookies, candidate).filter((value) => TOKEN.test(value)))];
    if (tokens.length > 1) throw Object.assign(new Error("This browser sent two different sandbox cookies, so it is not clear which sandbox is yours. Clear this site's cookies, then reload the page."), { status: 400 });
    if (tokens.length === 1) return { name, token: tokens[0], stale };
  }
  return { name, stale };
}

/** The token a request's cookies name, or undefined when they name none or two; for the request limit, which never refuses on its own account. */
export function sandboxTokenOf(req: Pick<Request, "secure" | "headers">): string | undefined {
  try { return readSandboxCookie(req.headers.cookie, secureRequest(req)).token; } catch { return undefined; }
}

/** Renews the cookie for `maxAgeMs` and clears the older ones the request carried, the current one first, so a client that keeps only the first cookie keeps the right one. */
export function writeSandboxCookie(res: Pick<Response, "cookie">, cookie: SandboxCookie, token: string, secure: boolean, maxAgeMs: number): void {
  const options = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  res.cookie(cookie.name, token, { ...options, maxAge: maxAgeMs });
  for (const stale of cookie.stale) res.cookie(stale, "", { ...options, expires: new Date(0) });
}
