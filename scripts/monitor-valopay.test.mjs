import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkedOrigin, probeService, deliverTransition, sendWebhook, sendEmail } from './monitor-valopay.mjs';

const received = [];
let healthy = true, rejectDelivery = false;
const server = createServer(async (req, res) => {
  if (req.url === '/alerts') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (rejectDelivery) { res.writeHead(503).end(); return; }
    received.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(204).end(); return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/readyz') res.writeHead(healthy ? 200 : 503).end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', checks: { database: { status: healthy ? 'ok' : 'error' } } }));
  else res.end(JSON.stringify({ status: 'ok', scheduler: { state: 'off' } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  assert.throws(() => checkedOrigin(origin));
  const credentialUrl = new URL('https://example.com/'); credentialUrl.username = 'synthetic'; credentialUrl.password = 'synthetic';
  assert.throws(() => checkedOrigin(credentialUrl.toString()));
  assert.throws(() => checkedOrigin('https://example.com/?key=secret'));
  const probe = () => probeService({ origin, allowLocal: true });
  const deliver = event => sendWebhook(`${origin}/alerts`, event, { allowLocal: true });
  let state;
  const tick = async () => { const result = await deliverTransition(await probe(), state, deliver, { owner: 'Synthetic rehearsal operator' }); state = result.state; return result; };
  assert.deepEqual((await probe()).codes, [], 'an intentionally disabled scheduler does not alert');
  assert.equal((await tick()).delivered, false);
  healthy = false;
  assert.equal((await tick()).delivered, false, 'one failed probe is below the threshold');
  rejectDelivery = true;
  await assert.rejects(tick, /Alert delivery failed/);
  assert.equal(state.delivered, '', 'failed delivery must be retried');
  rejectDelivery = false;
  assert.equal((await tick()).delivered, true);
  assert.equal((await tick()).delivered, false, 'an unchanged incident stays quiet');
  healthy = true;
  assert.equal((await tick()).delivered, true);
  assert.equal((await tick()).delivered, false);
  assert.deepEqual(received.map(event => event.kind), ['incident', 'recovery']);
  assert.deepEqual(received[0].codes, ['database_unready']);
  assert.deepEqual((await probeService({ origin, expectScheduler: true, allowLocal: true })).codes, ['scheduler_not_running']);
  const now = Date.now();
  const fake = scheduler => async url => new Response(JSON.stringify(url.endsWith('readyz') ? { status: 'ok', checks: { database: { status: 'ok' } } } : { status: 'ok', scheduler }));
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: true, now, fetchImpl: fake({ state: 'running', intervalMs: 1000, lastSuccessAt: new Date(now - 4000).toISOString() }) })).codes, ['scheduler_stale']);
  await assert.rejects(() => sendWebhook(`${origin}/alerts`, {}), /HTTPS/);
  let email;
  await sendEmail(received[0], { apiKey: 'synthetic-secret', from: 'alerts@example.com', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.resend.com/emails'); email = JSON.parse(request.body); return new Response('{}');
  } });
  assert.deepEqual(email.to, ['obeidpeter1@gmail.com']);
  assert.ok(!JSON.stringify(email).includes('synthetic-secret'));
  await assert.rejects(() => sendEmail(received[0], { apiKey: 'synthetic-secret', from: 'alerts@example.com', fetchImpl: async () => { throw new Error('provider secret'); } }), error => !error.message.includes('provider secret'));
  console.log('Operational monitor passed: real local HTTP probe/delivery, incident threshold, no repeat, recovery, failed-delivery retry, scheduler expectation, redacted failures.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
