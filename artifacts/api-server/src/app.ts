import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import healthRouter from "./routes/health";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { errorHandler } from "./lib/error-handler";
import { clerkOptions, signInEnabled, staffMode, staffPolicy } from './lib/staff-access';
import { CLERK_PROXY_PATH,clerkProxyMiddleware,getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import { createPaystackIngress } from './routes/sources';
import { paystackIngress } from './lib/paystack-connection';
import { clientNetwork, createRequestLimits, createWindowCounter } from './lib/request-limits';

/** The path of the first key or string in a parsed body that carries a NUL character, "" for the body itself. */
export function nulField(value: unknown, path = "", depth = 0): string | undefined {
  if (typeof value === "string") return value.includes("\u0000") ? path : undefined;
  if (depth > 32 || value === null || typeof value !== "object") return undefined;
  for (const [key, item] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (key.includes("\u0000")) return path || "a field name";
    const found = nulField(item, at, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

const app: Express = express();
app.set("trust proxy",1);
app.disable("x-powered-by");

/**
 * Every request has an id: a short random one, or, on a host whose edge sets
 * X-Request-Id on every request (VALOPAY_EDGE_REQUEST_ID=on), the edge's own
 * when it is a plain token, so the two logs line up. A client's header is
 * never trusted otherwise: it could reuse the reference someone else quoted.
 * The id is on every log line of the request, on the answer as X-Request-Id,
 * and in every error body as requestId, so the reference a person quotes finds
 * the lines.
 */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
export function requestIdFor(req: { headers: IncomingHttpHeaders }, edgeSetsId = process.env.VALOPAY_EDGE_REQUEST_ID === "on"): string {
  const given = edgeSetsId ? req.headers["x-request-id"] : undefined;
  const first = Array.isArray(given) ? given[0] : given;
  return first && REQUEST_ID.test(first) ? first : randomBytes(8).toString("hex");
}

app.use(
  pinoHttp({
    logger,
    genReqId: (req) => requestIdFor(req),
    // A failed answer is an error line; a 503 that says when to retry (a busy lender, a database limit) is a
    // warning, so a busy moment does not page anyone; every other request is one info line with its status and time.
    customLogLevel: (_req, res, error) => (error ? "error" : res.statusCode === 503 && res.getHeader("Retry-After") ? "warn" : res.statusCode >= 500 ? "error" : "info"),
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((req,res,next)=>{res.setHeader("X-Request-Id",String(req.id));next();});
app.use(CLERK_PROXY_PATH,clerkProxyMiddleware());
// Liveness and readiness answer before anything else reads the request: no sign-in, no body, their own per-network limit.
app.use("/api", healthRouter);
// Paystack test deliveries: 120 a minute per client network.
const deliveries=createWindowCounter({limit:120,windowMs:60_000});
app.use('/api/v1/providers/paystack',(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!deliveries.take(clientNetwork(req.ip))){res.setHeader('Retry-After','60');res.status(429).json({error:'Test event delivery limit reached.',requestId:req.id});return;}
  next();
});
// The Paystack test ingress reads its own raw body and checks its signature before it touches a lender.
app.use('/api',createPaystackIngress(paystackIngress));
// The response headers, the origin rule, sign-in and the request limits come
// before the body is read, so a malformed or oversized body is answered with the
// same headers as any other request, and a refused client never has its body parsed.
const requestLimits=createRequestLimits();
const clerk=clerkMiddleware((req)=>clerkOptions(req));
app.use("/api/v1",(req,res,next)=>{
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  // API answers are for the console on this origin: never framed, never readable from another origin.
  res.setHeader("X-Frame-Options","DENY");
  res.setHeader("Cross-Origin-Resource-Policy","same-origin");
  const origin=req.get("Origin"),host=getClerkProxyHost(req);
  if (staffMode() && !['GET','HEAD','OPTIONS'].includes(req.method) && (!origin || !staffPolicy().authorisedParties.includes(origin))) { res.status(403).json({error:'Use the configured pilot origin for staff changes.',requestId:req.id}); return; }
  if(origin){
    try{if(new URL(origin).host!==host){req.log.warn({event:"request.refused",reason:"origin"},"Cross-origin request refused");res.status(403).json({error:"Cross-origin requests are not permitted.",requestId:req.id});return;}}
    catch{req.log.warn({event:"request.refused",reason:"origin_malformed"},"Malformed request origin refused");res.status(403).json({error:"Invalid request origin.",requestId:req.id});return;}
  }
  // A client network's ceiling, before a session is checked: it also bounds what checking forged sessions costs.
  requestLimits.network(req,res,next);
});
// Sign-in: Clerk checks the session where this host can (signInEnabled); otherwise every request is anonymous.
// A staff host refuses anonymous requests, and does not start without Clerk (index.ts).
app.use((req,res,next)=>{
  if(signInEnabled())return clerk(req,res,next);
  if(staffMode())return next(Object.assign(new Error("Staff sign-in is not configured on this host."),{status:503}));
  return next();
});
// Each principal's own quota: a signed-in person, a sandbox this process has served, otherwise the network.
app.use("/api/v1",(req,res,next)=>requestLimits.principal(req,res,next));
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({ extended: false,limit:"2mb" }));
app.use((req,res,next)=>{
  // PostgreSQL text cannot hold NUL, so it is refused here, naming the field, before anything is journaled or saved.
  const field=nulField(req.body);
  if(field!==undefined){req.log.info({event:"request.rejected",status:400,reason:"nul_character"},"Request body refused");res.status(400).json({error:`Text cannot contain the NUL character (\\u0000). Remove it from ${field || "the request"} and try again.`,requestId:req.id});return;}
  next();
});
app.use("/api", router);
// An address under /api that no route answers is a JSON answer with the request id, not the framework's HTML page.
app.use("/api",(req,res)=>{res.status(404).json({error:"Unknown resource.",requestId:req.id});});
app.use(errorHandler);

export default app;
