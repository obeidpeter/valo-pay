// Disposable PostgreSQL only; no object-storage credentials or external calls.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Server } from 'node:http';
import type { ExportArtifact, ExportJobStorage } from '../src/lib/export-jobs';
if(process.env.VALOPAY_RUN_INTEGRATION!=='1'){console.log('Set VALOPAY_RUN_INTEGRATION=1 to run durable export database checks.');process.exit(0);}
const {pool}=await import('@workspace/db');
const {inWorkspace,listMerchants,loadState,saveState,appendAudit,verifyAudit}=await import('../src/lib/valopay-store');
const {exportJobRepository:repository}=await import('../src/lib/export-job-store');
const {processExportJob}=await import('../src/lib/export-jobs');
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
 assert.equal(await completion,'ready');assert.ok(completionCalls>=2,'real SKIP LOCKED contention is retried');
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
 // belong to one lender, so the two hand-backs may contend for its lock and retry.
 // Claims are serialised, and a claim that finds the lender locked (by the other
 // job's progress write) is tried again, only so that both attempts start: the
 // worker itself skips such a job and a later poll picks it up.
 const {startExportWorker}=await import('../src/lib/export-worker');
 const stoppedIds=[await api('/exports',{method:'POST',body:input,key:'stopped-one'}),await api('/exports',{method:'POST',body:input,key:'stopped-two'})].map(queued=>queued.body.id as string);
 let uploading=0,bothUploading!:()=>void;const bothBlocked=new Promise<void>(resolve=>{bothUploading=resolve;});
 const lines:Array<{event:string;status?:string}>=[];
 const claimWhenFree=async(merchant:string,id:string)=>{for(let attempt=0;attempt<50;attempt++){const claimed=await repository.claim(merchant,id);if(claimed)return claimed;await delay(20);}return null;};
 let claims:Promise<unknown>=Promise.resolve();
 const worker=startExportWorker({intervalMs:60_000,log:{info:(line:any)=>lines.push(line),error:(line:any)=>lines.push(line)} as any,
  repository:{...repository,candidates:async()=>stoppedIds.map(id=>({merchantId,id})),claim:(merchant,id)=>{const next=claims.then(()=>claimWhenFree(merchant,id));claims=next.catch(()=>null);return next;}},storage:blockedUpload(()=>{if(++uploading===2)bothUploading();}),generate:generateExportArtifact});
 try{await within(bothBlocked,'Both exports in the stop() check must reach their uploads.',10_000);}finally{worker.stop();await worker.settle();}
 assert.deepEqual(lines.map(line=>[line.event,line.status]),[['export.job','released'],['export.job','released']]);
 for(const id of stoppedIds){const view=(await api(`/exports/${id}`)).body;assert.equal(view.status,'queued');assert.equal(view.error,undefined);}
 state=await read();assert.equal(verifyAudit(state).valid,true,'released and interrupted attempts keep one valid audit chain');
 console.log('Durable export DB checks passed: queue replay, tenant isolation, private metadata, lock-free upload, audit chain, crash recovery, stable object adoption, retriable failures and hand-back on stop.');
}finally{
 if(oldDirectory===undefined)delete process.env.PRIVATE_OBJECT_DIR;else process.env.PRIVATE_OBJECT_DIR=oldDirectory;
 if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
 await pool.end();
}
