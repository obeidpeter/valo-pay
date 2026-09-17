import { Router, type Request, type Response, type IRouter } from "express";
import * as S from "@workspace/api-zod";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { inWorkspace, loadState, saveState, roles, fail, appendAudit, verifyAudit, digest, canonical, listMerchants, findIdempotency, saveIdempotency, changeRole, type StoreContext } from "../lib/valopay-store";
import { buildReports, makeRecord, validateRecord, executeAction } from "../domain";
import { enrolEligibleFailures } from "../domain/policy-engine";
import type { DomainState } from "../domain/types";
import { getGates, getSettings } from "../lib/valopay-readiness";
import { importCsv } from "../lib/valopay-import";
import { createExportFile, customerTimeline, downloadExport } from "../lib/valopay-exports";

const router:IRouter=Router();
const kinds=new Set(["customers","mandates","due-items","attempts","observations","payments","allocations","settlement-batches","exceptions","policies","templates","notifications","cutovers","audit","closes","exports","commercial","reviews","evidence","experiments","costs","calendar","integrations","members","retry-decisions"]);
const jsonBody=(schema:z.ZodTypeAny,body:unknown)=>schema.parse(body);
function safeKind(value:unknown):string { const kind=z.string().parse(value);if(!kinds.has(kind))fail("Unknown resource.",404);return kind; }
async function withState<T>(req:Request,res:Response,operation:(state:DomainState,context:StoreContext)=>Promise<T>|T,mutating=false,responseSchema?:z.ZodTypeAny){
 const {merchantId}=S.GetOverviewQueryParams.parse(req.query);
 return inWorkspace(req,res,async ctx=>{
  const state=await loadState(ctx,merchantId);
   const before=structuredClone(state);
  const key=req.header("Idempotency-Key");
  const fingerprint=digest(canonical({path:req.path,method:req.method,body:req.body,actor:ctx.actor}));
  const idempotencyKey=key?digest(`${merchantId}:${key}`):undefined;
  if(mutating&&key){
   if(key.length>200)fail("Idempotency-Key must be at most 200 characters.");
    const found=await findIdempotency(ctx,idempotencyKey!);
    if(found){if(found.request_hash!==fingerprint)fail("This idempotency key was used with different input.",409);return responseSchema?responseSchema.parse(found.response):found.response;}
  }
   const rawResult=await operation(state,ctx);
   // Validate before committing: an invalid response must not leave durable writes.
   const result=responseSchema?responseSchema.parse(rawResult):rawResult;
  if(mutating){
   enrolEligibleFailures(state,ctx);
   appendAudit(state,ctx,req.path.includes("/actions")?String(req.body.action):`${req.method.toLowerCase()}.${req.path.split("/").slice(2).join(".")}`,req.body.recordId||String(req.params.id||"workspace"),req.body.reason||"Synthetic workspace operation",{beforeDigest:digest(canonical(before)),afterDigest:digest(canonical(state))});
    await saveState(ctx,state);
    if(idempotencyKey)await saveIdempotency(ctx,idempotencyKey,fingerprint,result);
  }
  return result;
 });
}
router.get("/v1/workspace",async(req,res)=>{
 const result=await inWorkspace(req,res,async ctx=>({
  name:"Valo Pay",environment:"sandbox",actor:ctx.actor,role:ctx.role,authenticated:ctx.authenticated,
   merchants:await listMerchants(ctx),roles,productionEnabled:false
 }));
 res.json(S.GetWorkspaceResponse.parse(result));
});
router.get("/v1/overview",async(req,res)=>{
 const result=await withState(req,res,state=>{
  const all=state.records,by=(kind:string)=>all.filter(r=>r.kind===kind);
  const payments=by("payments").filter(r=>r.data.settlementStatus==="settled"&&r.status!=="possible_duplicate"&&r.data.reversalStatus==="none");
  const outstanding=by("due-items").reduce((sum,r)=>sum+Number(r.data.outstandingKobo??r.amountKobo),0);
  const certain=by("allocations").filter(r=>r.status==="confirmed"&&r.data.confidence==="certain");
  const open=by("exceptions").filter(r=>!["resolved","closed"].includes(r.status));
  const metric=(key:string,label:string,value:number,unit:string,detail:string)=>({key,label,value,unit,detail});
  return {metrics:[
   metric("settled","Reconciled collections",payments.reduce((s,r)=>s+Number(r.data.allocatedKobo||0),0),"kobo","Canonical settled payments, counted once · synthetic"),
   metric("outstanding","Outstanding obligations",outstanding,"kobo","Derived from due items, not a funds balance"),
   metric("match_rate","Certain match rate",payments.length?Math.round(certain.length/payments.length*100):0,"percent","Synthetic sample only; not Test 5 evidence"),
   metric("exceptions","Open exceptions",open.length,"count","Items requiring an accountable owner"),
  ],queues:[metric("activation","Awaiting activation",by("mandates").filter(r=>r.status==="pending_activation").length,"count","Provider-specific workflows"),
   metric("review","Matches to review",by("payments").filter(r=>r.status==="proposed").length,"count","Finance confirmation required"),
   metric("failures","Failed collections",by("attempts").filter(r=>r.status==="failed").length,"count","Observed external attempts"),
   metric("overdue","Overdue exceptions",open.filter(r=>new Date(r.data.dueBy).getTime()<Date.now()).length,"count","Escalate to the assigned owner")],
   activity:by("audit").sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,8),
   upcoming:by("due-items").filter(r=>!["paid","closed","cancelled"].includes(r.status)).slice(0,6),
   mode:state.merchant.mode,environment:"sandbox",lastClose:by("closes").at(-1)?.createdAt||"Not closed yet"};
 });
 res.json(S.GetOverviewResponse.parse(result));
});
router.get("/v1/records/:kind",async(req,res)=>{
 const kind=safeKind(req.params.kind),query=S.ListRecordsQueryParams.parse(req.query);
 const result=await withState(req,res,state=>{
  let items=state.records.filter(r=>r.kind===kind);
  if(query.status&&query.status!=="all")items=items.filter(r=>r.status===query.status);
  if(query.search){const search=query.search.toLowerCase();items=items.filter(r=>`${r.name} ${r.reference} ${r.status} ${JSON.stringify(r.data)}`.toLowerCase().includes(search));}
  items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  // Never leak internal storage location through collection APIs.
  return {items:items.map(r=>r.kind==="exports"?{...r,data:{...r.data,objectName:undefined,bucket:undefined}}:r),total:items.length};
 });
 res.json(S.ListRecordsResponse.parse(result));
});
router.post("/v1/records/:kind",async(req,res)=>{
 const kind=safeKind(req.params.kind),body=S.CreateRecordBody.parse(req.body);
 const result=await withState(req,res,(state,ctx)=>{
  const defaults:Record<string,string>={customers:"active",mandates:"pending_activation","due-items":"scheduled",attempts:"failed",observations:"unresolved",exceptions:"open",evidence:"pending",calendar:"active",commercial:"discovery",reviews:"recorded",costs:"recorded",cutovers:"draft",experiments:"draft",policies:"draft",templates:"draft"};
  const input={...body,status:body.status||defaults[kind]||"draft",data:{...body.data,synthetic:true} as Record<string,any>,createdAt:ctx.now,updatedAt:ctx.now};
  if(["policies","templates"].includes(kind)){input.data.author=ctx.actor;input.data.version=1;}
  if(kind==="due-items")input.data.outstandingKobo=body.amountKobo;
  if(kind==="attempts"){input.data.source="external";input.data.simulated=true;}
  validateRecord(state,ctx,kind,input);
  if(body.reference&&state.records.some(r=>r.kind===kind&&r.reference===body.reference&&kind!=="observations"))fail("Reference already exists. Use an idempotency key for safe replay.",409);
  return makeRecord(state,kind,input);
  },true,S.CreateRecordResponse);
 res.json(S.CreateRecordResponse.parse(result));
});
router.patch("/v1/records/:kind/:id",async(req,res)=>{
 const kind=safeKind(req.params.kind),{id}=S.UpdateRecordParams.parse(req.params),body=S.UpdateRecordBody.parse(req.body);
 const result=await withState(req,res,(state,ctx)=>{
  const old=state.records.find(r=>r.kind===kind&&r.id===id);if(!old)fail("Record not found.",404);
  const input={...old,...body,data:{...old.data,...body.data,synthetic:true} as Record<string,any>,updatedAt:ctx.now};
  if(kind==="due-items"){
   const allocated=state.records.filter(r=>r.kind==="allocations"&&r.status==="confirmed"&&r.data.dueItemId===old.id).reduce((s,r)=>s+r.amountKobo,0);
   if(input.amountKobo<allocated)fail("Due amount cannot be reduced below confirmed allocations.");
   for(const key of ["experimentId","experimentArm","firstFailureAt"])if(JSON.stringify(input.data[key])!==JSON.stringify(old.data[key]))fail("Experiment assignment is immutable.");
   input.data.outstandingKobo=input.amountKobo-allocated;
  }
  validateRecord(state,ctx,kind,input,true);Object.assign(old,input);return old;
  },true,S.UpdateRecordResponse);
 res.json(S.UpdateRecordResponse.parse(result));
});
router.post("/v1/actions",async(req,res)=>{
 const body=S.PerformActionBody.parse(req.body);
 const result=await withState(req,res,async(state,ctx)=>{
  if(body.action==="set_role"){
   const role=String(body.data?.role);if(!roles.includes(role))fail("Unknown sandbox persona.");
    await changeRole(ctx,role);
   return {message:`Now using ${role} demo persona. No real-world permissions were changed.`,data:{role}};
  }
  if(body.action==="verify_audit")return {message:"Audit-chain verification completed.",data:verifyAudit(state)};
  if(body.action==="mark_pack_used")fail("Synthetic packs cannot be recorded as evidence used in a real case.",403);
  return executeAction(state,ctx,body);
  },true,S.PerformActionResponse);
 res.json(S.PerformActionResponse.parse(result));
});
router.post("/v1/imports",async(req,res)=>{
 const body=S.ImportRecordsBody.parse(req.body);
  const result=await withState(req,res,(state,ctx)=>importCsv(state,ctx,body),body.commit,S.ImportRecordsResponse);
 res.json(S.ImportRecordsResponse.parse(result));
});
router.get("/v1/customers/:id/timeline",async(req,res)=>{
 const {id}=S.GetCustomerTimelineParams.parse(req.params);
 res.json(S.GetCustomerTimelineResponse.parse(await withState(req,res,state=>customerTimeline(state,id))));
});
router.get("/v1/reports",async(req,res)=>{
 res.json(S.GetReportsResponse.parse(await withState(req,res,(state,ctx)=>buildReports(state,ctx.now))));
});
router.get("/v1/gates",async(req,res)=>{
 res.json(S.GetGatesResponse.parse(await withState(req,res,getGates)));
});
router.get("/v1/settings",async(req,res)=>{
 res.json(S.GetSettingsResponse.parse(await withState(req,res,(state,ctx)=>getSettings(state,ctx.role))));
});
router.patch("/v1/settings",async(req,res)=>{
 const body=S.UpdateSettingsBody.parse(req.body);
 const result=await withState(req,res,(state,ctx)=>{
  if(ctx.role!=="Admin")fail("Only an Admin can change lender settings.",403);
  const start=body.executionStart??state.settings.executionStart,end=body.executionEnd??state.settings.executionEnd;
  if(start<0||end>24||start>=end)fail("Execution window must be valid WAT hours from 0 to 24.");
  if(body.minimumTicketKobo!==undefined&&body.minimumTicketKobo<500000)fail("The ₦5,000 floor cannot be overridden.");
  if(body.defaultOwner&&!["lms","merchant_manual","provider_auto"].includes(body.defaultOwner))fail("Valo execution ownership requires a verified production cutover.");
  if(body.authorisationMode&&!["batch","standing"].includes(body.authorisationMode))fail("Authorisation mode must be batch or standing.");
  Object.assign(state.settings,body);return getSettings(state,ctx.role);
  },true,S.UpdateSettingsResponse);
 res.json(S.UpdateSettingsResponse.parse(result));
});
router.post("/v1/exports",async(req,res)=>{
 const body=S.CreateExportBody.parse(req.body);
 if(!kinds.has(body.kind)&&!["gate-pack","customer-pack","billing"].includes(body.kind))fail("Unknown export kind.");
  const result=await withState(req,res,(state,ctx)=>createExportFile(state,ctx,body),true,S.CreateExportResponse);
 res.json(S.CreateExportResponse.parse(result));
});
router.get("/v1/exports/:id/download",async(req,res)=>{
 const cancellation=new AbortController();
 const abort=()=>cancellation.abort();
 const close=()=>{if(!res.writableEnded)abort();};
 req.once("aborted",abort);
 res.once("close",close);
 try{
 const result=await withState(req,res,state=>downloadExport(state,String(req.params.id),cancellation.signal));
 if(cancellation.signal.aborted)return;
 res.setHeader("Content-Type",result.contentType);
 res.setHeader("Content-Disposition",`attachment; filename="${result.filename}"`);
 res.setHeader("Cache-Control","private, no-store");
 res.send(result.bytes);
 }catch(error){
 if(!cancellation.signal.aborted)throw error;
 }finally{
 req.off("aborted",abort);
 res.off("close",close);
 }
});
// Unconfigured ingress fails closed; fabricated webhooks can never become evidence.
router.post("/v1/webhooks/:provider",(_req,res)=>{
 res.status(403).json({error:"Production provider webhook ingress is disabled. No partner signature configuration is available."});
});
router.get("/v1/openapi.json",async(_req,res)=>{
 const {readFile}=await import("node:fs/promises");
 res.type("application/json").send(await readFile(new URL("./openapi.json",import.meta.url),"utf8"));
});
export default router;