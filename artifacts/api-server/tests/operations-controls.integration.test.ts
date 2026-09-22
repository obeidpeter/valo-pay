import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
if(process.env.VALOPAY_RUN_INTEGRATION!=="1"){console.log("Operations controls integration requires a disposable local PostgreSQL database.");process.exit(0);}
assert.ok(["localhost","127.0.0.1","[::1]"].includes(new URL(process.env.DATABASE_URL||"").hostname),"Refuse a non-local integration database.");
const environmentNames=["VALOPAY_STAFF_ACCESS","VALOPAY_RUNTIME_ISOLATION","VALOPAY_PAYLOAD_ENCRYPTION","VALOPAY_KMS_KEY","VALOPAY_PAYSTACK_INGRESS","VALOPAY_PAYSTACK_CONNECTIONS","PAYSTACK_TEST_SECRET_KEY"] as const;
const previousEnvironment=Object.fromEntries(environmentNames.map(name=>[name,process.env[name]]));
process.env.VALOPAY_STAFF_ACCESS="off";process.env.VALOPAY_RUNTIME_ISOLATION="off";
process.env.VALOPAY_PAYLOAD_ENCRYPTION="kms";
process.env.VALOPAY_KMS_KEY="projects/synthetic-integration/locations/global/keyRings/fixture/cryptoKeys/v1";
const {pool}=await import("@workspace/db");
const {managedWrappingKeys,openPayload}=await import("../src/lib/protected-payloads");
const oldWrap=managedWrappingKeys.wrap,oldUnwrap=managedWrappingKeys.unwrap,master=randomBytes(32);
// Fixture injection is restricted to this test module; runtime keeps its managed KMS adapter.
managedWrappingKeys.wrap=async(_key,data,aad)=>{const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",master,iv);cipher.setAAD(aad);const encrypted=Buffer.concat([cipher.update(data),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);};
managedWrappingKeys.unwrap=async(_key,data,aad)=>{const decipher=createDecipheriv("aes-256-gcm",master,data.subarray(0,12));decipher.setAAD(aad);decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]);};
const {default:router}=await import("../src/routes/index");
const {errorHandler}=await import("../src/lib/error-handler");
const {paystackConnectionTransaction}=await import("../src/lib/paystack-connection");
const {receivePaystackEvent}=await import("../src/providers/paystack-inbox");
const app=express();app.use(express.json({limit:"2mb"}));app.use((req,_res,next)=>{(req as any).auth=Object.assign(()=>({userId:null}),{[Symbol.for("@clerk/express.auth")]:true});(req as any).log={info(){},warn(){},error(){}};next();});app.use("/api",router);app.use(errorHandler);
const server=app.listen(0,"127.0.0.1");await once(server,"listening");
const base=`http://127.0.0.1:${(server.address() as any).port}/api`,cookie=`valopay_sandbox=${randomBytes(32).toString("hex")}`;
const workspaces=new Set<string>();
async function call(path:string,method="GET",body?:unknown,key?:string){const response=await fetch(base+path,{method,headers:{"Content-Type":"application/json",Cookie:cookie,...(key?{"Idempotency-Key":key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};}
const ok=(result:{status:number;data:any})=>{assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
const post=(path:string,body:unknown,key=randomUUID())=>call(path,"POST",body,key);
try{
  for(const name of ["003_pilot_workflow.sql","004_staff_lender_access.sql"])await pool.query(await readFile(new URL(`../../../lib/db/migrations/${name}`,import.meta.url),"utf8"));
  const workspace=ok(await call("/v1/workspace")),lender=workspace.merchants[0].id,other=workspace.merchants[1].id;
  const workspaceId=(await pool.query("SELECT workspace_id FROM valopay_merchants WHERE id=$1",[lender])).rows[0].workspace_id;workspaces.add(workspaceId);
  const at=(days:number)=>new Date(Date.now()-days*86400000).toISOString();
  const source=`controls-${randomUUID()}`;
  const profileInput={name:"Controlled customer feed",source,kind:"customers",mapping:{},identityColumn:"source_row_id",amountUnit:"naira",firstExpectedAt:new Date().toISOString(),cadenceHours:24,graceMinutes:60,expectedRows:2,expectedAmountKobo:0,status:"active",syntheticOnly:true};
  const profile=ok(await post(`/v1/sources/profiles?merchantId=${lender}`,profileInput));
  const batchInput={name:"Protected source batch",source,sourceBatchId:"controls-001",kind:"customers",csv:"source_row_id,name,reference,consentProvenance\nrow-1,Synthetic controls customer,CONTROLS-C-001,Synthetic consent",mapping:{},identityColumn:"source_row_id",amountUnit:"naira",syntheticOnly:true};
  let batch=ok(await post(`/v1/pilot/batches?merchantId=${lender}`,batchInput));
  assert.equal(batch.data.sourceQuality.status,"needs_review");
  assert.equal((await post(`/v1/pilot/batches/${batch.id}/commit?merchantId=${lender}`,{expectedUpdatedAt:batch.updatedAt})).status,409);
  assert.equal((await post(`/v1/sources/profiles/${profile.id}/save?merchantId=${other}`,{...profileInput,expectedRows:1,expectedUpdatedAt:profile.updatedAt})).status,404);
  ok(await post(`/v1/sources/profiles/${profile.id}/save?merchantId=${lender}`,{...profileInput,expectedRows:1,expectedUpdatedAt:profile.updatedAt}));
  batch=ok(await post(`/v1/pilot/batches/${batch.id}/save?merchantId=${lender}`,{...batchInput,expectedUpdatedAt:batch.updatedAt}));
  batch=ok(await post(`/v1/pilot/batches/${batch.id}/commit?merchantId=${lender}`,{expectedUpdatedAt:batch.updatedAt}));
  assert.equal(batch.status,"committed");assert.equal(batch.data.sourceQuality.importedRows,1);
  const encryptedBatch=(await pool.query("SELECT data FROM valopay_records WHERE id=$1 AND merchant_id=$2",[batch.id,lender])).rows[0].data;
  assert.equal(encryptedBatch.csv.protectedPayload,1);assert.equal(encryptedBatch.check.protectedPayload,1);assert.equal(JSON.stringify(encryptedBatch).includes("Synthetic controls customer"),false);
  assert.equal(await openPayload(encryptedBatch.csv,{lender,record:batch.id,field:"csv"},managedWrappingKeys),batchInput.csv);
  await assert.rejects(()=>openPayload(encryptedBatch.csv,{lender:other,record:batch.id,field:"csv"},managedWrappingKeys));

  const customerPath=`/v1/records/customers?merchantId=${lender}`,customerKey=randomUUID(),customerBody={name:"Retention request fixture",reference:`RETAIN-${randomUUID()}`,data:{consentProvenance:"Synthetic retention consent"}};
  const customer=ok(await post(customerPath,customerBody,customerKey));
  const completed=(await pool.query("SELECT * FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,customerKey])).rows[0];
  assert.equal(completed.request.protectedPayload,1);assert.equal(completed.receipt.protectedPayload,1);
  const idempotent=(await pool.query("SELECT * FROM valopay_idempotency WHERE merchant_id=$1 AND response->>'protectedPayload'='1'",[lender])).rows;
  assert.ok(idempotent.length>0);
  const pendingKey=randomUUID(),cancelledKey=randomUUID();
  assert.equal((await post(customerPath,{name:"Missing consent"},pendingKey)).status,400);
  assert.equal((await post(customerPath,{name:"Cancelled missing consent"},cancelledKey)).status,400);
  const pending=(await pool.query("SELECT * FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,pendingKey])).rows[0];
  const cancelled=(await pool.query("SELECT * FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,cancelledKey])).rows[0];
  // A definitive refusal closes the entry with its protected reason; it no longer counts as pending.
  assert.equal(pending.status,"cancelled");assert.equal(cancelled.status,"cancelled");
  assert.equal(pending.receipt.protectedPayload,1);
  assert.equal((await openPayload(pending.receipt,{lender,record:pending.id,field:"receipt"},managedWrappingKeys)).rejected.status,400);
  // Reopen one entry as pending: a request whose outcome never came back (a crash before completion).
  await pool.query("UPDATE valopay_operations SET status='pending',receipt=NULL WHERE merchant_id=$1 AND id=$2",[lender,pending.id]);
  // Pending entries are limited per person and lender; closed ones do not count towards the limit.
  await pool.query("INSERT INTO valopay_operations(id,merchant_id,owner,actor,role,request_key,request_hash,request,label) SELECT 'cap-'||i,$1,$2,$3,$4,'cap-key-'||i,'cap-hash','{}','Cap fixture' FROM generate_series(1,99) i",[lender,pending.owner,pending.actor,pending.role]);
  const capped=await post(customerPath,{name:"Beyond the pending limit"});
  assert.equal(capped.status,409);assert.match(String((capped.data as {error?:string}).error),/pending operations/);
  await pool.query("UPDATE valopay_operations SET status='cancelled' WHERE merchant_id=$1 AND id LIKE 'cap-%'",[lender]);
  assert.equal((await post(customerPath,{name:"Beyond the pending limit"})).status,400,"Closed entries free the limit; the request is then refused on its own merits.");
  await pool.query("DELETE FROM valopay_operations WHERE merchant_id=$1 AND (id LIKE 'cap-%' OR label='Save records customers' AND status='cancelled' AND id<>$2)",[lender,cancelled.id]);
  ok(await post(`/v1/operations/${cancelled.id}/cancel?merchantId=${lender}`,{}));
  await pool.query("UPDATE valopay_operations SET updated_at=$3::timestamptz WHERE merchant_id=$1 AND id=ANY($2::text[])",[lender,[completed.id,cancelled.id,pending.id],at(30)]);
  await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{committedAt}',to_jsonb($3::text)),updated_at=$3::timestamptz WHERE id=$1 AND merchant_id=$2",[batch.id,lender,at(30)]);
  let lifecycle=ok(await call(`/v1/lifecycle?merchantId=${lender}`));
  lifecycle=ok(await post(`/v1/lifecycle/policy?merchantId=${lender}`,{policy:{rawCsvDays:1,journalPayloadDays:1,exportFileDays:null,auditTrail:"retain"},expectedRevision:lifecycle.policyRevision,reason:"Synthetic retention integration rehearsal"}));
  lifecycle=ok(await post(`/v1/lifecycle/holds?merchantId=${lender}`,{kind:"raw_csv",sourceId:batch.id,held:true,expectedHoldRevision:lifecycle.holdRevision,reason:"Preserve raw source while journal tests run"}));
  assert.equal(lifecycle.targets.some((target:any)=>target.sourceId===pending.id),false);
  let run=ok(await post(`/v1/lifecycle/runs?merchantId=${lender}`,{expectedPolicyRevision:lifecycle.policyRevision}));
  assert.deepEqual(new Set(run.candidates.map((candidate:any)=>candidate.sourceId)),new Set([completed.id,cancelled.id]));
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/approve?merchantId=${lender}`,{expectedUpdatedAt:run.updatedAt,previewDigest:run.previewDigest,reason:"Approve exact synthetic journal cleanup"}));
  const firstCandidate=run.candidates[0];
  lifecycle=ok(await call(`/v1/lifecycle?merchantId=${lender}`));
  lifecycle=ok(await post(`/v1/lifecycle/holds?merchantId=${lender}`,{kind:"journal_payload",sourceId:firstCandidate.sourceId,held:true,expectedHoldRevision:lifecycle.holdRevision,reason:"Hold added after approval must block deletion"}));
  const blocked=ok(await post(`/v1/lifecycle/runs/${run.id}/execute?merchantId=${lender}`,{previewDigest:run.previewDigest}));
  assert.equal(blocked.status,"attention");assert.equal(blocked.receipts[0].status,"blocked");
  lifecycle=ok(await post(`/v1/lifecycle/holds?merchantId=${lender}`,{kind:"journal_payload",sourceId:firstCandidate.sourceId,held:false,expectedHoldRevision:lifecycle.holdRevision,reason:"Release hold for checked synthetic cleanup"}));
  const stale=ok(await post(`/v1/lifecycle/runs?merchantId=${lender}`,{expectedPolicyRevision:lifecycle.policyRevision}));
  await pool.query("UPDATE valopay_operations SET updated_at=$3::timestamptz WHERE merchant_id=$1 AND id=$2",[lender,completed.id,at(31)]);
  assert.equal((await post(`/v1/lifecycle/runs/${stale.id}/approve?merchantId=${lender}`,{expectedUpdatedAt:stale.updatedAt,previewDigest:stale.previewDigest,reason:"A stale inventory must not be approved"})).status,409);
  run=ok(await post(`/v1/lifecycle/runs?merchantId=${lender}`,{expectedPolicyRevision:lifecycle.policyRevision}));
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/approve?merchantId=${lender}`,{expectedUpdatedAt:run.updatedAt,previewDigest:run.previewDigest,reason:"Approve current exact source inventory"}));
  for(let count=0;count<4&&run.status!=="completed";count++)run=ok(await post(`/v1/lifecycle/runs/${run.id}/execute?merchantId=${lender}`,{previewDigest:run.previewDigest}));
  assert.equal(run.status,"completed");assert.equal(run.successful,2);
  const retained=(await pool.query("SELECT id,status,request,receipt FROM valopay_operations WHERE merchant_id=$1 AND id=ANY($2::text[])",[lender,[completed.id,cancelled.id,pending.id]])).rows;
  assert.equal(retained.find((r:any)=>r.id===completed.id).request.purged,true);
  assert.equal(retained.find((r:any)=>r.id===cancelled.id).status,"cancelled");
  assert.equal(retained.find((r:any)=>r.id===cancelled.id).request.purged,true);
  assert.equal(retained.find((r:any)=>r.id===pending.id).status,"pending");
  assert.equal(retained.find((r:any)=>r.id===pending.id).request.protectedPayload,1);
  assert.equal((await post(customerPath,customerBody,customerKey)).status,410);
  assert.equal((await post(`/v1/operations/${completed.id}/retry?merchantId=${lender}`,{})).status,410);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND reference=$2 AND kind='customers'",[lender,customerBody.reference])).rows[0].n),1);
  assert.equal((await post(customerPath,{name:"Cancelled missing consent"},cancelledKey)).status,409);
  lifecycle=ok(await call(`/v1/lifecycle?merchantId=${lender}`));
  lifecycle=ok(await post(`/v1/lifecycle/holds?merchantId=${lender}`,{kind:"raw_csv",sourceId:batch.id,held:false,expectedHoldRevision:lifecycle.holdRevision,reason:"Source records retained; release original CSV"}));
  run=ok(await post(`/v1/lifecycle/runs?merchantId=${lender}`,{expectedPolicyRevision:lifecycle.policyRevision}));
  assert.equal(run.candidates.length,1);assert.equal(run.candidates[0].kind,"raw_csv");
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/approve?merchantId=${lender}`,{expectedUpdatedAt:run.updatedAt,previewDigest:run.previewDigest,reason:"Approve erasure of the exact source file"}));
  run=ok(await post(`/v1/lifecycle/runs/${run.id}/execute?merchantId=${lender}`,{previewDigest:run.previewDigest}));
  assert.equal(run.status,"completed");
  const purgedBatch=(await pool.query("SELECT data FROM valopay_records WHERE id=$1",[batch.id])).rows[0].data;
  assert.equal("csv" in purgedBatch,false);assert.equal(purgedBatch.rawCsvRetentionRunId,run.id);
  assert.ok((await pool.query("SELECT 1 FROM valopay_records WHERE id=$1 AND kind='customers'",[customer.id])).rows[0]);

  // Real repository callback, server-owned tenant map and durable test event receipt. No provider HTTP call.
  await pool.query("UPDATE valopay_merchants SET info=jsonb_set(jsonb_set(info,'{killSwitch}','true'::jsonb),'{mode}','\"observation\"'::jsonb) WHERE id=$1",[lender]);
  process.env.VALOPAY_PAYSTACK_INGRESS="test";process.env.PAYSTACK_TEST_SECRET_KEY=["sk","test","OFFLINE","0".repeat(20)].join("_");
  const connectionId=randomBytes(32).toString("hex");
  process.env.VALOPAY_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId,merchantId:lender}});
  const event={kind:"payment" as const,event:"charge.success" as const,dedupeKey:"paystack:test:charge.success:90210",payment:{provider:"paystack" as const,domain:"test" as const,transactionId:"90210",reference:"SYNTHETIC-MAPPED-001",amountKobo:2500,currency:"NGN" as const,state:"succeeded" as const,channel:"direct_debit"}};
  const ingest=()=>paystackConnectionTransaction(connectionId,({state,context})=>receivePaystackEvent(state,context,event,{connectionId,mode:"test"}));
  const receipt=await ingest(),duplicate=await ingest();assert.equal(receipt.event.id,duplicate.event.id);assert.equal(duplicate.duplicate,true);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[lender])).rows[0].n),1);
  await assert.rejects(()=>paystackConnectionTransaction("f".repeat(64),()=>true),/not found/);
  process.env.VALOPAY_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId:"wrong-workspace",merchantId:lender}});
  await assert.rejects(ingest,/unavailable/);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[other])).rows[0].n),0);
  console.log("Operations controls PostgreSQL integration passed: source checks, encrypted payloads, holds/stale previews, verified retention receipts, preserved request tombstones and mapped Paystack test receipts.");
}finally{
  managedWrappingKeys.wrap=oldWrap;managedWrappingKeys.unwrap=oldUnwrap;master.fill(0);
  for(const name of environmentNames){const value=previousEnvironment[name];if(value===undefined)delete process.env[name];else process.env[name]=value;}
  server.close();await once(server,"close");
  for(const workspaceId of workspaces){await pool.query("DELETE FROM valopay_idempotency WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",[workspaceId]);await pool.query("DELETE FROM valopay_records WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",[workspaceId]);await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1",[workspaceId]);await pool.query("DELETE FROM valopay_workspaces WHERE id=$1",[workspaceId]);}
  await pool.end();
}
