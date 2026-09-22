import { beforeEach, afterEach, it, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import { installFakeApi, type FakeApi } from "./fake-api";
import { renderApp, screen, userEvent, waitFor } from "./harness";
let api: FakeApi;
beforeEach(()=>{ api=installFakeApi({now:"2026-09-22T08:00:00.000Z"}); });
afterEach(()=>api.uninstall());

it("declares dated source files with control totals and keeps a missing delivery visible",async()=>{
  const user=userEvent.setup();renderApp("/sources?businessDate=2026-09-22");
  await user.click(await screen.findByRole("button",{name:"Add expected file"}));
  await user.type(screen.getByLabelText("Expected file source 1"),"loan-system");
  await user.type(screen.getByLabelText("Expected source batch ID 1"),"customers-2026-09-22");
  await user.clear(screen.getByLabelText("Declared row count 1"));await user.type(screen.getByLabelText("Declared row count 1"),"2");
  await user.type(screen.getByLabelText("Declaration reason"),"The source owner confirmed the complete customer delivery list.");
  await user.type(screen.getByLabelText("Supporting source evidence"),"Source control report CONTROL-22.");
  await user.click(screen.getByRole("button",{name:"Save source declaration"}));
  await screen.findByRole("heading",{name:"Revise the expected source files"});
  expect(screen.getByText("Source file incomplete · customers-2026-09-22")).toBeTruthy();
  expect(screen.getByText(/0 of 1 expected files complete/)).toBeTruthy();
  const manifest=api.state().records.find(record=>record.kind==='source-manifests')!;
  expect(manifest.data.businessDate).toBe("2026-09-22");expect(manifest.data.files[0].expectedRows).toBe(2);
  expect(screen.getByRole("link",{name:"Import expected file"}).getAttribute("href")).toContain("expectation=");
});

it("parses declared naira totals exactly and blocks malformed amounts before submitting",async()=>{
  const user=userEvent.setup();renderApp("/sources?businessDate=2026-09-22");
  await user.click(await screen.findByRole("button",{name:"Add expected file"}));
  await user.type(screen.getByLabelText("Expected file source 1"),"settlement-feed");
  await user.type(screen.getByLabelText("Expected source batch ID 1"),"payments-22");
  await user.selectOptions(screen.getByLabelText("Expected record type 1"),"observations");
  await user.type(screen.getByLabelText("Declaration reason"),"The source control report confirms this expected settlement file.");
  await user.type(screen.getByLabelText("Supporting source evidence"),"Source control report CONTROL-22.");
  const amount=screen.getByLabelText("Declared total (₦) 1");await user.clear(amount);await user.type(amount,"12.345");await user.tab();
  expect(screen.getByRole("alert").textContent).toMatch(/no more than 2 decimal places/);
  await user.click(screen.getByRole("button",{name:"Save source declaration"}));
  expect(api.calls.filter(call=>call.method==='POST'&&call.path==='/v1/sources/manifests')).toHaveLength(0);
  await user.clear(amount);await user.type(amount,"12.50");
  await user.click(screen.getByRole("button",{name:"Save source declaration"}));
  await screen.findByRole("heading",{name:"Revise the expected source files"});
  expect(api.state().records.find(record=>record.kind==='source-manifests')!.data.files[0].expectedAmountKobo).toBe(1250);
  expect((screen.getByLabelText("Declared total (₦) 1") as HTMLInputElement).value).toBe("12.50");
});

it("reuses a saved source mapping and opens its committed batch from a direct link",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await user.type(await screen.findByLabelText("Profile name"),"Pilot loan feed");
  await user.type(screen.getByLabelText("Source name"),"synthetic-lms");
  await user.type(screen.getByLabelText("Expected source rows (optional)"),"1");
  await user.click(screen.getByRole("button",{name:"Save source profile"}));
  await screen.findByRole("button",{name:"Edit Pilot loan feed"});
  const profile=api.state().records.find(r=>r.kind==='source-profiles')!;
  cleanup();renderApp(`/imports?profile=${profile.id}`);
  await waitFor(()=>expect((screen.getByLabelText("Source name") as HTMLInputElement).value).toBe("synthetic-lms"));
  await user.type(screen.getByLabelText("Batch name"),"Mapped customer delivery");
  await user.type(screen.getByLabelText("Source batch ID"),"batch-001");
  await user.type(screen.getByLabelText("CSV content"),"source_row_id,name,reference,consentProvenance\nrow-1,Sample customer,MAP-C-001,Synthetic consent");
  await user.click(screen.getByRole("button",{name:"Save and check batch"}));
  await screen.findByRole("heading",{name:"Source quality checks"});
  await user.click(screen.getByRole("button",{name:"Commit checked batch"}));
  await screen.findByRole("heading",{name:"Import complete"});
  const batch=api.state().records.find(r=>r.kind==='import-batches')!;
  expect(batch.data.sourceQuality.profileId).toBe(profile.id);
  cleanup();renderApp(`/imports?batch=${batch.id}`);
  await screen.findByRole("heading",{name:"Import complete"});
  expect((screen.getByLabelText("Source batch ID") as HTMLInputElement).value).toBe("batch-001");
});

it("labels offline Paystack fixtures and preserves conflicting receipts without recording payments",async()=>{
  const user=userEvent.setup();renderApp("/sources");
  await screen.findByText("External connection not verified");
  const count=api.state().records.filter(r=>r.kind==='payments').length;
  await user.click(screen.getByRole("button",{name:"Receive sample payment"}));
  await screen.findAllByText(/Synthetic fixture/);
  await user.click(screen.getByRole("button",{name:"Repeat delivery"}));
  await waitFor(()=>expect(api.state().records.filter(r=>r.kind==='provider-events')).toHaveLength(1));
  await user.click(screen.getByRole("button",{name:"Rehearse amount conflict"}));
  await screen.findByText(/Synthetic fixture.*Quarantined/i);
  expect(api.state().records.filter(r=>r.kind==='payments')).toHaveLength(count);
  expect(screen.getByText(/do not contact Paystack/)).toBeTruthy();
});

it("shows missing feeds and omits change controls for a read-only user",async()=>{
  api.mutate((state,ctx)=>{state.records.push({id:'late-profile',merchantId:state.merchant.id,kind:'source-profiles',name:'Overdue feed',status:'active',reference:'',amountKobo:0,customerId:'',createdAt:ctx.now,updatedAt:ctx.now,data:{source:'late-source',kind:'customers',mapping:{},identityColumn:'source_row_id',amountUnit:'naira',firstExpectedAt:'2026-09-20T07:00:00.000Z',cadenceHours:24,graceMinutes:0}});});
  api.role='Read-only';renderApp("/sources");
  await screen.findByRole("heading",{name:"Overdue feed"});
  expect(screen.queryByRole("button",{name:"Save source profile"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Receive sample payment"})).toBeNull();
  expect(screen.getByText("Late",{exact:true})).toBeTruthy();
});
