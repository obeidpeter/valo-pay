// Disposable PostgreSQL only; no object-storage credentials or external calls.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import type { ExportArtifact, ExportJobStorage } from '../src/lib/export-jobs';
if(process.env.VALOPAY_RUN_INTEGRATION!=='1'){console.log('Set VALOPAY_RUN_INTEGRATION=1 to run durable export database checks.');process.exit(0);}
const {pool}=await import('@workspace/db');
const {inWorkspace,listMerchants,loadState,saveState,appendAudit,verifyAudit}=await import('../src/lib/valopay-store');
const {exportJobRepository:repository}=await import('../src/lib/export-job-store');
const {processExportJob}=await import('../src/lib/export-jobs');
const {overrideDatabaseLimits}=await import('../src/lib/database-limits');
const {auditEntryData}=await import('../src/lib/digests');
const {generateExportArtifact}=await import('../src/lib/valopay-exports');
const {default:express}=await import('express');
const {default:router}=await import('../src/routes/valopay');
const token=randomBytes(32).toString('hex'),foreignToken=randomBytes(32).toString('hex');
const auth=()=>Object.assign(()=>({userId:null}),{[Symbol.for('@clerk/express.auth')]:true});
const request=()=>({headers:{cookie:`valopay_sandbox=${token}`},secure:false,auth:auth()}) as any;
const response=()=>({cookie(){}}) as any;
const oldDirectory=process.env.PRIVATE_OBJECT_DIR;
process.env.PRIVATE_OBJECT_DIR='/private/synthetic-export-tests';
let server:Server|undefined;
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function within<T>(promise:Promise<T>,message='Export held a database lock during storage I/O.',ms=3000){let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]);}finally{clearTimeout(timer!);}}
const objects=new Map<string,{bytes:Buffer;artifact:ExportArtifact}>();
let uploads=0;
const storage:ExportJobStorage={existing:async claim=>objects.get(claim.location.objectName)?.artifact||null,put:async(claim,bytes,artifact)=>{assert.equal(objects.has(claim.location.objectName),false);objects.set(claim.location.objectName,{bytes,artifact});uploads++;}};
try{
 const merchants=await inWorkspace(request(),response(),listMerchants);
 const merchantId=merchants[0]!.id,siblingId=merchants[1]!.id;
 // A loaded state no longer carries the audit chain: the lender's stored entries are read beside it, so every check below walks the whole chain.
 const read=async()=>{const state=await inWorkspace(request(),response(),ctx=>loadState(ctx,merchantId,'share'),'read');const audit=(await pool.query("SELECT id,kind,name,data FROM valopay_records WHERE merchant_id=$1 AND kind='audit'",[merchantId])).rows;return {...state,records:[...state.records,...audit]};};
 const customer=(await read()).records.find(record=>record.kind==='customers')!;
 const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).auth=auth();(req as any).log={info(){}};next();});app.use('/api',router);app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status||500).json({error:error.message}));
 server=await new Promise<Server>(resolve=>{const running=app.listen(0,'127.0.0.1',()=>resolve(running));});
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const api=async(path:string,options:{method?:string;body?:unknown;key?:string;merchant?:string;principal?:string}={})=>{
  const result=await fetch(`http://127.0.0.1:${address.port}/api/v1${path}?merchantId=${options.merchant||merchantId}`,{method:options.method||'GET',headers:{Cookie:`valopay_sandbox=${options.principal||token}`,'Content-Type':'application/json',...(options.key?{'Idempotency-Key':options.key}:{})},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
  return {status:result.status,body:await result.json() as any};
 };
 const input={kind:'dispute-pack',customerId:customer.id,format:'json'};
 const queued=await api('/exports',{method:'POST',body:input,key:'one-export'});
 assert.equal(queued.status,200,JSON.stringify(queued.body));assert.equal(queued.body.status,'queued');
 assert.deepEqual(await api('/exports',{method:'POST',body:input,key:'one-export'}),queued,'lost queue response replays the same saved job');
 assert.equal((await read()).records.filter(record=>record.kind==='exports').length,1);
 const target={merchantId,id:queued.body.id};
 assert.equal((await api(`/exports/${target.id}/download`)).status,409,'unfinished downloads never touch storage');
 for(const path of [`/exports/${target.id}`,`/exports/${target.id}/download`]){
  assert.equal((await api(path,{merchant:siblingId})).status,404);
  assert.equal((await api(path,{principal:foreignToken})).status,404);
 }
 assert.equal((await api(`/exports/${target.id}/retry`,{method:'POST',body:{},merchant:siblingId})).status,404);
 assert.equal(await repository.claim(siblingId,target.id),null);
 const uploaded=gate(),release=gate();
 const running=processExportJob(repository,{...storage,put:async(...args)=>{await storage.put(...args);uploaded.resolve();await release.promise;}},generateExportArtifact,target);
 await within(uploaded.promise);
 try{
  const status=await api(`/exports/${target.id}`);assert.equal(status.body.status,'running');
  assert.equal(await repository.claim(merchantId,target.id),null,'an active lease prevents a duplicate worker');
  const timeline=await api(`/customers/${customer.id}/timeline`);
  const collection=await api('/records/exports');
  for(const payload of [status.body,timeline.body,collection.body]){
   const encoded=JSON.stringify(payload);assert.doesNotMatch(encoded,/objectName|leaseToken|requestedRole|"bucket"/,'public records redact private storage/lease metadata');
  }
  await within(inWorkspace(request(),response(),async ctx=>{const state=await loadState(ctx,merchantId);state.settings.exportDuringUpload=true;appendAudit(state,ctx,'test.concurrent','workspace','Synthetic work proceeds during export upload');await saveState(ctx,state);}));
 }finally{release.resolve();}
 assert.equal(await running,'ready');
 let state=await read();assert.equal(verifyAudit(state).valid,true,'queue/start/concurrent mutation/ready share one valid audit chain');
 assert.equal(state.settings.exportDuringUpload,true);assert.equal(uploads,1);
 const ready=await api(`/exports/${target.id}`);assert.equal(ready.body.status,'ready');assert.match(ready.body.checksum,/^[a-f0-9]{64}$/);
 const readyRetry=await api(`/exports/${target.id}/retry`,{method:'POST',body:{},key:'ready-retry'});assert.equal(readyRetry.body.status,'ready');
 assert.equal(await processExportJob(repository,storage,generateExportArtifact,target),'skipped');

 // Reproduce the observed completion contention: the file and confirming
 // checkpoint are saved, then a brief reader holds the lender share lock.
 // The completion waits for the reader to finish rather than skip the lender.
 const contended=await api('/exports',{method:'POST',body:input,key:'contended-export'});
 const contendedTarget={merchantId,id:contended.body.id},reachedFinish=gate(),releaseCompletion=gate();
 const holder=await pool.connect();let completionCalls=0;
 const beforeContentionUploads=uploads,started=performance.now();
 const completion=processExportJob({...repository,finish:async(claim,artifact)=>{
  completionCalls++;
  if(completionCalls===1){await holder.query('BEGIN');await holder.query('SELECT id FROM valopay_merchants WHERE id=$1 FOR SHARE',[merchantId]);reachedFinish.resolve();await releaseCompletion.promise;}
  return repository.finish(claim,artifact);
 }},storage,generateExportArtifact,contendedTarget);
 try{await within(reachedFinish.promise);releaseCompletion.resolve();await delay(350);await holder.query('COMMIT');}
 finally{releaseCompletion.resolve();await holder.query('ROLLBACK');holder.release();}
 assert.equal(await completion,'ready');assert.equal(completionCalls,1,'the completion waited for the reader instead of skipping the lender');
 assert.ok(performance.now()-started<6000,'brief contention does not wait for the old five-minute lease');
 assert.equal(uploads,beforeContentionUploads+1,'completion retries must never generate a second object');
 const contentionRecord=(await read()).records.find(record=>record.id===contendedTarget.id)!;
 assert.equal(contentionRecord.data.attempts,1);assert.equal(contentionRecord.data.stage,'ready');
 assert.equal([...objects.keys()].filter(key=>key.includes(contendedTarget.id)).length,1);

 // A committed object outlives both a failed completion and a failed failure
 // write. Restart recovery adopts the exact key/bytes after the lease expires.
 const second=await api('/exports',{method:'POST',body:input,key:'second-export'});
 const secondTarget={merchantId,id:second.body.id};
 assert.equal(await processExportJob({...repository,finish:async()=>{throw new Error('Synthetic lost commit');},fail:async()=>{throw new Error('Synthetic database unavailable');}},storage,generateExportArtifact,secondTarget),'failed');
 assert.equal((await api(`/exports/${secondTarget.id}`)).body.status,'running');
 await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE merchant_id=$1 AND id=$2",[merchantId,secondTarget.id]);
 const uploadsBefore=uploads;
 assert.equal(await processExportJob(repository,storage,async()=>{throw new Error('Recovery must adopt the existing file.');},secondTarget),'ready');
 assert.equal(uploads,uploadsBefore);
 state=await read();assert.equal(verifyAudit(state).valid,true);assert.equal(state.records.find(record=>record.id===secondTarget.id)!.data.attempts,2);

 const third=await api('/exports',{method:'POST',body:input,key:'third-export'});
 const thirdTarget={merchantId,id:third.body.id};
 assert.equal(await processExportJob(repository,{existing:async()=>null,put:async()=>{throw new Error('Private provider failure');}},generateExportArtifact,thirdTarget),'failed');
 const failure=await api(`/exports/${thirdTarget.id}`);assert.equal(failure.body.status,'failed');assert.doesNotMatch(failure.body.error,/Private provider/);
 const retried=await api(`/exports/${thirdTarget.id}/retry`,{method:'POST',body:{},key:'retry-third'});assert.equal(retried.status,200,JSON.stringify(retried.body));assert.equal(retried.body.status,'queued');
 assert.deepEqual(await api(`/exports/${thirdTarget.id}/retry`,{method:'POST',body:{},key:'retry-third'}),retried);
 assert.equal(await processExportJob(repository,storage,generateExportArtifact,thirdTarget),'ready');
 state=await read();assert.equal(verifyAudit(state).valid,true,'fail/retry/start/ready append valid sequential audit entries');

 // A stopping worker hands its claim back: queued again with an audit entry,
 // never failed, and the next worker resumes it without waiting for the lease.
 const stopReason=()=>new Error('Export worker is stopping.');
 const blockedUpload=(onUpload:()=>void):ExportJobStorage=>({existing:async()=>null,put:async(_claim,_bytes,_artifact,signal)=>new Promise((_resolve,reject)=>{
  signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});onUpload();
 })});
 const handed=await api('/exports',{method:'POST',body:input,key:'released-export'});
 const handedTarget={merchantId,id:handed.body.id},stop=new AbortController();
 assert.equal(await processExportJob(repository,blockedUpload(()=>stop.abort(stopReason())),generateExportArtifact,handedTarget,{signal:stop.signal}),'released');
 const handedView=(await api(`/exports/${handedTarget.id}`)).body;
 assert.equal(handedView.status,'queued');assert.equal(handedView.stage,'queued');assert.equal(handedView.error,undefined);
 assert.equal(handedView.retryAllowed,false);assert.equal(handedView.stalled,false);assert.equal(handedView.recoveryAt,undefined);
 state=await read();assert.equal(verifyAudit(state).valid,true,'queue/start/release share the lender audit chain');
 const handedActions=()=>state.records.filter(record=>record.kind==='audit'&&record.data.objectId===handedTarget.id).map(record=>record.data.action);
 assert.deepEqual(handedActions().slice(-2),['export.started','export.released']);
 assert.equal(await processExportJob(repository,storage,generateExportArtifact,handedTarget),'ready');
 state=await read();assert.equal(state.records.find(record=>record.id===handedTarget.id)!.data.attempts,2);assert.deepEqual(handedActions().slice(-3),['export.released','export.started','export.ready']);

 // The hand-back is fenced by the lease token: a superseded worker cannot
 // requeue its successor's job.
 const fenced=await api('/exports',{method:'POST',body:input,key:'fenced-release'});
 const staleClaim=(await repository.claim(merchantId,fenced.body.id))!;
 await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE merchant_id=$1 AND id=$2",[merchantId,fenced.body.id]);
 const currentClaim=(await repository.claim(merchantId,fenced.body.id))!;
 assert.equal(await repository.release(staleClaim),'lost');assert.equal((await api(`/exports/${fenced.body.id}`)).body.status,'running');
 assert.equal(await repository.release(currentClaim),'saved');assert.equal((await api(`/exports/${fenced.body.id}`)).body.status,'queued');

 // When the lender stays locked for every attempt, the job is not failed: it
 // keeps its lease and recovers when the lease expires.
 const locked=await api('/exports',{method:'POST',body:input,key:'interrupted-export'});
 const lockedTarget={merchantId,id:locked.body.id},lockedStop=new AbortController(),lockHolder=await pool.connect();
 try{
  const lockAndStop=async()=>{await lockHolder.query('BEGIN');await lockHolder.query('SELECT id FROM valopay_merchants WHERE id=$1 FOR SHARE',[merchantId]);lockedStop.abort(stopReason());};
  assert.equal(await processExportJob(repository,blockedUpload(()=>{void lockAndStop();}),generateExportArtifact,lockedTarget,{signal:lockedStop.signal,backoffMs:0}),'interrupted');
 }finally{await lockHolder.query('ROLLBACK');lockHolder.release();}
 const lockedView=(await api(`/exports/${lockedTarget.id}`)).body;
 assert.equal(lockedView.status,'running');assert.equal(lockedView.error,undefined);assert.ok(lockedView.recoveryAt,'the lease stays for recovery');
 assert.equal(await repository.claim(merchantId,lockedTarget.id),null,'the unexpired lease still holds the job');
 await pool.query("UPDATE valopay_records SET data=jsonb_set(data,'{leaseExpiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE merchant_id=$1 AND id=$2",[merchantId,lockedTarget.id]);
 assert.equal(await processExportJob(repository,storage,generateExportArtifact,lockedTarget),'ready');

 // The worker's stop() takes the same path and logs each hand-back. Both jobs
 // belong to one lender: the worker's two slots take turns at it, so both claims
 // succeed and both hand-backs are written.
 const {startExportWorker}=await import('../src/lib/export-worker');
 const stoppedIds=[await api('/exports',{method:'POST',body:input,key:'stopped-one'}),await api('/exports',{method:'POST',body:input,key:'stopped-two'})].map(queued=>queued.body.id as string);
 let uploading=0,bothUploading!:()=>void;const bothBlocked=new Promise<void>(resolve=>{bothUploading=resolve;});
 const lines:Array<{event:string;status?:string}>=[];
 const worker=startExportWorker({intervalMs:60_000,log:{info:(line:any)=>lines.push(line),error:(line:any)=>lines.push(line)} as any,
  repository:{...repository,candidates:async()=>stoppedIds.map(id=>({merchantId,id}))},storage:blockedUpload(()=>{if(++uploading===2)bothUploading();}),generate:generateExportArtifact});
 try{await within(bothBlocked,'Both exports in the stop() check must reach their uploads.',10_000);}finally{worker.stop();await worker.settle();}
 assert.deepEqual(lines.map(line=>[line.event,line.status]),[['export.job','released'],['export.job','released']]);
 for(const id of stoppedIds){const view=(await api(`/exports/${id}`)).body;assert.equal(view.status,'queued');assert.equal(view.error,undefined);}
 state=await read();assert.equal(verifyAudit(state).valid,true,'released and interrupted attempts keep one valid audit chain');

 // Another writer holds the lender for 4 s just after a claim (a save, or a daily close): the progress write waits
 // for the lender instead of giving up after its retries, so the export finishes in this attempt, never left
 // 'running' under its five-minute lease with Retry unavailable.
 const auditOf=(id:string)=>state.records.filter(record=>record.kind==='audit'&&record.data.objectId===id).sort((a,b)=>a.data.sequence-b.data.sequence);
 const brief=await api('/exports',{method:'POST',body:input,key:'brief-busy'});
 const briefHolder=await pool.connect();let briefHold:Promise<unknown>|undefined;
 try{
  const holdFor=async(ms:number)=>{await briefHolder.query('BEGIN');await briefHolder.query('SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE',[merchantId]);await delay(ms);await briefHolder.query('COMMIT');};
  const outcome=await processExportJob(repository,{...storage,existing:async claim=>{briefHold=holdFor(4000);await delay(100);return storage.existing(claim);}},generateExportArtifact,{merchantId,id:brief.body.id});
  assert.equal(outcome,'ready','a busy moment of 4 s does not strand the export');
 }finally{await briefHold;briefHolder.release();}
 state=await read();
 assert.deepEqual(auditOf(brief.body.id).map(record=>record.data.action),['export.started','export.ready']);
 assert.equal(state.records.find(record=>record.id===brief.body.id)!.data.attempts,1);

 // Held for longer than a progress write waits, the lender gets the claim handed back: the job is queued again at
 // once, with the hand-back in its audit log, and the next look finishes it.
 const restoreLimits=overrideDatabaseLimits({worker:{lockMs:100}});
 const long=await api('/exports',{method:'POST',body:input,key:'long-busy'});
 const longHolder=await pool.connect();let longRelease:Promise<unknown>|undefined;
 try{
  await longHolder.query('BEGIN');
  const outcome=await processExportJob({...repository,release:async(claim,reason)=>{longRelease??=delay(150).then(()=>longHolder.query('COMMIT'));return repository.release(claim,reason);}},
   {...storage,existing:async claim=>{await longHolder.query('SELECT 1 FROM valopay_merchants WHERE id=$1 FOR UPDATE',[merchantId]);return storage.existing(claim);}},generateExportArtifact,{merchantId,id:long.body.id},{backoffMs:0});
  assert.equal(outcome,'requeued');
 }finally{restoreLimits();await (longRelease??longHolder.query('ROLLBACK'));longHolder.release();}
 const longView=(await api(`/exports/${long.body.id}`)).body;
 assert.equal(longView.status,'queued');assert.equal(longView.stage,'queued');assert.equal(longView.recoveryAt,undefined);assert.equal(longView.stalled,false);
 state=await read();
 const handBack=auditOf(long.body.id).at(-1)!;
 assert.equal(handBack.data.action,'export.released');assert.match(handBack.data.summary,/busy/);
 assert.equal(await processExportJob(repository,storage,generateExportArtifact,{merchantId,id:long.body.id}),'ready');

 // Two exports of one lender in one pass: the worker's two slots take turns at the lender instead of the second
 // skipping the first's claim, so both finish in the same pass.
 const pair=[await api('/exports',{method:'POST',body:input,key:'pair-one'}),await api('/exports',{method:'POST',body:input,key:'pair-two'})].map(queuedPair=>({merchantId,id:queuedPair.body.id as string}));
 const {runExportPass}=await import('../src/lib/export-worker');
 assert.deepEqual(await runExportPass({repository:{...repository,candidates:async()=>pair},storage,generate:generateExportArtifact}),['ready','ready']);

 // The audit chain's head is read from the entries since an hour before the job's claim, not from the whole
 // history: 5,000 older entries are left unread, the read examines only this hour's, and the chain stays valid.
 const tail=(await pool.query("SELECT data FROM valopay_records WHERE merchant_id=$1 AND kind='audit' ORDER BY (data->>'sequence')::bigint DESC LIMIT 1",[merchantId])).rows[0]!.data;
 let sequence=Number(tail.sequence),previousHash=String(tail.hash);const history:unknown[]=[];
 for(let index=0;index<5000;index++){
  const at=new Date(Date.now()-3*86_400_000+index*1000).toISOString();
  const data=auditEntryData({sequence:++sequence,actor:'Sandbox Operations',action:'synthetic.history',objectId:randomUUID(),summary:'Synthetic earlier work',changes:{changedRecords:1},previousHash,timestamp:at});
  previousHash=data.hash;history.push({id:randomUUID(),merchantId,kind:'audit',name:data.action,status:'recorded',reference:'',amountKobo:0,customerId:'',data,createdAt:at,updatedAt:at});
 }
 await pool.query(`INSERT INTO valopay_records(id,merchant_id,kind,name,status,reference,amount_kobo,customer_id,data,created_at,updated_at)
  SELECT x.id,x."merchantId",x.kind,x.name,x.status,x.reference,x."amountKobo",x."customerId",x.data,x."createdAt",x."updatedAt"
  FROM jsonb_to_recordset($1::jsonb) AS x(id text,"merchantId" text,kind text,name text,status text,reference text,"amountKobo" bigint,"customerId" text,data jsonb,"createdAt" timestamptz,"updatedAt" timestamptz)`,[JSON.stringify(history)]);
 await pool.query('ANALYZE valopay_records');
 const bounded=await api('/exports',{method:'POST',body:input,key:'bounded-head'});
 const headReads:Array<{text:string;values:unknown[]}>=[];
 const probe=await pool.connect();probe.release();
 const clients=Object.getPrototypeOf(probe) as {query:(this:unknown,...args:any[])=>unknown};
 const query=clients.query;
 clients.query=function(this:unknown,...args:any[]){if(typeof args[0]==='string'&&/kind='audit'/.test(args[0])&&/ORDER BY \(r\.data->>'sequence'\)::bigint DESC LIMIT 1/.test(args[0]))headReads.push({text:args[0],values:args[1]});return query.apply(this,args);};
 try{assert.equal(await processExportJob(repository,storage,generateExportArtifact,{merchantId,id:bounded.body.id}),'ready');}
 finally{clients.query=query;}
 assert.equal(headReads.length,1,'the claim takes the head from the records it loads anyway; the completion reads it once');
 const plan=(await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${headReads[0]!.text}`,headReads[0]!.values)).rows[0]['QUERY PLAN'][0].Plan;
 const scans:Array<{rows:number;removed:number}>=[];
 const walk=(node:any)=>{if(node['Relation Name']==='valopay_records')scans.push({rows:node['Actual Rows'],removed:node['Rows Removed by Filter']??0});for(const child of node.Plans??[])walk(child);};
 walk(plan);
 const recent=Number((await pool.query("SELECT count(*) FROM valopay_records r JOIN valopay_records job ON job.id=$2 WHERE r.merchant_id=$1 AND r.kind='audit' AND r.created_at >= (job.data->>'startedAt')::timestamptz - interval '1 hour'",[merchantId,bounded.body.id])).rows[0].count);
 assert.ok(recent<500,`${recent} entries from this test's hour`);
 assert.ok(scans.length>0&&scans.every(scan=>scan.rows+scan.removed<=recent),`the head read examined ${JSON.stringify(scans)} rows of a chain of over 5,000 entries, ${recent} of them from the hour before the claim`);
 state=await read();assert.equal(verifyAudit(state).valid,true,'busy hand-backs, shared lender turns and bounded head reads keep one valid audit chain');
 console.log('Durable export DB checks passed: queue replay, tenant isolation, private metadata, lock-free upload, audit chain, crash recovery, stable object adoption, retriable failures, hand-back on stop, progress through a busy lender, hand-back when it stays busy, two slots on one lender and a bounded audit head.');
}finally{
 if(oldDirectory===undefined)delete process.env.PRIVATE_OBJECT_DIR;else process.env.PRIVATE_OBJECT_DIR=oldDirectory;
 if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
 await pool.end();
}
