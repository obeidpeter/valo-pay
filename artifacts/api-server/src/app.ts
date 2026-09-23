import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { errorHandler } from "./lib/error-handler";
import { staffMode, staffPolicy } from './lib/staff-access';
import { CLERK_PROXY_PATH,clerkProxyMiddleware,getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import { createPaystackIngress } from './routes/sources';
import { paystackIngress } from './lib/paystack-connection';

/** The deepest a request body may nest objects and arrays. */
export const MAX_BODY_DEPTH = 32;
/** A UTF-16 surrogate without its pair: PostgreSQL JSON refuses one, and text silently replaces it. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * The first thing in a parsed body that nothing may read: objects and arrays
 * nested more than MAX_BODY_DEPTH levels deep (the checks and fingerprints that
 * walk a body are recursive), a NUL character (PostgreSQL text cannot hold it)
 * or an unpaired surrogate, in a string or a field name. The walk stops at that
 * depth, so it cannot overflow the stack itself. The field is its dotted path:
 * "" for the body itself, and the object holding it (or "a field name") for a
 * field name.
 */
export function bodyProblem(value: unknown, path = "", depth = 0): { field: string; problem: "depth" | "nul" | "surrogate" } | undefined {
  if (typeof value === "string") return value.includes("\u0000") ? { field: path, problem: "nul" } : UNPAIRED_SURROGATE.test(value) ? { field: path, problem: "surrogate" } : undefined;
  if (value === null || typeof value !== "object") return undefined;
  if (depth >= MAX_BODY_DEPTH) return { field: path, problem: "depth" };
  for (const [key, item] of Object.entries(value)) {
    if (key.includes("\u0000")) return { field: path || "a field name", problem: "nul" };
    if (UNPAIRED_SURROGATE.test(key)) return { field: path || "a field name", problem: "surrogate" };
    const found = bodyProblem(item, path ? `${path}.${key}` : key, depth + 1);
    if (found) return found;
  }
  return undefined;
}
/** What a person reads about a body problem, naming the field (at most 100 characters of it). */
function bodyRefusal({ field, problem }: { field: string; problem: "depth" | "nul" | "surrogate" }): string {
  const where = field ? (field.length > 100 ? `${field.slice(0, 100)}…` : field) : "the request";
  return problem === "depth" ? `The request body is nested more than ${MAX_BODY_DEPTH} levels deep, at ${where}. Send a flatter body.`
    : problem === "nul" ? `Text cannot contain the NUL character (\\u0000). Remove it from ${where} and try again.`
    : `Text must be valid Unicode: ${where} holds an unpaired surrogate (\\ud800 to \\udfff). Remove it and try again.`;
}

const app: Express = express();
app.set("trust proxy",1);
app.disable("x-powered-by");

/**
 * Every request has an id: the one the host's edge already gave it, when that is
 * a plain token, so the two logs line up, or a short random one. It is on every
 * log line of the request, on the answer as X-Request-Id, and in every error body
 * as requestId, so the reference a person quotes finds the lines.
 */
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
export function requestIdFor(req: { headers: IncomingHttpHeaders }): string {
  const given = req.headers["x-request-id"];
  const first = Array.isArray(given) ? given[0] : given;
  return first && REQUEST_ID.test(first) ? first : randomBytes(8).toString("hex");
}

app.use(
  pinoHttp({
    logger,
    genReqId: requestIdFor,
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
const webhookLimits=new Map<string,{count:number;until:number}>();
app.use('/api/v1/providers/paystack',(req,res,next)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const now=Date.now(),key=req.ip||'unknown',old=webhookLimits.get(key);
  if(webhookLimits.size>10000)for(const [ip,value]of webhookLimits)if(value.until<now)webhookLimits.delete(ip);
  if(!old||old.until<now)webhookLimits.set(key,{count:1,until:now+60000});
  else if(++old.count>120){res.setHeader('Retry-After','60');res.status(429).json({error:'Test event delivery limit reached.',requestId:req.id});return;}
  next();
});
// The Paystack test ingress reads its own raw body and checks its signature before it touches a lender.
app.use('/api',createPaystackIngress(paystackIngress));
// The response headers, the origin rule and the request limit come before the
// body is read, so a malformed or oversized body is answered with the same
// headers as any other request, and a refused client never has its body parsed.
const limits=new Map<string,{count:number;reset:number}>();
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
  const now=Date.now(),key=req.ip||"unknown";
  if(limits.size>10000)for(const [ip,value]of limits)if(value.reset<now)limits.delete(ip);
  const limit=limits.get(key);
  if(!limit||limit.reset<now)limits.set(key,{count:1,reset:now+60000});
  else if(++limit.count>300){
    // Named once per client and window, not once per refused request, so a flood does not double its own log.
    if(limit.count===301)req.log.warn({event:"request.refused",reason:"rate_limit"},"Request limit reached for a client address");
    res.setHeader("Retry-After","60");res.status(429).json({error:"Request limit reached. Please try again in one minute.",requestId:req.id});return;
  }
  next();
});
// A body is JSON, and only a write's is read: a read's body is ignored (never parsed, checked or fingerprinted), and a
// write's body in any other format, a form's included, is refused (415).
const json=express.json({limit:"2mb"});
app.use((req,res,next)=>{
  if(req.method==="GET"||req.method==="HEAD"){next();return;}
  const sent=req.headers["transfer-encoding"]!==undefined||Number(req.headers["content-length"]??0)>0;
  if(sent&&!req.is("application/json")){req.log.info({event:"request.rejected",status:415,reason:"content_type"},"Request body refused");res.status(415).json({error:"Send the request body as JSON, with the Content-Type application/json.",requestId:req.id});return;}
  json(req,res,next);
});
app.use((req,res,next)=>{
  // Refused here, naming the field, before anything is fingerprinted, journaled or saved.
  const found=bodyProblem(req.body);
  if(found){req.log.info({event:"request.rejected",status:400,reason:found.problem==="depth"?"nesting_depth":found.problem==="nul"?"nul_character":"unpaired_surrogate"},"Request body refused");res.status(400).json({error:bodyRefusal(found),requestId:req.id});return;}
  next();
});
app.use(clerkMiddleware((req)=>({
  publishableKey:publishableKeyFromHost(getClerkProxyHost(req)??"",process.env.CLERK_PUBLISHABLE_KEY),
  ...(staffMode() ? { authorizedParties: [...staffPolicy().authorisedParties] } : {}),
})));

app.use("/api", router);
// An address under /api that no route answers is a JSON answer with the request id, not the framework's HTML page.
app.use("/api",(req,res)=>{res.status(404).json({error:"Unknown resource.",requestId:req.id});});
app.use(errorHandler);

export default app;
