import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { checkedOrigin, probeService, deliverTransition, deliverTest, deliveryConfiguration, monitorArguments, sendWebhook, sendEmail, schedulerExpectation, MissingSetting } from './monitor-valopay.mjs';

const received = [];
let healthy = true, rejectDelivery = false;
const server = createServer(async (req, res) => {
  if (req.url === '/alerts') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (rejectDelivery) { res.writeHead(503).end(); return; }
    received.push(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(204).end(); return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/readyz') res.writeHead(healthy ? 200 : 503).end(JSON.stringify({ status: healthy ? 'ok' : 'degraded', checks: { database: { status: healthy ? 'ok' : 'error' }, schema: { status: 'ok' } } }));
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
  const fake = (scheduler, schema = 'ok') => async url => new Response(JSON.stringify(url.endsWith('readyz') ? { status: 'ok', checks: { database: { status: 'ok' }, schema: { status: schema } } } : { status: 'ok', scheduler }));
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: true, now, fetchImpl: fake({ state: 'running', intervalMs: 1000, lastSuccessAt: new Date(now - 4000).toISOString() }) })).codes, ['scheduler_stale']);
  // A host whose closes run from a scheduled job (VALOPAY_CLOSE_SCHEDULER=external) must say so: reporting off would
  // hide missed closes again, and running would run them in the web instances too.
  assert.deepEqual((await probeService({ origin, expectScheduler: 'external', allowLocal: true })).codes, ['scheduler_not_external'], 'a host reporting off is named');
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'external', now, fetchImpl: fake({ state: 'external', intervalMs: null, ticks: 0, lastTickAt: null, lastRun: null }) })).codes, []);
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ state: 'external', intervalMs: null }) })).codes, ['scheduler_not_running']);
  const running = { state: 'running', intervalMs: 1000, lastSuccessAt: new Date(now).toISOString(), lastRun: { failed: 1 } };
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake(running) })).codes, ['scheduler_close_failed'], 'a successful pass does not hide failed lender closes');
  assert.deepEqual((await probeService({ origin: 'https://example.com', expectScheduler: 'on', now, fetchImpl: fake({ ...running, lastRun: { failed: 0 } }) })).codes, [], 'a later successful pass with work clears the failed-close signal');
  assert.deepEqual((await probeService({ origin: 'https://example.com', now, fetchImpl: fake({ state: 'off' }, 'incomplete') })).codes, ['schema_unready'], 'HTTP 200 and a database connection are not proof the required schema exists');
  const indexes = await probeService({ origin: 'https://example.com', now, fetchImpl: fake({ state: 'off' }, 'indexes_missing') });
  assert.deepEqual(indexes.codes, []);
  assert.deepEqual(indexes.warnings, ['schema_indexes_missing'], 'a missing performance index is visible without turning readiness into an outage');
  assert.equal((await probeService({ origin: 'https://example.com', expectScheduler: 'external', now, fetchImpl: fake({ state: 'external' }) })).observations.schedulerEvidence, 'mode_only');
  assert.deepEqual([undefined, '', 'on', 'ON', 'external', 'External'].map(schedulerExpectation), [false, false, 'on', 'on', 'external', 'external']);
  assert.throws(() => schedulerExpectation('synthetic-typo'), error => error instanceof MissingSetting && !error.message.includes('synthetic-typo'), 'an expectation the monitor does not know stops it, and is not repeated');
  await assert.rejects(() => sendWebhook(`${origin}/alerts`, {}), /HTTPS/);
  let email;
  await assert.rejects(() => sendEmail(received[0], { apiKey: 'synthetic-secret', from: 'alerts@example.com' }), /recipient/);
  await sendEmail(received[0], { apiKey: 'synthetic-secret', from: 'alerts@example.com', to: 'operations@example.test', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.resend.com/emails'); email = JSON.parse(request.body); return new Response('{}');
  } });
  assert.deepEqual(email.to, ['operations@example.test']);
  assert.ok(!JSON.stringify(email).includes('synthetic-secret'));
  const incidentBeforeTest = structuredClone(state);
  const testReceipt = await deliverTest(await probe(), deliver, { owner: 'Synthetic rehearsal operator' });
  assert.equal(received.at(-1).kind, 'test');
  assert.deepEqual(received.at(-1).codes, ['commissioning_test']);
  assert.equal(testReceipt.delivery, 'accepted_by_receiver');
  assert.equal(testReceipt.recipientReceipt, 'unverified');
  assert.equal(testReceipt.incidentState, 'unchanged');
  assert.deepEqual(state, incidentBeforeTest, 'a delivery test cannot clear or create an incident');
  rejectDelivery = true;
  const testProbe = await probe();
  await assert.rejects(() => deliverTest(testProbe, deliver, { owner: 'Synthetic rehearsal operator' }), /Alert delivery failed/);
  rejectDelivery = false;
  await sendEmail(received.at(-1), { apiKey: 'synthetic-secret', from: 'alerts@example.com', to: 'operations@example.test', fetchImpl: async (_url, request) => {
    email = JSON.parse(request.body); return new Response('{}');
  } });
  assert.equal(email.subject, 'Valo Pay: operational alert test');
  assert.match(email.text, /not an incident/);
  assert.match(email.text, /does not prove inbox delivery/);
  assert.throws(() => monitorArguments(['--test-alert']), /requires both/);
  assert.throws(() => monitorArguments(['--deliver', '--deliver']), /repeated/);
  assert.throws(() => monitorArguments(['--test-alert=synthetic-secret']), error => !error.message.includes('synthetic-secret'));
  assert.deepEqual(monitorArguments(['--', '--deliver', '--test-alert']), { deliver: true, testAlert: true });
  assert.equal(deliveryConfiguration({ VALOPAY_MONITOR_OWNER: 'Operator', VALOPAY_MONITOR_ALERT_URL: 'https://alerts.example/receiver' }).status, 'configured');
  assert.equal(deliveryConfiguration({ VALOPAY_MONITOR_OWNER: 'Operator', VALOPAY_MONITOR_ALERT_URL: 'http://alerts.example/receiver' }).status, 'incomplete');
  assert.equal(deliveryConfiguration({ VALOPAY_MONITOR_OWNER: 'Operator', VALOPAY_ALERT_RESEND_KEY: 'synthetic-secret', VALOPAY_ALERT_FROM: 'alerts@example.com', VALOPAY_ALERT_TO: 'operations@example.test' }).status, 'configured');
  await assert.rejects(() => sendEmail(received[0], { apiKey: 'synthetic-secret', from: 'alerts@example.com', to: 'operations@example.test', fetchImpl: async () => { throw new Error('provider secret'); } }), error => !error.message.includes('provider secret'));
  console.log('Operational monitor passed: real local HTTP probe/delivery, incident threshold, no repeat, recovery, failed-delivery retry, close failures, schema readiness, scheduler mode versus execution evidence, explicit labelled delivery tests without incident-state changes, redacted failures.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
