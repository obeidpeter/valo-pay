import express, { type Express, type ErrorRequestHandler } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { ZodError } from "zod";
import { CLERK_PROXY_PATH,clerkProxyMiddleware,getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";

const app: Express = express();
app.set("trust proxy",1);
app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
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
app.use(CLERK_PROXY_PATH,clerkProxyMiddleware());
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({ extended: false,limit:"2mb" }));
app.use(clerkMiddleware((req)=>({
  publishableKey:publishableKeyFromHost(getClerkProxyHost(req)??"",process.env.CLERK_PUBLISHABLE_KEY),
})));
const limits=new Map<string,{count:number;reset:number}>();
app.use("/api/v1",(req,res,next)=>{
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  const origin=req.get("Origin"),host=getClerkProxyHost(req);
  if(origin){
    try{if(new URL(origin).host!==host){res.status(403).json({error:"Cross-origin requests are not permitted."});return;}}
    catch{res.status(403).json({error:"Invalid request origin."});return;}
  }
  const now=Date.now(),key=req.ip||"unknown";
  if(limits.size>10000)for(const [ip,value]of limits)if(value.reset<now)limits.delete(ip);
  const limit=limits.get(key);
  if(!limit||limit.reset<now)limits.set(key,{count:1,reset:now+60000});
  else if(++limit.count>300){res.setHeader("Retry-After","60");res.status(429).json({error:"Request limit reached. Please try again in one minute."});return;}
  next();
});

app.use("/api", router);
const errorHandler:ErrorRequestHandler=(error,req,res,_next)=>{
  if(res.headersSent)return;
  if(error instanceof ZodError){
    res.status(400).json({error:"Validation failed.",details:error.issues.map(issue=>({field:issue.path.join("."),message:issue.message}))});return;
  }
  const databaseCodes=["23503","23505","23514","P0001"];
  if(databaseCodes.includes(error.code)){
    req.log.warn({code:error.code},"Database safety constraint rejected operation");
    res.status(409).json({error:"Operation conflicts with an existing record, immutable evidence or allocation limit."});return;
  }
  if(error.code||error.status>=500){
    req.log.error({code:error.code,name:error.name},"Valopay operation failed");
    res.status(500).json({error:"The operation could not be completed. No partial change has been committed."});return;
  }
  const status=error.status||(/not permitted|requires.*role|only.*admin|read-only|disabled|gate|instruction mode/i.test(error.message)?403:400);
  res.status(status).json({error:error.message||"The operation was rejected."});
};
app.use(errorHandler);

export default app;
