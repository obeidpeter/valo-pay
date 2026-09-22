import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sealPayload, openPayload, payloadEncryptionKey, type WrappingKeyProvider } from '../src/lib/protected-payloads';
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
console.log('Protected payload tests passed: large imports, scoped authenticated encryption, corruption, key loss and rotation.');
