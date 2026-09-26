// Loopback only: exercise real HTTP streaming, cancellation and quota release.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createBoundedClerkProxy, CLERK_PROXY_PATH } from '../src/middlewares/clerkProxyMiddleware';

process.env.VALOPAY_APP_ORIGINS = 'https://pilot.example';
delete process.env.VALOPAY_STAFF_ACCESS;
let received = 0, cancelled = 0;
const upstream = createServer((req, res) => {
  received++;
  assert.equal(req.headers['clerk-secret-key'], 'synthetic-offline-key');
  assert.equal(req.headers.cookie, '__session=example');
  if (req.url === '/hang') { res.once('close', () => { cancelled++; }); return; }
  if (req.url === '/stream-hang') { res.writeHead(200, { 'content-length': '12' }); res.write('x'); return; }
  if (req.url === '/large') { res.writeHead(200); res.write('x'.repeat(65)); res.end(); return; }
  if (req.url === '/large-known') { res.writeHead(200, { 'content-length': '129' }); res.end('x'.repeat(129)); return; }
  if (req.url === '/reset') { res.writeHead(200); res.write('x'); setImmediate(() => res.destroy()); return; }
  if (req.method === 'POST') { req.resume(); req.on('end', () => res.end('posted')); return; }
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': '120' }); res.end(); return; }
  if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
  if (req.url === '/known') { res.writeHead(200, { 'content-length': '5' }); res.end('asset'); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=b; Secure', 'c=d; Secure'] });
  res.write('{"ok":'); res.end('true}');
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const url = (server: Server) => `http://127.0.0.1:${(server.address() as {port:number}).port}`;
const headers = { Cookie: `__session=example; __Host-valopay_sandbox=${'a'.repeat(64)}; valopay_sandbox=${'b'.repeat(64)}; valo_sandbox=${'c'.repeat(64)}` };
const servers: Server[] = [];
async function serve(limits: Parameters<typeof createBoundedClerkProxy>[1] = {}) {
  const app = express(); app.set('trust proxy', 1);
  app.use(CLERK_PROXY_PATH, createBoundedClerkProxy('synthetic-offline-key', { target: url(upstream), ...limits }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
  return `${url(server)}${CLERK_PROXY_PATH}`;
}
const waitFor = async (condition:()=>boolean) => {
  for(let n=0;n<100&&!condition();n++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(condition(), 'expected upstream lifecycle event');
};
try {
  const base = await serve({limits:{deadlineMs:250,bufferedBytes:64,responseBytes:128,requestBytes:12}});
  const dynamic = await fetch(`${base}/dynamic`, {headers});
  assert.equal(dynamic.status,200); assert.equal(dynamic.headers.get('content-length'),'11');
  assert.deepEqual(dynamic.headers.getSetCookie(),['a=b; Secure','c=d; Secure']);
  assert.equal(await dynamic.text(),'{"ok":true}');
  assert.equal(await (await fetch(`${base}/known`, {headers})).text(),'asset');
  assert.equal((await fetch(`${base}/empty`, {headers})).status,204);
  assert.equal(await (await fetch(`${base}/known`, {headers,method:'HEAD'})).text(),'');
  for(const path of ['/large','/large-known','/reset','/hang']) {
    const reply = await fetch(`${base}${path}`, {headers});
    assert.equal(reply.status,path==='/hang'?504:502,path);
    assert.doesNotMatch(await reply.text(),/synthetic-offline-key|__session|127\.0\.0\.1/);
  }
  const stalled = await fetch(`${base}/stream-hang`, {headers});
  await assert.rejects(stalled.text(),/terminated|aborted/i,'deadline cancels an already-streaming response');
  const before = received;
  const expectation = await new Promise<number>((resolve,reject)=>{
    const req = httpRequest(`${base}/upload`,{method:'POST',headers:{...headers,Expect:'100-continue','Clerk-Secret-Key':'untrusted-header'}},res=>{res.resume();resolve(res.statusCode!);});
    req.on('error',reject);req.end('123');
  });
  assert.equal(expectation,417); assert.equal(received,before,'Expect cannot bypass the proxyReq sanitisation hook');
  assert.equal((await fetch(`${base}/upload`,{headers,method:'POST',body:'x'.repeat(13)})).status,413);
  assert.equal(received,before,'known oversized requests never reach upstream');
  const chunked = await new Promise<number>((resolve,reject)=>{
    const req = httpRequest(`${base}/upload`,{method:'POST',headers},res=>{res.resume();resolve(res.statusCode!);});
    req.on('error',reject); req.write('12345678'); req.end('12345678');
  });
  assert.equal(chunked,413,'chunked requests have the same byte budget');

  const constrained = await serve({limits:{deadlineMs:2000,concurrency:2,networkConcurrency:1}});
  const controller = new AbortController(), seen = received, closed = cancelled;
  const first = fetch(`${constrained}/hang`,{headers,signal:controller.signal}).catch(()=>undefined);
  await waitFor(()=>received>seen);
  const busy = await fetch(`${constrained}/dynamic`,{headers});
  assert.equal(busy.status,429); assert.equal(busy.headers.get('retry-after'),'60');await busy.text();
  assert.equal((await fetch(`${constrained}/dynamic`,{headers:{...headers,'X-Forwarded-For':'192.0.2.7'}})).status,200,'another network has its own slot');
  controller.abort();await first;await waitFor(()=>cancelled>closed);
  assert.equal((await fetch(`${constrained}/dynamic`,{headers})).status,200,'disconnect cancels upstream and releases concurrency');

  const rate = await serve({limits:{requestsPerMinute:2}});
  for(let n=0;n<2;n++)assert.equal((await fetch(`${rate}/known`,{headers})).status,200);
  assert.equal((await fetch(`${rate}/known`,{headers})).status,429);
  assert.equal((await fetch(`${rate}/known`,{headers:{...headers,'X-Forwarded-For':'2001:db8:77::1'}})).status,200);
  assert.equal((await fetch(`${rate}/known`,{headers:{...headers,'X-Forwarded-For':'2001:db8:77::2'}})).status,200);
  assert.equal((await fetch(`${rate}/known`,{headers:{...headers,'X-Forwarded-For':'2001:db8:77::3'}})).status,429,'rotating IPv6 addresses in one /64 does not buy another quota');
  console.log('Clerk proxy budgets passed: faithful bodies/headers, bounded streaming and buffering, request caps, deadlines, disconnect cancellation, quota release and IPv6 network rates.');
} finally {
  await Promise.all([...servers,upstream].map(server=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})));
}
