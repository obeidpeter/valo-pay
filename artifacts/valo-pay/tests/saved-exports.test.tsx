import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderApp, screen, userEvent, waitFor } from './harness';
import { installFakeApi, type FakeApi } from './fake-api';
import { queueExport } from '../../api-server/src/lib/export-jobs';
import { makeRecord } from '../../api-server/src/domain/records';

let api: FakeApi;
beforeEach(() => { api = installFakeApi({ queuedExports: true }); });
afterEach(() => api.uninstall());
function running(stage='confirming', expired=false, kind='customers') {
  return api.mutate((state,ctx)=>{
    const view=queueExport(state,ctx,{kind,format:'json'},'sample/private');
    const job=state.records.find(record=>record.id===view.id)!;
    job.status='running';Object.assign(job.data,{stage,lastProgressAt:ctx.now,leaseToken:'private-token',leaseExpiresAt:new Date(Date.now()+(expired?-1000:60000)).toISOString()});
    return job.id;
  });
}
it('shows saved file confirmation progress and recovers an expired lease using the same job',async()=>{
  const id=running('confirming',true),user=userEvent.setup();renderApp(`/exports?job=${id}`);
  await screen.findByText('File saved · confirming its download receipt');
  await screen.findByText('This export needs a status check');
  expect(screen.queryByRole('link',{name:'Open saved export'})).toBeNull();
  await user.click(screen.getByRole('button',{name:'Recover saved export'}));
  await screen.findByText('Waiting for an export worker');
  expect(api.calls.filter(call=>call.path===`/v1/exports/${id}/retry`&&call.method==='POST')).toHaveLength(1);
  expect(api.calls.filter(call=>call.path==='/v1/exports'&&call.method==='POST')).toHaveLength(0);
  expect(api.state().records.filter(record=>record.kind==='exports')).toHaveLength(1);
  expect(api.state().records.find(record=>record.id===id)!.data.stage).toBe('queued');
});
it('waits for the current worker deadline and gives Read-only users status without retry authority',async()=>{
  // A mandate export: Read-only may download it, where the customer register is for Admin, Finance and Compliance reviewer only.
  const id=running('uploading',false,'mandates');api.mutate(state=>{state.records.find(record=>record.id===id)!.data.lastProgressAt=new Date(Date.now()-180000).toISOString();});
  api.role='Read-only';renderApp(`/exports?job=${id}`);
  await screen.findByText('Saving the private file');
  await screen.findByText(/The current worker can recover until/);
  expect(screen.queryByRole('button',{name:'Recover saved export'})).toBeNull();
  expect(screen.getByText(/Read-only access lets you download existing files/)).toBeTruthy();
});
it('loads an older exact job outside the first history page and never loads a foreign lender job',async()=>{
  const id=running();
  api.mutate(state=>{for(let i=0;i<26;i++)makeRecord(state,'exports',{status:'ready',name:`Recent synthetic ${i}`,createdAt:new Date(Date.now()+i+1000).toISOString(),data:{kind:'customers',format:'json',checksum:'a'.repeat(64),generatedAt:api.now}});});
  const foreign=api.mutate((state,ctx)=>queueExport(state,ctx,{kind:'customers',format:'json'},'sample/private').id,api.merchantIds[1]);
  const view=renderApp(`/exports?job=${id}`);
  await screen.findByText('File saved · confirming its download receipt');
  expect(screen.getByText('1–25 of 27')).toBeTruthy();
  view.unmount();renderApp(`/exports?job=${foreign}`);
  await screen.findByText(/This export was not found in the selected lender/);
  expect(api.calls.filter(call=>call.path===`/v1/exports/${foreign}`)).toHaveLength(0);
});
it.each(['wrong identity','missing status','malformed checksum','foreign download'])('does not offer a download with %s in the status response',async(condition)=>{
  const id=running(),base=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    if(String(input).includes(`/exports/${id}?`))return new Response(JSON.stringify({id:condition==='wrong identity'?'wrong-job':id,status:condition==='missing status'?undefined:'ready',checksum:condition==='malformed checksum'?'undefined':'b'.repeat(64),downloadUrl:condition==='foreign download'?`https://example.invalid/exports/${id}`:`/api/v1/exports/${id}/download?merchantId=${api.merchantIds[0]}`}),{headers:{'content-type':'application/json'}});
    return base(input,init);
  };
  renderApp(`/exports?job=${id}`);
  await screen.findByText(/Saved export status could not be loaded/);
  expect(screen.queryByRole('link',{name:'Open saved export'})).toBeNull();
  await waitFor(()=>expect(api.calls.filter(call=>call.path==='/v1/exports'&&call.method==='POST')).toHaveLength(0));
});
