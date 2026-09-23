/**
 * Clerk Frontend API Proxy Middleware
 *
 * Proxies Clerk Frontend API requests through your domain, enabling Clerk
 * authentication on custom domains and .replit.app deployments without
 * requiring CNAME DNS configuration.
 *
 * AUTH CONFIGURATION: To manage users, enable/disable login providers
 * (Google, GitHub, etc.), change app branding, or configure OAuth credentials,
 * use the Auth pane in the workspace toolbar. There is no external Clerk
 * dashboard — all auth configuration is done through the Auth pane.
 *
 * IMPORTANT:
 * - Only active in production (Clerk proxying doesn't work for dev instances)
 * - Must be mounted BEFORE express.json() middleware
 * - What it tells Clerk comes from configuration and the trusted hop, never
 *   from a client's headers: the proxy URL and forwarded host are a
 *   configured application origin's (signInOrigins in lib/staff-access.ts),
 *   and the client address is the one the host's edge saw (req.ip). With no
 *   origin configured it answers 503.
 *
 * Usage in app.ts:
 *   import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
 *   app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
 */

import type { IncomingHttpHeaders } from 'http';
import type { Request, RequestHandler } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { originFor } from '../lib/staff-access';

const CLERK_FAPI = 'https://frontend-api.clerk.dev';
export const CLERK_PROXY_PATH = '/api/__clerk';

/**
 * Returns the first effective public hostname for the given request,
 * preferring x-forwarded-host over the Host header so callers behind a
 * proxy see the original client-facing host.
 *
 * x-forwarded-host can take three shapes:
 *   - undefined (no proxy involved)
 *   - a single string (one proxy hop)
 *   - a comma-delimited string when an upstream appended rather than
 *     replaced the header (Node folds duplicate headers this way), or a
 *     string[] in some Express typings
 * In the multi-value case, the leftmost value is the original client-
 * facing host. Take that one in all forms. app.ts's origin rule compares a
 * request's Origin with it. A client can choose it, so nothing sent to Clerk
 * is built from it: see originFor in lib/staff-access.ts.
 */
export function getClerkProxyHost(req: {
  headers: IncomingHttpHeaders;
}): string | undefined {
  const forwarded = req.headers['x-forwarded-host'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const firstHop = raw?.split(',')[0]?.trim();
  return firstHop || req.headers.host?.trim() || undefined;
}

export function clerkProxyMiddleware(): RequestHandler {
  // Only run proxy in production — Clerk proxying doesn't work for dev instances
  if (process.env.NODE_ENV !== 'production') {
    return (_req, _res, next) => next();
  }

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return (_req, _res, next) => next();
  }

  const proxy = createProxyMiddleware({
    target: CLERK_FAPI,
    changeOrigin: true,
    // Take over the response so it can be re-sent with a Content-Length (see
    // proxyRes); the deployment edge rejects chunked proxied responses.
    selfHandleResponse: true,
    pathRewrite: (path: string) =>
      path.replace(new RegExp(`^${CLERK_PROXY_PATH}`), ''),
    on: {
      proxyReq: (proxyReq, req) => {
        // The configured origin the request's host names, else the first; checked to exist before proxying.
        const origin = originFor(req)!;
        proxyReq.setHeader('Clerk-Proxy-Url', `${origin.origin}${CLERK_PROXY_PATH}`);
        proxyReq.setHeader('Clerk-Secret-Key', secretKey);
        proxyReq.setHeader('X-Forwarded-Host', origin.host);
        proxyReq.setHeader('X-Forwarded-Proto', origin.protocol.slice(0, -1));

        // The client address the host's edge saw (one trusted hop), not the
        // leftmost forwarded-for entry, which the client writes itself.
        const clientIp = (req as Request).ip || req.socket?.remoteAddress;
        if (clientIp) proxyReq.setHeader('X-Forwarded-For', clientIp);
        else proxyReq.removeHeader('X-Forwarded-For');
        for (const header of ['forwarded', 'x-real-ip', 'cf-connecting-ip']) proxyReq.removeHeader(header);
      },
      // Clerk's dynamic Frontend API responses (/v1/environment, /v1/client,
      // JWKS, ...) arrive without a Content-Length, so relaying them would use
      // Transfer-Encoding: chunked — which the deployment edge (Cloud Run)
      // rejects, turning the app's 200 into a 500. Buffer only those so they can
      // be re-sent with a Content-Length; the body is forwarded untouched so
      // Content-Encoding is preserved. Length-known responses (e.g. /npm/*
      // assets) and body-less responses stream through without buffering.
      proxyRes: (proxyRes, req, res) => {
        const headers = { ...proxyRes.headers };
        // Transfer-Encoding/Connection are hop-by-hop (RFC 7230 §6.1).
        delete headers['transfer-encoding'];
        delete headers['connection'];
        delete headers['keep-alive'];

        const status = proxyRes.statusCode ?? 502;
        // Content-Length is forbidden on 1xx/204; HEAD/304 may keep theirs.
        if (status < 200 || status === 204) {
          delete headers['content-length'];
        }

        const bodyless =
          req.method === 'HEAD' ||
          status < 200 ||
          status === 204 ||
          status === 304;
        if (headers['content-length'] !== undefined || bodyless) {
          res.writeHead(status, headers);
          // Headers are already sent, so abort the response if the upstream
          // stream errors mid-pipe (e.g. ECONNRESET) rather than leaving an
          // unhandled 'error' or a hung client.
          proxyRes.on('error', () => res.destroy());
          proxyRes.pipe(res);
          return;
        }

        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const body = Buffer.concat(chunks);
          headers['content-length'] = String(body.length);
          res.writeHead(status, headers);
          res.end(body);
        });
        proxyRes.on('error', () => {
          if (!res.headersSent) {
            // Set a length so the empty 502 isn't sent chunked (which the
            // deployment edge would reject just like the original response).
            res.writeHead(502, { 'content-length': '0' });
          }
          res.end();
        });
      },
    },
  }) as RequestHandler;
  return (req, res, next) => {
    if (!originFor(req)) {
      res.status(503).json({ error: 'Sign-in is not available on this host.', requestId: req.id });
      return;
    }
    return proxy(req, res, next);
  };
}
