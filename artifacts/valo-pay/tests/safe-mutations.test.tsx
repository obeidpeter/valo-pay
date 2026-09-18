import { useState } from 'react';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSafePerformAction } from '@/lib/safe-mutations';
import { installFakeApi, type FakeApi } from './fake-api';
import { screen, userEvent, waitFor } from './harness';

let api: FakeApi;
beforeEach(() => { api = installFakeApi(); });
afterEach(() => { cleanup(); api.uninstall(); });

function Action({ action, recordId, merchantId }: { action: string; recordId: string; merchantId: string }) {
  const [reason, setReason] = useState('Synthetic retry check');
  const [session, setSession] = useState(0);
  const mutation = useSafePerformAction(undefined, session);
  return <><input aria-label="Reason" value={reason} onChange={e => setReason(e.target.value)} />
    <button onClick={() => mutation.mutate({ params: { merchantId }, data: { action, recordId, reason, data: { consentEvidence: 'fresh sample consent' } } })}>Submit</button>
    <button onClick={() => { setSession(s => s + 1); mutation.reset(); }}>New form</button>
    {mutation.isError && <p role="alert">Response was lost; retry this submission.</p>}
    {mutation.isSuccess && <p role="status">Completed</p>}</>;
}

describe('safe mutation intentions', () => {
  it.each(['mandate_reissue', 'new_policy_version'])('replays an unchanged %s after a committed response is lost, then gives a new intention a new key', async action => {
    const user = userEvent.setup();
    const record = api.state().records.find(r => action === 'mandate_reissue' ? r.kind === 'mandates' : r.kind === 'policies')!;
    api.mutate(state => { state.records.find(r => r.id === record.id)!.status = action === 'mandate_reissue' ? 'cancelled' : 'approved'; });
    const originalFetch = globalThis.fetch;
    const committed = new Map<string, Response>();
    const keys: string[] = [];
    let loseResponse = true;
    globalThis.fetch = async (input, options) => {
      const key = new Headers(options?.headers).get('Idempotency-Key')!;
      keys.push(key);
      if (committed.has(key)) return committed.get(key)!.clone();
      const response = await originalFetch(input, options);
      if (response.ok) committed.set(key, response.clone());
      if (response.ok && loseResponse) { loseResponse = false; throw new TypeError('Connection dropped after commit'); }
      return response;
    };
    const initial = api.state().records.filter(r => r.kind === record.kind).length;
    render(<QueryClientProvider client={new QueryClient()}><Action action={action} recordId={record.id} merchantId={api.merchantIds[0]!} /></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('alert');
    expect(api.state().records.filter(r => r.kind === record.kind)).toHaveLength(initial + 1);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('status');
    expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(api.state().records.filter(r => r.kind === record.kind)).toHaveLength(initial + 1);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('uses a different key when failed input changes or its form is deliberately reopened', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    globalThis.fetch = async (_input, options) => { keys.push(new Headers(options?.headers).get('Idempotency-Key')!); throw new TypeError('Offline'); };
    render(<QueryClientProvider client={new QueryClient()}><Action action="new_policy_version" recordId="sample-policy" merchantId={api.merchantIds[0]!} /></QueryClientProvider>);
    await user.click(screen.getByRole('button', { name: 'Submit' })); await screen.findByRole('alert');
    await user.type(screen.getByLabelText('Reason'), ' changed');
    await user.click(screen.getByRole('button', { name: 'Submit' })); await screen.findByRole('alert');
    expect(keys[1]).not.toBe(keys[0]);
    await user.click(screen.getByRole('button', { name: 'New form' }));
    await user.click(screen.getByRole('button', { name: 'Submit' })); await screen.findByRole('alert');
    expect(keys[2]).not.toBe(keys[1]);
  });
});
