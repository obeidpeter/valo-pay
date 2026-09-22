import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { seedMerchant } from '../src/lib/valopay-seed';
import { queueExport, retryExport, exportJobView, exportIsClaimable, processExportJob, EXPORT_LEASE_MS, MAX_EXPORT_BYTES, type ClaimedExport, type ExportArtifact, type ExportJobRepository, type ExportJobStorage } from '../src/lib/export-jobs';
import type { DomainState } from '../src/domain/types';
// Imports initialize the shared pool, but this suite never connects to it.
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
const {generateExportArtifact,exportDescriptor}=await import('../src/lib/valopay-exports');
const {runExportPass}=await import('../src/lib/export-worker');

let checks = 0;
const now = '2026-09-18T10:00:00.000Z';
const ctx = { actor: 'Sandbox Finance', role: 'Finance', now };
const initial = seedMerchant('export-jobs-fixture');
const state: DomainState = initial;
let clock = Date.parse(now), transaction = false, failFinish = false, failFailure = false;
const objects = new Map<string, { bytes: Buffer; artifact: ExportArtifact }>();
let uploads = 0, generations = 0, lostUploadResponse = false, failUpload = false;
const job = queueExport(state, ctx, { kind: 'customers', format: 'json' }, '/private/test');
assert.equal(job.status, 'queued'); assert.equal(objects.size, 0); checks += 2;
// A read-only role downloads existing evidence; it neither queues nor requeues generation.
const readOnly = { ...ctx, role: 'Read-only' };
assert.throws(() => queueExport(state, readOnly, { kind: 'customers', format: 'json' }, '/private/test'), (error: any) => error.status === 403 && /read-only/.test(error.message));
assert.throws(() => retryExport(state, readOnly, job.id), (error: any) => error.status === 403 && /read-only/.test(error.message));
assert.equal(state.records.filter(record => record.kind === 'exports').length, 1); checks += 3;
const repository: ExportJobRepository = {
  async candidates(limit) { return state.records.filter(record => record.kind === 'exports' && exportIsClaimable(record, new Date(clock).toISOString())).slice(0, limit).map(record => ({ merchantId: record.merchantId, id: record.id })); },
  async claim(merchantId, id) {
    transaction = true;
    try {
      const record = state.records.find(record => record.kind === 'exports' && record.id === id && record.merchantId === merchantId);
      if (!record || !exportIsClaimable(record, new Date(clock).toISOString())) return null;
      const token = randomUUID(); record.status = 'running'; Object.assign(record.data, { leaseToken: token, leaseExpiresAt: new Date(clock + EXPORT_LEASE_MS).toISOString(), attempts: Number(record.data.attempts || 0) + 1 });
      return { merchantId, id, token, state: structuredClone(state), context: { ...ctx, now: new Date(clock).toISOString() }, input: { kind: record.data.kind, format: record.data.format }, location: { bucket: record.data.bucket, objectName: record.data.objectName } };
    } finally { transaction = false; }
  },
  async finish(claim, artifact) {
    if (failFinish) throw new Error('Commit failed');
    const record = state.records.find(record => record.id === claim.id)!;
    if (record.data.leaseToken !== claim.token) return false;
    record.status = 'ready'; Object.assign(record.data, artifact); delete record.data.leaseToken; return true;
  },
  async fail(claim, message) {
    if (failFailure) throw new Error('Database unavailable');
    const record = state.records.find(record => record.id === claim.id)!;
    if (record.data.leaseToken !== claim.token) return false;
    record.status = 'failed'; record.data.lastError = message; delete record.data.leaseToken; return true;
  },
};
const storage: ExportJobStorage = {
  async existing(claim) { assert.equal(transaction, false); checks++; return objects.get(claim.location.objectName)?.artifact || null; },
  async put(claim, bytes, artifact) {
    assert.equal(transaction, false); checks++;
    if (failUpload) throw new Error('Private provider detail must not leak');
    assert.equal(objects.has(claim.location.objectName), false); checks++;
    objects.set(claim.location.objectName, { bytes, artifact }); uploads++;
    if (lostUploadResponse) throw new Error('Acknowledgement lost');
  },
};
const generate = async (claim: ClaimedExport) => { assert.equal(transaction, false); checks++; generations++; return generateExportArtifact(claim); };
const target = { merchantId: state.merchant.id, id: job.id };
lostUploadResponse = true;
assert.equal(await processExportJob(repository, storage, generate, target), 'ready'); checks++;
assert.equal(uploads, 1); assert.equal(generations, 1); checks += 2;
const checksum = exportJobView(state.records.find(record => record.id === job.id)!).checksum;
assert.equal(checksum, createHash('sha256').update([...objects.values()][0]!.bytes).digest('hex')); checks++;
assert.equal(await processExportJob(repository, storage, generate, target), 'skipped'); checks++;

// Upload succeeded but final database commit failed. Retry adopts the same immutable bytes and key.
const second = queueExport(state, ctx, { kind: 'customers', format: 'csv' }, '/private/test');
failFinish = true; lostUploadResponse = false;
assert.equal(await processExportJob(repository, storage, generate, { ...target, id: second.id }), 'failed'); checks++;
assert.equal(exportJobView(state.records.find(record => record.id === second.id)!).status, 'failed'); checks++;
retryExport(state, ctx, second.id); failFinish = false;
assert.equal(await processExportJob(repository, storage, generate, { ...target, id: second.id }), 'ready'); checks++;
assert.equal(uploads, 2); assert.equal(generations, 2); checks += 2;

// A process dies after upload and cannot record a failure; another worker recovers only after lease expiry.
const third = queueExport(state, ctx, { kind: 'customers', format: 'json' }, '/private/test');
failFinish = true; failFailure = true;
await processExportJob(repository, storage, generate, { ...target, id: third.id });
assert.equal(await repository.claim(target.merchantId, third.id), null); checks++;
clock += EXPORT_LEASE_MS + 1; failFinish = false; failFailure = false;
assert.equal(await processExportJob(repository, storage, generate, { ...target, id: third.id }), 'ready'); checks++;
assert.equal(uploads, 3); assert.equal(generations, 3); checks += 2;

// Fencing prevents an expired worker from completing over the successor's claim.
const fourth = queueExport(state, ctx, { kind: 'customers', format: 'csv' }, '/private/test');
const old = (await repository.claim(target.merchantId, fourth.id))!;
clock += EXPORT_LEASE_MS + 1;
const newer = (await repository.claim(target.merchantId, fourth.id))!;
assert.notEqual(old.token, newer.token); checks++;
assert.equal(await repository.finish(old, [...objects.values()][0]!.artifact), false); checks++;
assert.equal(await repository.finish(newer, [...objects.values()][0]!.artifact), true); checks++;

const failed = queueExport(state, ctx, { kind: 'customers', format: 'json' }, '/private/test');
failUpload = true;
await processExportJob(repository, storage, generate, { ...target, id: failed.id });
assert.doesNotMatch(exportJobView(state.records.find(record => record.id === failed.id)!).error!, /Private provider/); checks++;
assert.throws(() => exportDescriptor(state, failed.id), (error: any) => error.status === 409); checks++;
assert.throws(() => retryExport({ ...state, records: [] }, ctx, failed.id), (error: any) => error.status === 404); checks++;
assert.throws(() => queueExport(state, ctx, { kind: 'dispute-pack', customerId: 'other-lender-customer', format: 'pdf' }, '/private/test'), (error: any) => error.status === 404); checks++;

// A bounded lookahead prevents a locked lender's old jobs from starving others;
// the consumer pool still runs only two generations/uploads at once.
failUpload = false;
for (let index = 0; index < 4; index++) queueExport(state, ctx, { kind: 'customers', format: 'json' }, '/private/test');
let concurrent = 0, peak = 0;
await runExportPass({ repository, storage, generate: async claim => { concurrent++; peak = Math.max(peak, concurrent); await new Promise(resolve => setTimeout(resolve, 5)); try { return await generate(claim); } finally { concurrent--; } } });
assert.equal(peak, 2); checks++;
assert.ok(MAX_EXPORT_BYTES <= 32 * 1024 * 1024); checks++;
let attempted:string[]=[];
const targets=Array.from({length:5},(_,index)=>({merchantId:target.merchantId,id:`blocked-${index}`}));
await runExportPass({repository:{...repository,candidates:async limit=>{assert.equal(limit,20);return targets;},claim:async(_merchant,id)=>{attempted.push(id);return null;}},storage,generate});
assert.equal(attempted.length,5);checks++;

// A large output is rejected before upload, and an oversized source is rejected
// before rendering. The successful sample records a real byte-generation cost.
const oversized=queueExport(state,ctx,{kind:'customers',format:'json'},'/private/test');
const oversizedTarget={...target,id:oversized.id};
const beforeOversized=uploads;
await processExportJob(repository,storage,async()=>({bytes:Buffer.alloc(MAX_EXPORT_BYTES+1),artifact:[...objects.values()][0]!.artifact}),oversizedTarget);
assert.equal(uploads,beforeOversized);assert.match(exportJobView(state.records.find(r=>r.id===oversized.id)!).error!,/32 MB/);checks+=2;
const volumeState=seedMerchant('volume-fixture');
const template=volumeState.records.find(record=>record.kind==='customers')!;
volumeState.records=Array.from({length:10000},(_,index)=>({...structuredClone(template),id:`volume-${index}`,name:`Synthetic customer ${index}`,reference:`SAMPLE-${index}`}));
const volumeClaim:ClaimedExport={...newer,state:volumeState,input:{kind:'customers',format:'json'}};
const volume=await generateExportArtifact(volumeClaim);
assert.equal(JSON.parse(volume.bytes.toString()).data.length,10000);assert.ok(volume.bytes.length<MAX_EXPORT_BYTES);checks+=2;
volumeState.records[0]!.data.note='x'.repeat(MAX_EXPORT_BYTES+1);
await assert.rejects(generateExportArtifact(volumeClaim),(error:any)=>error.exportTooLarge===true);checks++;
volumeState.records.push({...structuredClone(template),id:'unrelated-large-history',kind:'observations',data:{note:volumeState.records[0]!.data.note}});
delete volumeState.records[0]!.data.note;
assert.equal(JSON.parse((await generateExportArtifact(volumeClaim)).bytes.toString()).data.length,10000,'unrelated lender history does not block a smaller category export');checks++;
const {buildReports}=await import('../src/domain/reports');
const metricsState=seedMerchant('metric-fixture');
const customerId=metricsState.records.find(record=>record.kind==='customers')!.id;
const pendingPack=queueExport(metricsState,ctx,{kind:'dispute-pack',customerId,format:'json'},'/private/test');
const pack=metricsState.records.find(record=>record.id===pendingPack.id)!;
assert.equal(buildReports(metricsState,now).operational.disputePacksGenerated,0);pack.status='failed';assert.equal(buildReports(metricsState,now).operational.packsGenerated,0);pack.status='ready';assert.equal(buildReports(metricsState,now).operational.disputePacksGenerated,1);checks+=3;
console.log(JSON.stringify({benchmark:'synthetic-export-volume',rows:10000,bytes:volume.bytes.length,generationMs:volume.artifact.generationMs,limitBytes:MAX_EXPORT_BYTES}));
console.log(`Export job tests passed (${checks} checks): durable queue, no I/O in a transaction, upload acknowledgement recovery, commit failure, expired leases, fencing, safe failures, tenant denial and two-worker bound.`);
