import assert from 'node:assert/strict';
import { deleteRetainedExport } from '../src/lib/export-download';
process.env.DATABASE_URL||='postgres://unused:unused@127.0.0.1:1/unused';
const {assertFinalState,removeSweptExportFiles,overrideSweptExportRemoval}=await import('../src/lib/valopay-store');
const {seedMerchant}=await import('../src/lib/valopay-seed');
const {makeRecord}=await import('../src/domain/records');
const {saveLifecyclePolicy,lifecyclePolicy,lifecyclePreview,approveLifecycleRun,eraseLifecycleRawCsv,recordLifecycleReceipt}=await import('../src/domain/lifecycle');
const originalFetch=globalThis.fetch;
const file={bucket:{name:'private-bucket'},name:'exports/lender/file?not-a-query.json',storage:{apiEndpoint:'https://storage.googleapis.com',authClient:{getRequestHeaders:async()=>new Headers()}}} as any;
const expected={id:'export-1',merchantId:'lender',checksum:'a'.repeat(64)};
let gets=0,deletes=0,mode='ok';
globalThis.fetch=async(input,options)=>{
 const url=new URL(String(input));assert.equal(url.host,'storage.googleapis.com');assert.ok(url.pathname.includes('%3F'));
 if(options?.method==='DELETE'){deletes++;assert.equal(url.searchParams.get('ifGenerationMatch'),'12345678901234567890');return new Response(null,{status:mode==='changed'?412:204});}
 gets++;return mode==='absent'?new Response(null,{status:404}):new Response(JSON.stringify({generation:'12345678901234567890',metadata:{valopayExportId:mode==='other'?'export-other':expected.id,valopayMerchantId:expected.merchantId,valopayArtifact:JSON.stringify({checksum:mode==='corrupt'?'b'.repeat(64):expected.checksum})}}));
};
try{
 assert.equal(await deleteRetainedExport(file,expected),'deleted');assert.equal(deletes,1);
 mode='absent';assert.equal(await deleteRetainedExport(file,expected),'already_absent');assert.equal(deletes,1);
 for(const scenario of ['other','corrupt']){mode=scenario;await assert.rejects(()=>deleteRetainedExport(file,expected));assert.equal(deletes,1);}
 mode='changed';await assert.rejects(()=>deleteRetainedExport(file,expected),/could not be deleted/);assert.equal(deletes,2);
}finally{globalThis.fetch=originalFetch;}
const state=seedMerchant('retention-lender'),ctx={actor:'Sandbox Admin',role:'Admin',now:'2030-02-02T00:00:00.000Z'};
const batch=makeRecord(state,'import-batches',{status:'committed',createdAt:'2029-01-01T00:00:00.000Z',data:{csv:'SYNTHETIC ONLY',committedAt:'2029-01-01T00:00:00.000Z',check:{preview:[{synthetic:true}]}}});
saveLifecyclePolicy(state,ctx,{policy:{rawCsvDays:30,journalPayloadDays:null,exportFileDays:null,auditTrail:'retain'},expectedRevision:lifecyclePolicy(state).revision,reason:'Synthetic retention rehearsal policy.'});
const preview=lifecyclePreview(state,ctx,{expectedPolicyRevision:lifecyclePolicy(state).revision});
approveLifecycleRun(state,ctx,preview.id,{expectedUpdatedAt:preview.updatedAt,previewDigest:preview.previewDigest,reason:'Reviewed the one exact synthetic source.'});
const snapshot=structuredClone(state),candidate=preview.candidates[0];
eraseLifecycleRawCsv(state,ctx,preview.id,candidate);recordLifecycleReceipt(state,ctx,preview.id,candidate,'deleted','Synthetic raw CSV removed.');
assert.doesNotThrow(()=>assertFinalState(snapshot,state,state.merchant.id,ctx.now));
const forged=structuredClone(snapshot);delete forged.records.find(r=>r.id===batch.id)!.data.csv;
assert.throws(()=>assertFinalState(snapshot,forged,state.merchant.id,ctx.now),/immutable/);
state.records.find(r=>r.id===batch.id)!.name='Unrelated hidden change';
assert.throws(()=>assertFinalState(snapshot,state,state.merchant.id,ctx.now),/immutable/);
// A swept sandbox's export files: one private storage refuses, or one not reached in the time allowed, is named in the log and never fails the sweep.
{
 const tried:string[]=[],lines:Array<Record<string,unknown>>=[];
 const file=(exportId:string,checksum?:string)=>({merchantId:'swept-lender',exportId,bucket:'private-bucket',objectName:`exports/swept-lender/${exportId}.json`,...(checksum?{checksum}:{})});
 const restore=overrideSweptExportRemoval(async swept=>{tried.push(swept.exportId);if(swept.exportId==='refused')throw new Error('Synthetic storage outage');if(swept.exportId==='slow')await new Promise(resolve=>setTimeout(resolve,1200));return 'deleted';});
 try{
  await removeSweptExportFiles([file('ready','a'.repeat(64)),file('refused'),file('slow'),file('late','b'.repeat(64))],{warn:fields=>lines.push(fields as Record<string,unknown>)},1000);
  assert.deepEqual(tried,['ready','refused','slow'],'removals start one at a time until the time allowed is spent');
  assert.deepEqual(lines.map(({err,...fields})=>({...fields,...(err?{err:(err as Error).message}:{})})),[
   {event:'workspace.sweep_file_left',reason:'failed',merchantId:'swept-lender',exportId:'refused',bucket:'private-bucket',objectName:'exports/swept-lender/refused.json',err:'Synthetic storage outage'},
   {event:'workspace.sweep_file_left',reason:'time_limit',merchantId:'swept-lender',exportId:'late',bucket:'private-bucket',objectName:'exports/swept-lender/late.json'},
  ],'each file left is named by its lender, export, bucket and object name');
  await removeSweptExportFiles([file('refused')],{warn:()=>{throw new Error('Synthetic log failure');}});
 }finally{restore();}
}
console.log('Retention storage checks passed: ownership, checksum, generation fence, absent-file retry, narrow immutable-record exception and the files a sandbox sweep leaves.');
