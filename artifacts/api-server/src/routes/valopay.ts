import { getCustomerHistory } from '../lib/valopay-store';
import { listReconciliation, listCloseHistory, getCloseDetail, loadReportsView } from '../lib/valopay-store';
import { Router, type Request, type Response, type IRouter } from "express";
import * as S from "@workspace/api-zod";
import { z } from "zod";
import { inWorkspace, loadState, loadCustomerView, loadSettingsView, listRecords, saveState, roles, fail, appendAudit, verifyAudit, digest, canonical, listMerchants, findIdempotency, saveIdempotency, changeRole, type StoreContext } from "../lib/valopay-store";
import { customerTimeline, makeRecord, rescheduleAfterSettings, validateRecord, executeAction } from "../domain";
import { enrolEligibleFailures } from "../domain/policy-engine";
import { bindCloseReviewBasis } from '../domain/close-review';
import { assertNoDirectImportedCorrection } from '../domain/import-corrections';
import { ABSOLUTE_TICKET_FLOOR_KOBO, authorisationModes, closeTimeOf, defaultStatus, executionWindow, handBackOwners, isCloseTime, recordKinds } from "@workspace/valopay-schema";
import type { DomainState } from "../domain/types";
import { getGates } from "../lib/valopay-readiness";
import { importCsv } from "../lib/valopay-import";
import { exportDescriptorForRecord, exportKinds, readExport } from "../lib/valopay-exports";
import { exportJobView, publicExportRecord, queueExport, retryExport } from '../lib/export-jobs';
import { advanceRecordVersions, assertRecordVersion, assertSettingsVersion } from "../lib/edit-versions";
import { schedulerStatus } from "../lib/close-scheduler";
import { buildConsoleOverview, buildConsoleReports, buildConsoleSettings } from "../lib/valopay-close-views";
import { listQueue } from '../lib/valopay-store';
import { completeOperation, viewerScope } from '../lib/valopay-store';

const router:IRouter=Router();
const kinds=new Set<string>(recordKinds);
function safeKind(value:unknown):string { const kind=z.string().parse(value);if(!kinds.has(kind))fail("Unknown resource.",404);return kind; }
export async function withState<T>(req:Request,res:Response,operation:(state:DomainState,context:StoreContext)=>Promise<T>|T,mutating=false,responseSchema?:z.ZodTypeAny){
 const {merchantId}=S.GetOverviewQueryParams.parse(req.query);
 return inWorkspace(req,res,async ctx=>{
  // A read takes a share lock so it never queues behind other reads; a mutation takes the exclusive lock.
  const state=await loadState(ctx,merchantId,mutating?"update":"share");
   const before=mutating?structuredClone(state):undefined;
  const key=req.header("Idempotency-Key");
  // A demo-role switch changes ctx.actor itself. Its unchanged retry must keep
  // the original request identity; all other actions stay persona-bound.
  const replayActor=req.path==="/v1/actions"&&req.body?.action==="set_role"?"Sandbox role switch":ctx.actor;
  const fingerprint=digest(canonical({path:req.path,method:req.method,body:req.body,actor:replayActor}));
  const idempotencyKey=key?digest(`${merchantId}:${key}`):undefined;
  if(mutating&&key){
   if(key.length>200)fail("Idempotency-Key must be at most 200 characters.");
    const found=await findIdempotency(ctx,idempotencyKey!);
    if(found){if(found.request_hash!==fingerprint)fail("This idempotency key was used with different input.",409);const receipt=responseSchema?responseSchema.parse(found.response):found.response;await completeOperation(ctx,receipt);return receipt;}
  }
   const rawResult=await operation(state,ctx);
   if(mutating){enrolEligibleFailures(state,ctx);for(const close of state.records.filter(r=>r.kind==='closes'&&!before!.records.some(old=>old.id===r.id)))bindCloseReviewBasis(state,close);advanceRecordVersions(before!,state,ctx.now);}
   // Validate before committing: an invalid response must not leave durable writes.
   const result=responseSchema?responseSchema.parse(rawResult):rawResult;
  if(mutating){
   appendAudit(state,ctx,req.path.includes("/actions")?String(req.body.action):`${req.method.toLowerCase()}.${req.path.split("/").slice(2).join(".")}`,req.body.recordId||String(req.params.id||"workspace"),req.body.reason||"Synthetic workspace operation",{beforeDigest:digest(canonical(before)),afterDigest:digest(canonical(state))});
    await saveState(ctx,state);
    if(idempotencyKey)await saveIdempotency(ctx,idempotencyKey,fingerprint,result);
  }
  return result;
 },!mutating?"read":req.path==="/v1/actions"&&req.body?.action==="set_role"?"persona":"write");
}
router.get("/v1/workspace",async(req,res)=>{
 const result=await inWorkspace(req,res,async ctx=>({
  name:"Valo Pay",environment:"sandbox",actor:ctx.actor,role:ctx.role,authenticated:ctx.authenticated,
   merchants:await listMerchants(ctx),roles,productionEnabled:false,accessMode:ctx.accessMode,viewerScope:viewerScope(ctx)
 }),"read");
 res.json(S.GetWorkspaceResponse.parse(result));
});
router.get("/v1/overview",async(req,res)=>{
 const result=await withState(req,res,(state,ctx)=>buildConsoleOverview(state,ctx.now,verifyAudit(state),schedulerStatus()));
 res.json(S.GetOverviewResponse.parse(result));
});
router.get("/v1/records/:kind",async(req,res)=>{
 const kind=safeKind(req.params.kind),query=S.ListRecordsQueryParams.parse(req.query);
 const result=await inWorkspace(req,res,async ctx=>{
  const page=await listRecords(ctx,query.merchantId,kind,query);
  // Never leak internal storage location through collection APIs.
  return {...page,items:page.items.map(r=>r.kind==="exports"?publicExportRecord(r):r)};
 },"read");
 res.json(S.ListRecordsResponse.parse(result));
});
router.get('/v1/queues/:queue', async (req, res) => {
 const { queue } = S.ListQueueParams.parse(req.params), query = S.ListQueueQueryParams.parse(req.query);
 res.json(S.ListQueueResponse.parse(await inWorkspace(req, res, ctx => listQueue(ctx, query.merchantId, queue, query), 'read')));
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
  if (kind === 'exceptions' && old.data.case && !body.expectedUpdatedAt) fail('Refresh this coordinated case before editing it.',409);
  if (kind === 'exceptions' && old.data.case?.assignee && old.data.case.assignee !== ctx.actor && ctx.role !== 'Admin') fail('Ask the case assignee or an administrator to make this change.',403);
  assertRecordVersion(old,body.expectedUpdatedAt);
  const {expectedUpdatedAt: _version,...changes}=body;
  const input={...old,...changes,data:{...old.data,...body.data,synthetic:true} as Record<string,any>,updatedAt:ctx.now};
  assertNoDirectImportedCorrection(old,input);
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
  if (body.action === 'resolve_exception' && state.records.find(r=>r.id===body.recordId)?.data.case && !body.expectedUpdatedAt) fail('Refresh this coordinated case before resolving it.',409);
  if(body.expectedUpdatedAt!==undefined){
   const record=state.records.find(r=>r.id===body.recordId);if(!record)fail("Record not found.",404);
   assertRecordVersion(record,body.expectedUpdatedAt);
  }
  if(body.action==="set_role"){
   const role=String(body.data?.role);if(!roles.includes(role))fail("Unknown sandbox persona.");
    await changeRole(ctx,role);
   return {message:`Demo role changed to ${role}. This only affects the sample workspace.`,data:{role}};
  }
  if(body.action==="verify_audit")return {message:"Audit log check complete.",data:verifyAudit(state)};
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
router.get('/v1/customers/:id/history',async(req,res)=>{
 const {id}=S.GetCustomerHistoryParams.parse(req.params), query=S.GetCustomerHistoryQueryParams.parse(req.query);
 const result=await inWorkspace(req,res,ctx=>getCustomerHistory(ctx,query.merchantId,id,query),'read');
 res.json(S.GetCustomerHistoryResponse.parse({...result,events:result.events.map(record=>record.kind==='exports'?publicExportRecord(record):record),...(result.focusedRecord?{focusedRecord:result.focusedRecord.kind==='exports'?publicExportRecord(result.focusedRecord):result.focusedRecord}:{})}));
});
router.get("/v1/customers/:id/timeline",async(req,res)=>{
 const {id}=S.GetCustomerTimelineParams.parse(req.params);
 const {merchantId}=S.GetOverviewQueryParams.parse(req.query);
 res.json(S.GetCustomerTimelineResponse.parse(await inWorkspace(req,res,async ctx=>{
  const timeline=customerTimeline(await loadCustomerView(ctx,merchantId,id),id);
  return {...timeline,events:timeline.events.map(record=>record.kind==='exports'?publicExportRecord(record):record)};
 },"read")));
});
router.get('/v1/reconciliation/:queue',async(req,res)=>{
 const {queue}=S.ListReconciliationParams.parse(req.params), query=S.ListReconciliationQueryParams.parse(req.query);
 res.json(S.ListReconciliationResponse.parse(await inWorkspace(req,res,ctx=>listReconciliation(ctx,query.merchantId,queue,query),'read')));
});
router.get('/v1/close-history',async(req,res)=>{
 const query=S.ListCloseHistoryQueryParams.parse(req.query);
 res.json(S.ListCloseHistoryResponse.parse(await inWorkspace(req,res,ctx=>listCloseHistory(ctx,query.merchantId,query),'read')));
});
router.get('/v1/close-history/:id',async(req,res)=>{
 const {id}=S.GetCloseDetailParams.parse(req.params),{merchantId}=S.GetCloseDetailQueryParams.parse(req.query);
 res.json(S.GetCloseDetailResponse.parse(await inWorkspace(req,res,ctx=>getCloseDetail(ctx,merchantId,id),'read')));
});
router.get('/v1/reports',async(req,res)=>{
 const {merchantId,includeCloses}=S.GetReportsQueryParams.parse(req.query);
 const report=includeCloses==='false' ? await inWorkspace(req,res,async ctx=>({...buildConsoleReports(await loadReportsView(ctx,merchantId),ctx.now,schedulerStatus()),closes:[]}),'read') : await withState(req,res,(state,ctx)=>buildConsoleReports(state,ctx.now,schedulerStatus()));
 res.json(S.GetReportsResponse.parse(report));
});
router.get("/v1/gates",async(req,res)=>{
 res.json(S.GetGatesResponse.parse(await withState(req,res,getGates)));
});
router.get("/v1/settings",async(req,res)=>{
 const {merchantId}=S.GetOverviewQueryParams.parse(req.query);
 res.json(S.GetSettingsResponse.parse(await inWorkspace(req,res,async ctx=>buildConsoleSettings(await loadSettingsView(ctx,merchantId),ctx.role,ctx.now,schedulerStatus()),"read")));
});
router.patch("/v1/settings",async(req,res)=>{
 const body=S.UpdateSettingsBody.parse(req.body);
 const result=await withState(req,res,(state,ctx)=>{
  if(ctx.role!=="Admin")fail("Only an Admin can change lender settings.",403);
  assertSettingsVersion(state.settings,body.expectedRevision);
  const start=body.executionStart??state.settings.executionStart??executionWindow.defaultStartHour,end=body.executionEnd??state.settings.executionEnd??executionWindow.defaultEndHour;
  if(start<executionWindow.earliestHour||end>executionWindow.latestHour||start>=end)fail(`Set the collection window between ${executionWindow.earliestHour}:00 and ${executionWindow.latestHour}:00 West Africa Time, with the start before the end.`);
  if(body.minimumTicketKobo!==undefined&&body.minimumTicketKobo<ABSOLUTE_TICKET_FLOOR_KOBO)fail("The minimum debit is ₦5,000. This limit cannot be overridden.");
  if(body.defaultOwner&&!(handBackOwners as readonly string[]).includes(body.defaultOwner))fail("Valo Pay can take collection ownership only after a verified handover for live operations.");
  if(body.authorisationMode&&!(authorisationModes as readonly string[]).includes(body.authorisationMode))fail(`Authorisation mode must be one of: ${authorisationModes.join(", ")}.`);
  for(const key of ["unallocatedAlertThreshold","notificationCostAlertKobo"] as const)if(body[key]!==undefined&&(!Number.isInteger(body[key])||Number(body[key])<0))fail(`${key} must be a whole number of zero or more.`);
  if(body.closeTime!==undefined&&!isCloseTime(body.closeTime))fail("closeTime must use HH:MM in West Africa Time, for example 07:00.");
  const previous={time:closeTimeOf(state.settings),enabled:state.settings.scheduledCloseEnabled!==false};
  const {expectedRevision: _revision,...preferences}=body;
  Object.assign(state.settings,preferences);
  // REC-01: a changed close time or a switched-on schedule starts from its next occurrence; an unchanged save leaves a pending close pending.
  rescheduleAfterSettings(state,previous,ctx.now);
  return buildConsoleSettings(state,ctx.role,ctx.now,schedulerStatus());
  },true,S.UpdateSettingsResponse);
 res.json(S.UpdateSettingsResponse.parse(result));
});
router.post("/v1/exports",async(req,res)=>{
 const body=S.CreateExportBody.parse(req.body);
 if(!kinds.has(body.kind)&&!(exportKinds as readonly string[]).includes(body.kind))fail("Unknown export kind.");
 if(["customer-pack","dispute-pack"].includes(body.kind)&&!body.customerId)fail("A dispute pack needs customerId.");
  const result=await withState(req,res,(state,ctx)=>queueExport(state,ctx,body,process.env.PRIVATE_OBJECT_DIR||''),true,S.CreateExportResponse);
 req.log.info({event:"export.queued",kind:body.kind,format:body.format,exportId:result.id},"Export queued durably");
 res.json(S.CreateExportResponse.parse(result));
});
async function authorisedExport(req:Request,res:Response){
 const {merchantId}=S.GetOverviewQueryParams.parse(req.query);
 return inWorkspace(req,res,async ctx=>{
  const page=await listRecords(ctx,merchantId,'exports',{id:String(req.params.id),limit:1});
  if(!page.items[0])fail('Export not found in this lender.',404);
  return page.items[0];
 },'read');
}
router.get('/v1/exports/:id',async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');
 res.json(S.GetExportJobResponse.parse(exportJobView(await authorisedExport(req,res))));
});
router.post('/v1/exports/:id/retry',async(req,res)=>{
 req.body={};
 const result=await withState(req,res,(state,ctx)=>retryExport(state,ctx,String(req.params.id)),true,S.RetryExportJobResponse);
 res.json(S.RetryExportJobResponse.parse(result));
});
router.get("/v1/exports/:id/download",async(req,res)=>{
 const cancellation=new AbortController();
 const abort=()=>cancellation.abort();
 const close=()=>{if(!res.writableEnded)abort();};
 req.once("aborted",abort);
 res.once("close",close);
 try{
 // The authorised metadata is read inside the transaction; the object-storage read happens after it ends, so no merchant lock is held across the download.
 const descriptor=exportDescriptorForRecord(await authorisedExport(req,res));
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
