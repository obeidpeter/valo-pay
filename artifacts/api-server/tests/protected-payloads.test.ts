import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sealPayload, openPayload, payloadEncryptionKey, protectStored, protectRecordData, revealRecordsData, managedWrappingKeys, type WrappingKeyProvider } from '../src/lib/protected-payloads';
const key='projects/synthetic/locations/global/keyRings/rehearsal/cryptoKeys/one', key2=key.replace('/one','/two');
const keys=new Map([[key,randomBytes(32)],[key2,randomBytes(32)]]);
// A test-only wrapping provider, never selectable by runtime environment.
const provider:WrappingKeyProvider={async wrap(id,data,aad){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keys.get(id)!,iv);cipher.setAAD(aad);return Buffer.concat([iv,cipher.update(data),cipher.final(),cipher.getAuthTag()]);},async unwrap(id,data,aad){const cipher=createDecipheriv('aes-256-gcm',keys.get(id)!,data.subarray(0,12));cipher.setAAD(aad);cipher.setAuthTag(data.subarray(-16));return Buffer.concat([cipher.update(data.subarray(12,-16)),cipher.final()]);}};
const scope={lender:'synthetic-lender',record:'batch-1',field:'csv'},value='source_id,name\n1,SYNTHETIC ONLY\n'+ 'a'.repeat(100000);
const first=await sealPayload(value,scope,key,provider),second=await sealPayload(value,scope,key,provider);
assert.notDeepEqual(first,second,'fresh data key/nonce every write');
assert.equal(await openPayload(first,scope,provider),value);
assert.ok(!JSON.stringify(first).includes('SYNTHETIC ONLY'));
for(const wrong of [{...scope,lender:'another-lender'},{...scope,record:'batch-2'},{...scope,field:'receipt'}])await assert.rejects(()=>openPayload(first,wrong,provider),/Protected data/);
await assert.rejects(()=>openPayload({...first,ciphertext:Buffer.from('tampered').toString('base64')},scope,provider),/Protected data/);
await assert.rejects(()=>openPayload({...first,wrappedKey:second.wrappedKey},scope,provider),/Protected data/);
const rotated=await sealPayload(await openPayload(first,scope,provider),scope,key2,provider);
assert.equal(await openPayload(rotated,scope,provider),value);
keys.delete(key);
await assert.rejects(()=>openPayload(first,scope,provider),/Protected data/);
assert.equal(await openPayload(rotated,scope,provider),value,'new wrapping key survives withdrawal of old key');
const mode=process.env.VALOPAY_PAYLOAD_ENCRYPTION,configured=process.env.VALOPAY_KMS_KEY;
try {process.env.VALOPAY_PAYLOAD_ENCRYPTION='kms';delete process.env.VALOPAY_KMS_KEY;assert.throws(payloadEncryptionKey,/Protected data/);process.env.VALOPAY_KMS_KEY='https://attacker.invalid/key';assert.throws(payloadEncryptionKey,/Protected data/);process.env.VALOPAY_PAYLOAD_ENCRYPTION='off';assert.equal(payloadEncryptionKey(),undefined);}finally{if(mode===undefined)delete process.env.VALOPAY_PAYLOAD_ENCRYPTION;else process.env.VALOPAY_PAYLOAD_ENCRYPTION=mode;if(configured===undefined)delete process.env.VALOPAY_KMS_KEY;else process.env.VALOPAY_KMS_KEY=configured;}
// Stored batches: a field already sealed is kept as stored, and many batches are
// opened with at most four key-service calls at once, only the fields asked for.
{
  const savedMode=process.env.VALOPAY_PAYLOAD_ENCRYPTION,savedKey=process.env.VALOPAY_KMS_KEY,{wrap,unwrap}=managedWrappingKeys;
  let wraps=0,unwraps=0,inFlight=0,maxInFlight=0,failOn=0,atFailure=-1;
  try{
    process.env.VALOPAY_PAYLOAD_ENCRYPTION='kms';process.env.VALOPAY_KMS_KEY=key2;
    managedWrappingKeys.wrap=async(id,data,aad)=>{wraps++;return provider.wrap(id,data,aad);};
    managedWrappingKeys.unwrap=async(id,data,aad)=>{
      const call=++unwraps;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
      try{await new Promise(resolve=>setTimeout(resolve,5));if(call===failOn){atFailure=unwraps;throw new Error('key service unavailable');}return await provider.unwrap(id,data,aad);}
      finally{inFlight--;}
    };
    const sealedCsv=await protectStored('source_row_id\nr-0',{lender:'synthetic-lender',record:'batch-0',field:'csv'});wraps=0;
    const kept=await protectRecordData({id:'batch-0',merchantId:'synthetic-lender',kind:'import-batches',data:{csv:sealedCsv,check:{valid:1}}});
    assert.deepEqual(kept.csv,sealedCsv,'a sealed field is kept as stored, never sealed again');
    assert.equal(wraps,1,'only the plaintext field is sealed');
    const batches=await Promise.all(Array.from({length:20},async(_,index)=>{const record={id:`batch-${index}`,merchantId:'synthetic-lender',kind:'import-batches',data:{csv:`source_row_id\nr-${index}`,check:{valid:index},name:`Batch ${index}`}};return {...record,data:await protectRecordData(record)};}));
    unwraps=0;maxInFlight=0;
    const opened=await revealRecordsData(batches,['csv','check'],4);
    assert.deepEqual(opened.map(record=>[record.id,record.data.csv,record.data.check.valid,record.data.name]),batches.map((_,index)=>[`batch-${index}`,`source_row_id\nr-${index}`,index,`Batch ${index}`]),'opened in input order, other fields untouched');
    assert.equal(unwraps,40);assert.equal(maxInFlight,4,'at most four key-service calls in flight');
    assert.equal(batches[0]!.data.csv.protectedPayload,1,'the records passed in are not changed');
    unwraps=0;
    const checkOnly=(await revealRecordsData([batches[0]!],['check']))[0]!;
    assert.deepEqual(checkOnly.data.check,{valid:0});assert.equal(checkOnly.data.csv.protectedPayload,1,'a field not asked for stays sealed');assert.equal(unwraps,1);
    unwraps=0;assert.deepEqual(await revealRecordsData(opened),opened,'opened fields cost no key-service call');assert.equal(unwraps,0);
    unwraps=0;failOn=3;
    await assert.rejects(()=>revealRecordsData(batches,['csv','check'],4),/Protected data cannot be opened/);
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(atFailure>0);assert.equal(unwraps,atFailure,'no key-service call starts after one has failed');
  }finally{
    managedWrappingKeys.wrap=wrap;managedWrappingKeys.unwrap=unwrap;
    if(savedMode===undefined)delete process.env.VALOPAY_PAYLOAD_ENCRYPTION;else process.env.VALOPAY_PAYLOAD_ENCRYPTION=savedMode;
    if(savedKey===undefined)delete process.env.VALOPAY_KMS_KEY;else process.env.VALOPAY_KMS_KEY=savedKey;
  }
}
console.log('Protected payload tests passed: large imports, scoped authenticated encryption, corruption, key loss and rotation, sealed fields kept, bounded and selective opening.');
