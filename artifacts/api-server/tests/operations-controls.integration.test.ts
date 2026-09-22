import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHmac } from "node:crypto";
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
// Every opened payload is counted: a forged Paystack delivery must open none.
let unwraps=0;
managedWrappingKeys.unwrap=async(_key,data,aad)=>{unwraps++;const decipher=createDecipheriv("aes-256-gcm",master,data.subarray(0,12));decipher.setAAD(aad);decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]);};
const {default:router}=await import("../src/routes/index");
const {errorHandler}=await import("../src/lib/error-handler");
const {createPaystackIngress}=await import("../src/routes/sources");
const {paystackConnectionTransaction,paystackIngress}=await import("../src/lib/paystack-connection");
const {receivePaystackEvent}=await import("../src/providers/paystack-inbox");
const {runDueCloses}=await import("../src/lib/close-scheduler");
// The Paystack test ingress reads its own raw body, so it is mounted before JSON parsing, as in app.ts.
const app=express();app.use((req,_res,next)=>{(req as any).log={info(){},warn(){},error(){}};next();});app.use("/api",createPaystackIngress(paystackIngress));
app.use(express.json({limit:"2mb"}));app.use((req,_res,next)=>{(req as any).auth=Object.assign(()=>({userId:null}),{[Symbol.for("@clerk/express.auth")]:true});next();});app.use("/api",router);app.use(errorHandler);
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
  // Sources opens the rows of a batch not yet committed, so its checks are real, not "unavailable".
  assert.equal(ok(await call(`/v1/sources?merchantId=${lender}`)).batches.find((item:any)=>item.id===batch.id).quality.status,"needs_review");
  assert.equal((await post(`/v1/pilot/batches/${batch.id}/commit?merchantId=${lender}`,{expectedUpdatedAt:batch.updatedAt})).status,409);
  assert.equal((await post(`/v1/sources/profiles/${profile.id}/save?merchantId=${other}`,{...profileInput,expectedRows:1,expectedUpdatedAt:profile.updatedAt})).status,404);
  ok(await post(`/v1/sources/profiles/${profile.id}/save?merchantId=${lender}`,{...profileInput,expectedRows:1,expectedUpdatedAt:profile.updatedAt}));
  batch=ok(await post(`/v1/pilot/batches/${batch.id}/save?merchantId=${lender}`,{...batchInput,expectedUpdatedAt:batch.updatedAt}));
  batch=ok(await post(`/v1/pilot/batches/${batch.id}/commit?merchantId=${lender}`,{expectedUpdatedAt:batch.updatedAt}));
  assert.equal(batch.status,"committed");assert.equal(batch.data.sourceQuality.importedRows,1);
  const encryptedBatch=(await pool.query("SELECT data FROM valopay_records WHERE id=$1 AND merchant_id=$2",[batch.id,lender])).rows[0].data;
  assert.equal(encryptedBatch.csv.protectedPayload,1);assert.equal(encryptedBatch.check.protectedPayload,1);assert.equal(JSON.stringify(encryptedBatch).includes("Synthetic controls customer"),false);
  assert.equal(await openPayload(encryptedBatch.csv,{lender,record:batch.id,field:"csv"},managedWrappingKeys),batchInput.csv);
  assert.ok(unwraps>0,"the fixture counts every payload it opens");
  await assert.rejects(()=>openPayload(encryptedBatch.csv,{lender:other,record:batch.id,field:"csv"},managedWrappingKeys));
  // Only a view that shows or uses the raw source rows opens them. Overviews,
  // lists, unrelated saves and the scheduled close make no key-service call, so
  // they keep working while the key service is down.
  const fixtureUnwrap=managedWrappingKeys.unwrap;let unwraps=0;
  managedWrappingKeys.unwrap=async(...args)=>{unwraps++;return fixtureUnwrap(...args);};
  try{
    for(const path of ["/v1/overview","/v1/work","/v1/pilot/journey","/v1/pilot/progress","/v1/pilot/batches"]){unwraps=0;ok(await call(`${path}?merchantId=${lender}`));assert.equal(unwraps,0,`${path} opens no protected payload`);}
    const listed=ok(await call(`/v1/pilot/batches?merchantId=${lender}`)).items.find((item:any)=>item.id===batch.id);
    assert.deepEqual(listed.data.check,{valid:1,invalid:0,imported:1,skipped:0},"the list's counts come from the stored check summary");
    unwraps=0;const detail=ok(await call(`/v1/pilot/batches/${batch.id}?merchantId=${lender}`));
    assert.equal(unwraps,2,"a batch's detail opens its own rows and check");assert.equal(detail.batch.data.csv,batchInput.csv);assert.equal(detail.batch.data.check.imported,1);
    unwraps=0;ok(await post(`/v1/records/customers?merchantId=${lender}`,{name:"Unrelated keyed save",reference:`UNRELATED-${randomUUID()}`,data:{consentProvenance:"Synthetic consent"}}));
    assert.equal(unwraps,0,"an unrelated keyed save opens no source rows");
    managedWrappingKeys.unwrap=async()=>{unwraps++;throw new Error("key service unavailable");};
    unwraps=0;
    ok(await call(`/v1/overview?merchantId=${lender}`));ok(await call(`/v1/pilot/batches?merchantId=${lender}`));
    // The oldest cursor, so this lender is first in the scheduler's batch.
    await pool.query("UPDATE valopay_merchants SET settings=settings||'{\"nextCloseAt\":\"2000-01-01T00:00:00.000Z\"}'::jsonb WHERE id=$1",[lender]);
    const closes=await runDueCloses({batchSize:25});
    assert.deepEqual(closes.failed.filter(failure=>failure.merchantId===lender),[],"the scheduled close does not need the key service");
    assert.ok(closes.closed.some(closed=>closed.merchantId===lender),"the scheduled close ran during the outage");
    assert.equal(unwraps,0);
    const unavailable=await call(`/v1/pilot/batches/${batch.id}?merchantId=${lender}`);
    assert.equal(unavailable.status,503,"a view that needs the rows fails closed");assert.match(String((unavailable.data as {error?:string}).error),/Protected data cannot be opened/);
  }finally{managedWrappingKeys.unwrap=fixtureUnwrap;}

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
  // A key-service outage inside the business transaction: nothing is saved, the
  // answer keeps its 503 and says so, and the journal entry closes instead of
  // waiting as unconfirmed. The journal's own request and refusal are sealed.
  const workingWrap=managedWrappingKeys.wrap;let wraps=0;
  managedWrappingKeys.wrap=async(...args)=>{if(++wraps===2)throw Object.assign(new Error("Protected data cannot be opened. Ask the administrator to check the configured encryption key."),{status:503});return workingWrap(...args);};
  const outageKey=randomUUID(),outageName=`Outage customer ${randomUUID()}`;
  const outage=await post(customerPath,{name:outageName,reference:`OUTAGE-${randomUUID()}`,data:{consentProvenance:"Synthetic outage consent"}},outageKey);
  managedWrappingKeys.wrap=workingWrap;
  assert.equal(outage.status,503,"an unavailable key service is not flattened to a general 500");
  const outageBody=outage.data as {committed?:unknown;error?:string};
  assert.equal(outageBody.committed,false,"the answer says nothing was saved");
  assert.match(String(outageBody.error),/Protected data cannot be opened/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM valopay_records WHERE merchant_id=$1 AND name=$2",[lender,outageName])).rows[0].count,0);
  const outageEntry=(await pool.query("SELECT status,receipt FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,outageKey])).rows[0];
  assert.equal(outageEntry.status,"cancelled","a request that saved nothing closes its journal entry");
  assert.equal((await openPayload(outageEntry.receipt,{lender,record:(await pool.query("SELECT id FROM valopay_operations WHERE merchant_id=$1 AND request_key=$2",[lender,outageKey])).rows[0].id,field:"receipt"},managedWrappingKeys)).rejected.status,503);
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
  assert.equal(purgedBatch.check.protectedPayload,1,"the check, opened for the retention run, is sealed again when saved");
  assert.equal("preview" in await openPayload(purgedBatch.check,{lender,record:batch.id,field:"check"},managedWrappingKeys),false);
  assert.ok((await pool.query("SELECT 1 FROM valopay_records WHERE id=$1 AND kind='customers'",[customer.id])).rows[0]);

  // Real repository callback, server-owned tenant map and durable test event receipt. No provider HTTP call.
  // One more protected batch, so that loading the lender has payloads to open.
  ok(await post(`/v1/pilot/batches?merchantId=${lender}`,{...batchInput,name:"Protected batch for the ingress",sourceBatchId:"controls-002"}));
  await pool.query("UPDATE valopay_merchants SET info=jsonb_set(jsonb_set(info,'{killSwitch}','true'::jsonb),'{mode}','\"observation\"'::jsonb) WHERE id=$1",[lender]);
  process.env.VALOPAY_PAYSTACK_INGRESS="test";process.env.PAYSTACK_TEST_SECRET_KEY=["sk","test","OFFLINE","0".repeat(20)].join("_");
  const connectionId=randomBytes(32).toString("hex");
  process.env.VALOPAY_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId,merchantId:lender}});
  const event={kind:"payment" as const,event:"charge.success" as const,dedupeKey:"paystack:test:charge.success:90210",payment:{provider:"paystack" as const,domain:"test" as const,transactionId:"90210",reference:"SYNTHETIC-MAPPED-001",amountKobo:2500,currency:"NGN" as const,state:"succeeded" as const,channel:"direct_debit"}};
  const ingest=()=>paystackConnectionTransaction(connectionId,({state,context})=>receivePaystackEvent(state,context,event,{connectionId,mode:"test"}));
  // A test delivery loads the lender without opening its protected source rows, so it is received while the key service is down.
  const workingUnwrap=managedWrappingKeys.unwrap;managedWrappingKeys.unwrap=async()=>{throw new Error("key service unavailable");};
  let receipt:Awaited<ReturnType<typeof ingest>>;try{receipt=await ingest();}finally{managedWrappingKeys.unwrap=workingUnwrap;}
  const duplicate=await ingest();assert.equal(receipt.event.id,duplicate.event.id);assert.equal(duplicate.duplicate,true);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[lender])).rows[0].n),1);
  await assert.rejects(()=>paystackConnectionTransaction("f".repeat(64),()=>true),/not found/);
  // Over HTTP: the signature is checked on the raw bytes before the lender is locked, loaded or decrypted.
  const providerEvents=async()=>Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[lender])).rows[0].n);
  const protectedBatches=Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='import-batches' AND (data->'csv' ? 'protectedPayload' OR data->'check' ? 'protectedPayload')",[lender])).rows[0].n);
  assert.ok(protectedBatches>0,"the lender holds protected payloads a full load would open");
  const signedBody=JSON.stringify({event:"charge.success",data:{domain:"test",id:"90211",status:"success",amount:2500,currency:"NGN",reference:"SYNTHETIC-MAPPED-002",channel:"direct_debit"}});
  const deliver=(signature:string)=>fetch(`${base}/v1/providers/paystack/${connectionId}/events`,{method:"POST",headers:{"Content-Type":"application/json","X-Paystack-Signature":signature},body:signedBody});
  const signed=createHmac("sha512",process.env.PAYSTACK_TEST_SECRET_KEY!).update(signedBody).digest("hex"),forged="f".repeat(128);
  unwraps=0;
  const refused=await deliver(forged);
  assert.equal(refused.status,401);assert.equal(((await refused.json()) as {error:string}).error,"The Paystack webhook signature is invalid.");
  assert.equal(unwraps,0,"a forged delivery opens no protected payload");
  const holder=await pool.connect();
  try{
    await holder.query("BEGIN");await holder.query("SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE",[lender]);
    assert.equal((await deliver(forged)).status,401,"a forged delivery never waits for or reports on the lender lock");
    const busy=await deliver(signed);
    assert.equal(busy.status,503);assert.match(((await busy.json()) as {error:string}).error,/The test lender is busy/);
  }finally{await holder.query("ROLLBACK");holder.release();}
  assert.equal(unwraps,0);assert.equal(await providerEvents(),1,"refused deliveries save nothing");
  const accepted=await deliver(signed);
  assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{accepted:true,duplicate:false});
  assert.equal(await providerEvents(),2,"a verified delivery is saved in the mapped lender's inbox");
  assert.deepEqual(await (await deliver(signed)).json(),{accepted:true,duplicate:true});
  assert.equal(await providerEvents(),2);
  process.env.VALOPAY_PAYSTACK_CONNECTIONS=JSON.stringify({[connectionId]:{workspaceId:"wrong-workspace",merchantId:lender}});
  await assert.rejects(ingest,/unavailable/);
  assert.equal(Number((await pool.query("SELECT count(*) AS n FROM valopay_records WHERE merchant_id=$1 AND kind='provider-events'",[other])).rows[0].n),0);
  console.log("Operations controls PostgreSQL integration passed: source checks, encrypted payloads opened only by the views that need them (overview, lists, saves, the scheduled close and test receipts work while the key service is down), holds/stale previews, verified retention receipts, preserved request tombstones, mapped Paystack test receipts and forged deliveries refused before the lender is locked or decrypted.");
}finally{
  managedWrappingKeys.wrap=oldWrap;managedWrappingKeys.unwrap=oldUnwrap;master.fill(0);
  for(const name of environmentNames){const value=previousEnvironment[name];if(value===undefined)delete process.env[name];else process.env[name]=value;}
  server.close();await once(server,"close");
  for(const workspaceId of workspaces){await pool.query("DELETE FROM valopay_idempotency WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",[workspaceId]);await pool.query("DELETE FROM valopay_records WHERE merchant_id IN(SELECT id FROM valopay_merchants WHERE workspace_id=$1)",[workspaceId]);await pool.query("DELETE FROM valopay_merchants WHERE workspace_id=$1",[workspaceId]);await pool.query("DELETE FROM valopay_workspaces WHERE id=$1",[workspaceId]);}
  await pool.end();
}
