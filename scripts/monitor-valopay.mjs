import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 256 * 1024;
export function checkedOrigin(value, allowLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS service origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

async function readJson(response) {
  if (!response.ok || !response.body) throw new Error('Unavailable');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw new Error('Oversized response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

/** One probe, no customer records, no log bodies, no provider requests. */
export async function probeService({ origin, expectScheduler = false, fetchImpl = fetch, now = Date.now(), allowLocal = false, timeoutMs = 8000 }) {
  const base = checkedOrigin(origin, allowLocal);
  const get = async path => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try { return await readJson(await fetchImpl(`${base}${path}`, { signal: abort.signal, redirect: 'error', headers: { Accept: 'application/json' } })); }
    finally { clearTimeout(timer); }
  };
  const [health, ready] = await Promise.allSettled([get('/api/healthz'), get('/api/readyz')]);
  const codes = [];
  if (health.status !== 'fulfilled' || health.value?.status !== 'ok') codes.push('service_unavailable');
  if (ready.status !== 'fulfilled' || ready.value?.status !== 'ok' || ready.value?.checks?.database?.status !== 'ok') codes.push('database_unready');
  if (expectScheduler && health.status === 'fulfilled') {
    const scheduler = health.value?.scheduler;
    const interval = Number(scheduler?.intervalMs);
    const successAt = Date.parse(scheduler?.lastSuccessAt || '');
    const failedAt = Date.parse(scheduler?.lastErrorAt || '');
    if (scheduler?.state !== 'running') codes.push('scheduler_not_running');
    else if (!Number.isFinite(interval) || interval <= 0 || !Number.isFinite(successAt) || now - successAt > 3 * interval || successAt > now + interval) codes.push('scheduler_stale');
    else if (Number.isFinite(failedAt) && failedAt >= successAt) codes.push('scheduler_failed');
  }
  return { service: base, observedAt: new Date(now).toISOString(), codes: [...new Set(codes)].sort() };
}

/** Stable incidents suppress repeated delivery; failed delivery never advances state. */
export async function deliverTransition(probe, previous, deliver, { owner, failureThreshold = 2 } = {}) {
  if (!owner?.trim() || !Number.isInteger(failureThreshold) || failureThreshold < 1) throw new Error('An alert owner and positive failure threshold are required.');
  const signature = probe.codes.join('|');
  const previousForService = previous?.service === probe.service ? previous : {};
  const streak = previousForService.pending === signature ? Number(previousForService.streak || 0) + 1 : 1;
  const state = { service: probe.service, pending: signature, streak, delivered: previousForService.delivered || '', observedAt: probe.observedAt };
  if (signature === state.delivered || (signature && streak < failureThreshold)) return { state, delivered: false };
  const event = { version: 1, kind: signature ? 'incident' : 'recovery', owner, ...probe };
  await deliver(event);
  state.delivered = signature;
  return { state, delivered: true };
}

export async function sendWebhook(urlText, event, { fetchImpl = fetch, allowLocal = false, timeoutMs = 8000 } = {}) {
  const url = new URL(urlText);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('The alert receiver must use HTTPS.');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const result = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
    await result.body?.cancel();
    if (!result.ok) throw new Error('Delivery failed');
  } catch { throw new Error('Alert delivery failed; the incident will be retried.'); }
  finally { clearTimeout(timer); }
}

export async function sendEmail(event, { apiKey, from, to = 'obeidpeter1@gmail.com', fetchImpl = fetch, timeoutMs = 8000 }) {
  const address = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
  if (!apiKey || !address.test(from || '') || !address.test(to)) throw new Error('Email delivery needs a configured provider and verified sender.');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: abort.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: `Valo Pay: ${event.kind === 'recovery' ? 'service recovered' : 'operational alert'}`,
        text: `Service: ${event.service}\nChecked: ${event.observedAt}\nState: ${event.kind}\nChecks: ${event.codes.join(', ') || 'healthy'}\nOwner: ${event.owner}\n\nNo customer records or credentials are included. Check the operating runbook before changing service settings.` }) });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Email not accepted');
  } catch { throw new Error('Email delivery was not accepted; the incident will be retried.'); }
  finally { clearTimeout(timer); }
}

async function main() {
  const deliver = process.argv.includes('--deliver');
  if (process.argv.slice(2).some(arg => arg !== '--deliver')) throw new Error('Only --deliver is supported. Configure the origin and receiver in the environment.');
  const origin = process.env.VALOPAY_MONITOR_ORIGIN;
  if (!origin) throw new Error('Set VALOPAY_MONITOR_ORIGIN.');
  const probe = await probeService({ origin, expectScheduler: process.env.VALOPAY_MONITOR_EXPECT_SCHEDULER === 'on' });
  if (!deliver) { console.log(JSON.stringify({ ...probe, mode: 'dry-run', delivery: 'not attempted' })); return; }
  const receiver = process.env.VALOPAY_MONITOR_ALERT_URL;
  const owner = process.env.VALOPAY_MONITOR_OWNER;
  const statePath = process.env.VALOPAY_MONITOR_STATE_FILE;
  const emailKey = process.env.VALOPAY_ALERT_RESEND_KEY;
  const sender = process.env.VALOPAY_ALERT_FROM;
  if ((!receiver && !(emailKey && sender)) || !owner || !statePath) throw new Error('Configure a receiver or email provider, alert owner and monitor state file.');
  const target = resolve(statePath);
  let previous;
  try { previous = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('The monitor state could not be read; refusing to reset incident history.'); }
  const result = await deliverTransition(probe, previous, event => receiver ? sendWebhook(receiver, event) : sendEmail(event, { apiKey: emailKey, from: sender }), { owner });
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.next`;
  await writeFile(temporary, JSON.stringify(result.state), { mode: 0o600 });
  await rename(temporary, target);
  console.log(JSON.stringify({ ...probe, delivered: result.delivered }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Operational monitoring failed. Check configuration, probe connectivity and the alert receiver. Credentials and response bodies are not logged.'); process.exitCode = 1; });
