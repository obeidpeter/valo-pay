import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import express, { type Express, type Request, type Response } from "express";
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

/** The deepest a request body may nest objects and arrays. */
export const MAX_BODY_DEPTH = 32;
/**
 * The most values a request body may hold, counting every object, list, text,
 * number, true, false and null in it, the body itself included. The largest
 * body the console sends (a close review's 500 responses) holds a few thousand;
 * an import's CSV travels as one text.
 */
export const MAX_BODY_VALUES = 100_000;
/** A UTF-16 surrogate without its pair: PostgreSQL JSON refuses one, and text silently replaces it. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
type BodyProblem = { field: string; problem: "depth" | "nul" | "surrogate" | "values" };
/**
 * The first thing in a parsed body that nothing may read: more than
 * MAX_BODY_VALUES values, objects and arrays nested more than MAX_BODY_DEPTH
 * levels deep (the checks and fingerprints that walk a body are recursive), a
 * NUL character (PostgreSQL text cannot hold it) or an unpaired surrogate, in a
 * string or a field name. The walk stops at that depth and that count, so it
 * can neither overflow the stack nor run long itself: it reads a list by index
 * and an object by its fields, and gathers the keys of the value it refuses on
 * the way back, so only that value's path is ever built. The field is its
 * dotted path: "" for the body itself or too many values, and the object
 * holding it (or "a field name") for a field name.
 */
export function bodyProblem(body: unknown): BodyProblem | undefined {
  let values = 0;
  const walk = (value: unknown, depth: number): { keys: string[]; problem: BodyProblem["problem"]; name?: true } | undefined => {
    if (++values > MAX_BODY_VALUES) return { keys: [], problem: "values" };
    if (typeof value === "string") return value.includes("\u0000") ? { keys: [], problem: "nul" } : UNPAIRED_SURROGATE.test(value) ? { keys: [], problem: "surrogate" } : undefined;
    if (value === null || typeof value !== "object") return undefined;
    if (depth >= MAX_BODY_DEPTH) return { keys: [], problem: "depth" };
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const found = walk(value[index], depth + 1);
        if (found) { found.keys.push(String(index)); return found; }
      }
      return undefined;
    }
    for (const key in value) {
      if (key.includes("\u0000")) return { keys: [], problem: "nul", name: true };
      if (UNPAIRED_SURROGATE.test(key)) return { keys: [], problem: "surrogate", name: true };
      const found = walk((value as Record<string, unknown>)[key], depth + 1);
      if (found) { found.keys.push(key); return found; }
    }
    return undefined;
  };
  const found = walk(body, 0);
  if (!found) return undefined;
  const field = found.problem === "values" ? "" : found.keys.reverse().join(".");
  return { field: found.name && !field ? "a field name" : field, problem: found.problem };
}
/** What a person reads about a body problem, naming the field (at most 100 characters of it). */
function bodyRefusal({ field, problem }: BodyProblem): string {
  if (problem === "values") return `The request body holds more than ${MAX_BODY_VALUES.toLocaleString("en-GB")} values. Send a smaller request.`;
  const where = field ? (field.length > 100 ? `${field.slice(0, 100)}…` : field) : "the request";
  return problem === "depth" ? `The request body is nested more than ${MAX_BODY_DEPTH} levels deep, at ${where}. Send a flatter body.`
    : problem === "nul" ? `Text cannot contain the NUL character (\\u0000). Remove it from ${where} and try again.`
    : `Text must be valid Unicode: ${where} holds an unpaired surrogate (\\ud800 to \\udfff). Remove it and try again.`;
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
// Paystack test deliveries: 120 a minute per client network here, and 60 per connection once signed (paystack-connection.ts).
const deliveries=createWindowCounter({limit:120,windowMs:60_000});
app.use('/api/v1/providers/paystack',(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(!deliveries.take(clientNetwork(req.ip))){res.setHeader('Retry-After','60');res.status(429).json({error:'Test event delivery limit reached.',requestId:req.id});return;}
  next();
});
// The Paystack test ingress reads its own raw body and checks its signature before it touches a lender.
app.use('/api',createPaystackIngress(paystackIngress));
// Every other address the API answers is under /api/v1, matched as the mounts below match it: a whole segment, in
// either letter case. Any other address under /api is unknown, answered here before a session is checked, a limit
// counts it or a body is read, so asking for one costs nothing.
const unknownResource=(req:Request,res:Response)=>{res.status(404).json({error:"Unknown resource.",requestId:req.id});};
app.use("/api",(req,res,next)=>{if(/^\/v1(?:\/|$)/i.test(req.path))next();else unknownResource(req,res);});
// Under /api/v1 the response headers, the origin rule, sign-in and the request
// limits come before the body is read, so a malformed or oversized body is
// answered with the same headers as any other request, and a refused client
// never has its body parsed.
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
app.use("/api/v1",(req,res,next)=>{
  if(signInEnabled())return clerk(req,res,next);
  if(staffMode())return next(Object.assign(new Error("Staff sign-in is not configured on this host."),{status:503}));
  return next();
});
// Each principal's own quota: a signed-in person, a sandbox this process has served, otherwise the network.
app.use("/api/v1",(req,res,next)=>requestLimits.principal(req,res,next));
// A body is JSON, and only a write's is read: a read's body is ignored (never parsed, checked or fingerprinted), and a
// write's body in any other format, a form's included, is refused (415).
const json=express.json({limit:"2mb"});
app.use("/api/v1",(req,res,next)=>{
  if(req.method==="GET"||req.method==="HEAD"){next();return;}
  const sent=req.headers["transfer-encoding"]!==undefined||Number(req.headers["content-length"]??0)>0;
  if(sent&&!req.is("application/json")){req.log.info({event:"request.rejected",status:415,reason:"content_type"},"Request body refused");res.status(415).json({error:"Send the request body as JSON, with the Content-Type application/json.",requestId:req.id});return;}
  json(req,res,next);
});
app.use("/api/v1",(req,res,next)=>{
  // Refused here, naming the field, before anything is fingerprinted, journaled or saved; too many values is a 413.
  const found=bodyProblem(req.body);
  if(found){const status=found.problem==="values"?413:400;req.log.info({event:"request.rejected",status,reason:found.problem==="values"?"too_many_values":found.problem==="depth"?"nesting_depth":found.problem==="nul"?"nul_character":"unpaired_surrogate"},"Request body refused");res.status(status).json({error:bodyRefusal(found),requestId:req.id});return;}
  next();
});
app.use("/api", router);
// An address under /api/v1 that no route answers is a JSON answer with the request id, not the framework's HTML page.
app.use("/api",(req,res)=>unknownResource(req,res));
app.use(errorHandler);

export default app;
