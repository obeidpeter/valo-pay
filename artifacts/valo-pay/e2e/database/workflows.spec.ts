import { test, expect } from "@playwright/test";
import { formatKobo } from "../../src/lib/formatters";

test("real API bootstrap, database history pages, full balances and lender isolation", async ({
  page,
  context,
}) => {
  // A fresh anonymous request exercises the real middleware and workspace bootstrap.
  const bootstrap = await context.request.get("/api/v1/workspace");
  expect(bootstrap.ok()).toBeTruthy();
  expect((await bootstrap.json()).environment).toBe("sandbox");
  const arranged = await context.request.post("/__test/session");
  expect(arranged.ok()).toBeTruthy();
  const fixture = await arranged.json();
  const responses: any[] = [];
  page.on("response", async (response) => {
    if (response.url().includes("/history?") && response.ok())
      responses.push(await response.json());
  });
  await page.goto(
    `/customers/${fixture.customerId}?record=${fixture.oldRecordId}`,
  );
  await expect(
    page.getByRole("region", { name: "Selected collection record" }),
  ).toContainText("DB-DUE-00");
  await expect(
    page.getByText(`${fixture.eventCount} events in the full history`, {
      exact: true,
    }),
  ).toBeVisible();
  const position = page
    .locator("div")
    .filter({
      has: page.getByRole("heading", {
        name: "Customer position",
        exact: true,
      }),
    })
    .last();
  await expect(position).toContainText(
    formatKobo(fixture.position.outstandingKobo),
  );
  await page
    .getByRole("button", { name: "Next page of history events" })
    .click();
  await expect(page).toHaveURL(/history-page=2/);
  await expect
    .poll(() => responses.some((r) => r.offsets.events === 25))
    .toBeTruthy();
  const second = responses.find((r) => r.offsets.events === 25);
  expect(second.position).toEqual(fixture.position);
  expect(second.events).toHaveLength(25);
  expect(second.totals.events).toBe(fixture.eventCount);
  expect(second.focusedRecord.id).toBe(fixture.oldRecordId);
  await page.reload();
  await expect(
    page.getByText(`${fixture.eventCount} events in the full history`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(position).toContainText(
    formatKobo(fixture.position.outstandingKobo),
  );
  const foreign = await context.request.get(
    `/api/v1/customers/${fixture.customerId}/history?merchantId=${fixture.otherMerchantId}`,
  );
  expect(foreign.status()).toBe(404);
  const invalid = await context.request.get(
    `/api/v1/customers/${fixture.customerId}/history?merchantId=${fixture.merchantId}&eventsLimit=101`,
  );
  expect(invalid.status()).toBe(400);
});

test("real reconciliation search, recorded rejection, reload persistence and audit evidence", async ({
  page,
  context,
}) => {
  const arranged = await context.request.post("/__test/session");
  expect(arranged.ok()).toBeTruthy();
  const fixture = await arranged.json();
  await page.goto("/reconciliation?view=review");
  await page.getByLabel("Search reconciliation").fill(fixture.paymentReference);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("1 pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name:"Confirm", exact:true })).toHaveCount(1);
  await page.getByLabel("Search reconciliation").fill(fixture.customerName);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("1–25 of 31 proposed matches", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Next page of proposed matches" })
    .click();
  await expect(
    page.getByText("26–31 of 31 proposed matches", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search reconciliation").fill("DOES-NOT-EXIST");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("No results match your search", { exact: true }).first(),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/proposals-page=/);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(
    page.getByText("1–25 of 31 proposed matches", { exact: true }),
  ).toBeVisible();
  const rejection = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/actions") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Reject", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("region", { name: "Match evidence" }),
  ).toBeVisible();
  await dialog
    .getByLabel(/Reason/)
    .fill(
      "Synthetic database browser test: source evidence does not support this match.",
    );
  await dialog
    .getByRole("button", { name: "Reject allocation", exact: true })
    .click();
  const response = await rejection;
  expect(response.ok()).toBeTruthy();
  const action = await response.json();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(
    page.getByText("1–25 of 30 proposed matches", { exact: true }),
  ).toBeVisible();
  const record = await context.request.get(
    `/api/v1/records/allocations?merchantId=${fixture.merchantId}&id=${action.record.id}&limit=1`,
  );
  expect(record.ok()).toBeTruthy();
  expect((await record.json()).items[0].status).toBe("superseded");
  const audit = await context.request.get(
    `/api/v1/records/audit?merchantId=${fixture.merchantId}&limit=25`,
  );
  expect(audit.ok()).toBeTruthy();
  expect(JSON.stringify(await audit.json())).toContain(
    "Synthetic database browser test",
  );
});
