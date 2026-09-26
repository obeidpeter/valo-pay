// Exercise the exact CommonJS v4 call made by Storage's gaxios 6 multipart path.
// No GCP account, credentials or network access is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const storageRequire = createRequire(require.resolve('@google-cloud/storage'));
const gaxiosPath = storageRequire.resolve('gaxios');
const gaxiosRequire = createRequire(gaxiosPath);
assert.equal(gaxiosRequire('uuid/package.json').version,'11.1.1');
const { Gaxios } = storageRequire('gaxios');
const boundaries:string[]=[];
for(let n=0;n<2;n++) {
  const result=await new Gaxios().request({url:'https://storage.invalid/upload',method:'POST',multipart:[{headers:{'Content-Type':'application/json'},content:'{"name":"synthetic"}'},{headers:{'Content-Type':'application/octet-stream'},content:'synthetic bytes'}],adapter:async(config:any)=>{
    const boundary=String(config.headers['Content-Type']).split('boundary=')[1]!;
    assert.match(boundary,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    boundaries.push(boundary);
    const chunks:Buffer[]=[];for await(const chunk of config.body as Readable)chunks.push(Buffer.from(chunk));
    const body=Buffer.concat(chunks).toString();
    assert.ok(body.includes(`--${boundary}`));assert.ok(body.includes('synthetic bytes'));assert.ok(body.includes('"name":"synthetic"'));
    return {data:{ok:true},status:200,statusText:'OK',headers:{},config};
  }});
  assert.equal(result.data.ok,true);
}
assert.notEqual(boundaries[0],boundaries[1]);
console.log('Storage dependency compatibility passed: patched uuid CommonJS v4 generates valid, distinct gaxios multipart boundaries.');
