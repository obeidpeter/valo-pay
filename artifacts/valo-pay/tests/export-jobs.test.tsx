import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {installFakeApi,type FakeApi} from './fake-api';
import {renderApp,screen,userEvent,waitFor} from './harness';
let api:FakeApi;
beforeEach(()=>{api=installFakeApi({queuedExports:true});vi.spyOn(window,'open').mockReturnValue(null);});
afterEach(()=>api.uninstall());
describe('saved background exports',()=>{
 it('resumes a queued export after revisiting the page and offers its completed download',async()=>{
  const user=userEvent.setup();
  const view=renderApp('/reports?view=billing');
  await user.click(await screen.findByRole('button',{name:'Export billing CSV'}));
  expect(await screen.findByText('Billing CSV is queued')).toBeTruthy();
  expect(screen.getByText(/You can leave this page/)).toBeTruthy();
  expect(window.open).not.toHaveBeenCalled();
  const job=api.state().records.find(record=>record.kind==='exports')!;
  view.unmount();
  renderApp('/reports?view=billing');
  expect(await screen.findByText('Billing CSV is queued')).toBeTruthy();
  api.mutate(state=>{const record=state.records.find(record=>record.id===job.id)!;record.status='ready';Object.assign(record.data,{checksum:'a'.repeat(64),generatedAt:api.now,byteLength:123});});
  const link=await screen.findByRole('link',{name:'Open billing CSV'},{timeout:5000});
  expect(link.getAttribute('href')).toContain(job.id);
  expect(api.calls.filter(call=>call.path==='/v1/exports'&&call.method==='POST')).toHaveLength(1);
 });
 it('retries a failed saved job using the same id and private object key',async()=>{
  const user=userEvent.setup();renderApp('/evidence');
  await user.click(await screen.findByRole('button',{name:'Export evidence pack'}));
  await screen.findByText('Evidence pack is queued');
  const job=api.state().records.find(record=>record.kind==='exports')!;
  const objectName=job.data.objectName;
  api.mutate(state=>{const record=state.records.find(record=>record.id===job.id)!;record.status='failed';record.data.lastError='Generation could not finish.';});
  await user.click(await screen.findByRole('button',{name:'Retry export'},{timeout:5000}));
  expect(await screen.findByText('Evidence pack is queued')).toBeTruthy();
  expect(api.state().records.filter(record=>record.kind==='exports')).toHaveLength(1);
  expect(api.state().records.find(record=>record.id===job.id)!.data.objectName).toBe(objectName);
  expect(api.calls.some(call=>call.path===`/v1/exports/${job.id}/retry`&&call.method==='POST')).toBe(true);
 });
 it('retains an uncertain queued request and refreshes saved jobs without creating another one',async()=>{
  const user=userEvent.setup();renderApp('/reports?view=billing');
  await user.click(await screen.findByRole('button',{name:'Export billing CSV'}));
  await screen.findByText('Billing CSV is queued');
  const job=api.state().records.find(record=>record.kind==='exports')!;
  api.failNext(new RegExp(`^/v1/exports/${job.id}$`),'offline','GET');
  expect(await screen.findByText(/Saved export status could not be loaded/,{},{timeout:5000})).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Refresh export status'}));
  await waitFor(()=>expect(screen.queryByText(/Saved export status could not be loaded/)).toBeNull());
  expect(screen.getByText('Billing CSV is queued')).toBeTruthy();
  expect(api.calls.filter(call=>call.path==='/v1/exports'&&call.method==='POST')).toHaveLength(1);
 });
});
