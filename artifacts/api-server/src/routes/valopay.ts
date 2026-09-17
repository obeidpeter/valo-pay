import { Router, type Request, type Response, type IRouter } from "express";
import * as S from "@workspace/api-zod";
import { z } from "zod";
import { inWorkspace, loadState, saveState, roles, fail, appendAudit, verifyAudit, digest, canonical, listMerchants, findIdempotency, saveIdempotency, changeRole, type StoreContext } from "../lib/valopay-store";
import { buildAlerts, buildOverview, buildReports, makeRecord, validateRecord, executeAction } from "../domain";
import { enrolEligibleFailures } from "../domain/policy-engine";
import { ABSOLUTE_TICKET_FLOOR_KOBO, authorisationModes, defaultStatus, executionWindow, handBackOwners, recordKinds } from "@workspace/valopay-schema";
import type { DomainState } from "../domain/types";
import { getGates, getSettings } from "../lib/valopay-readiness";
import { importCsv } from "../lib/valopay-import";
import { createExportFile, customerTimeline, exportDescriptor, exportKinds, readExport } from "../lib/valopay-exports";

const router:IRouter=Router();
const kinds=new Set<string>(recordKinds);
function safeKind(value:unknown):string { const kind=z.string().parse(value);if(!kinds.has(kind))fail("Unknown resource.",404);return kind; }
async function withState<T>(req:Request,res:Response,operation:(state:DomainState,context:StoreContext)=>Promise<T>|T,mutating=false,responseSchema?:z.ZodTypeAny){
 const {merchantId}=S.GetOverviewQueryParams.parse(req.query);
 return inWorkspace(req,res,async ctx=>{
  // A read takes a share lock so it never queues behind other reads; a mutation takes the exclusive lock.
  const state=await loadState(ctx,merchantId,mutating?"update":"share");
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
 const result=await withState(req,res,(state,ctx)=>buildOverview(state,ctx.now,buildAlerts(state,ctx.now,verifyAudit(state))));
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
  const input={...body,status:body.status||defaultStatus[kind as keyof typeof defaultStatus]||"draft",data:{...body.data,synthetic:true} as Record<string,any>,createdAt:ctx.now,updatedAt:ctx.now};
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
   // RET-10: an obligation amended after its first failure leaves the experiment's eligible set.
   if(input.amountKobo!==old.amountKobo||String(input.data.dueDate)!==String(old.data.dueDate))input.data.amendedAt=ctx.now;
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
  const start=body.executionStart??state.settings.executionStart??executionWindow.defaultStartHour,end=body.executionEnd??state.settings.executionEnd??executionWindow.defaultEndHour;
  if(start<executionWindow.earliestHour||end>executionWindow.latestHour||start>=end)fail(`Execution window must be WAT hours within ${executionWindow.earliestHour}:00 to ${executionWindow.latestHour}:00 with the start before the end (DEB-01).`);
  if(body.minimumTicketKobo!==undefined&&body.minimumTicketKobo<ABSOLUTE_TICKET_FLOOR_KOBO)fail("The ₦5,000 floor cannot be overridden.");
  if(body.defaultOwner&&!(handBackOwners as readonly string[]).includes(body.defaultOwner))fail("Valo execution ownership requires a verified production cutover.");
  if(body.authorisationMode&&!(authorisationModes as readonly string[]).includes(body.authorisationMode))fail(`Authorisation mode must be one of: ${authorisationModes.join(", ")}.`);
  for(const key of ["unallocatedAlertThreshold","notificationCostAlertKobo"] as const)if(body[key]!==undefined&&(!Number.isInteger(body[key])||Number(body[key])<0))fail(`${key} must be a non-negative integer.`);
  Object.assign(state.settings,body);return getSettings(state,ctx.role);
  },true,S.UpdateSettingsResponse);
 res.json(S.UpdateSettingsResponse.parse(result));
});
router.post("/v1/exports",async(req,res)=>{
 const body=S.CreateExportBody.parse(req.body);
 if(!kinds.has(body.kind)&&!(exportKinds as readonly string[]).includes(body.kind))fail("Unknown export kind.");
 if(["customer-pack","dispute-pack"].includes(body.kind)&&!body.customerId)fail("A dispute pack needs customerId.");
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
 // The authorised metadata is read inside the transaction; the object-storage read happens after it ends, so no merchant lock is held across the download.
 const descriptor=await withState(req,res,state=>exportDescriptor(state,String(req.params.id)));
 if(cancellation.signal.aborted)return;
 const result=await readExport(descriptor,cancellation.signal);
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