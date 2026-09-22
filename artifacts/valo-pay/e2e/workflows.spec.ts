import { test, expect, type Page } from "@playwright/test";
test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});
async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("link", { name, exact: true }).click();
}
test('unmatched searches explain the result and reconciliation search survives changing views',async({page})=>{
  for(const route of ['/exceptions','/mandates','/collections']) {
    await page.goto(route+'?q=nonexistent-search');
    await expect(page.getByText('No results match your search',{exact:true})).toBeVisible();
    await expect(page.getByText(/^(All clear: no open exceptions|No mandates yet|No instalments recorded)$/)).toHaveCount(0);
    await page.getByRole('button',{name:'Clear search'}).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expect(page.getByText('No results match your search',{exact:true})).toHaveCount(0);
  }
  await page.goto('/reconciliation?view=review');
  await page.getByLabel('Search reconciliation').fill('BROWSER-MATCH');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByText('1–25 of 55 proposed matches',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'All reconciliation',exact:true}).click();
  await expect(page.getByLabel('Search reconciliation')).toHaveValue('BROWSER-MATCH');
  await expect(page.getByText('1–25 of 55 proposed matches',{exact:true})).toBeVisible();
});
test("paged queue search, saved view, record return and browser history", async ({
  page,
}) => {
  await page.goto("/mandates");
  await expect(page.getByText(/^1–25 of \d+ mandates$/)).toBeVisible();
  await page.getByLabel("Search this queue").fill("BROWSER-MND");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("1–25 of 55 mandates", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next page of mandates" }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  const reference = await page
    .locator("tbody tr")
    .first()
    .locator("td")
    .first()
    .innerText();
  await page.locator("tbody tr").first().getByRole("link").click();
  await page.getByRole("link", { name: "Back to mandates" }).click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await expect(page.getByText(reference, { exact: true })).toBeVisible();
  await page.locator("summary").filter({ hasText: "Saved views" }).click();
  await page.getByLabel("View name").fill("Activation desk");
  await page.getByRole("button", { name: "Save current view" }).click();
  await page.reload();
  await page.locator("summary").filter({ hasText: "Saved views" }).click();
  await page
    .getByRole("button", { name: "Activation desk", exact: true })
    .click();
  await expect(page.getByLabel("Search this queue")).toHaveValue("BROWSER-MND");
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page of mandates" }).click();
  await page.goBack();
  await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
});
test("close range uses native date fields, pages summaries and loads evidence on demand", async ({
  page,
}) => {
  const detailRequests: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/v1\/close-history\//.test(r.url()))
      detailRequests.push(r.url());
  });
  await page.goto("/reports");
  await expect(
    page.getByRole("list", { name: "Recorded daily closes" }),
  ).toBeVisible();
  expect(detailRequests).toHaveLength(0);
  await page.getByLabel("From date (WAT)", { exact: true }).fill("2026-08-02");
  await page.getByLabel("To date (WAT)", { exact: true }).fill("2026-08-03");
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(
    page.getByText(
      /Showing 2 recorded closes from 2026-08-02 through 2026-08-03/,
    ),
  ).toBeVisible();
  await page
    .getByRole("list", { name: "Recorded daily closes" })
    .locator("summary")
    .first()
    .click();
  await expect(
    page.getByText("Unmatched at start", { exact: true }),
  ).toBeVisible();
  expect(detailRequests).toHaveLength(1);
  const width = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
  await page.getByRole("button", { name: "Clear dates" }).click();
  await page
    .getByRole("button", { name: "Next page of recorded closes" })
    .click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Billing", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Issue invoice" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Pilot evidence", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New experiment" }),
  ).toBeVisible();
});
test("reconciliation pages retain evidence and reject a proposed match with a reason", async ({
  page,
  request,
}) => {
  const unbounded: string[] = [];
  page.on("request", (r) => {
    if (
      /\/api\/v1\/records\//.test(r.url()) &&
      !new URL(r.url()).searchParams.has("limit")
    )
      unbounded.push(r.url());
  });
  await page.goto("/reconciliation?view=review");
  await expect(
    page.getByRole("button", { name: "Next page of proposed matches" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Next page of proposed matches" })
    .click();
  await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
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
    .fill("The synthetic source reference needs a separate Finance review.");
  const rejection = page.waitForResponse((response) =>
    response.url().includes("/api/v1/actions?") && response.request().method() === "POST",
  );
  await dialog
    .getByRole("button", { name: "Reject allocation", exact: true })
    .click();
  const response = await rejection;
  const outcome = await response.json();
  expect(response.ok(), JSON.stringify(outcome)).toBeTruthy();
  const submitted = response.request().postDataJSON();
  expect(submitted.data.proposalId).toBeTruthy();
  expect(submitted.data.proposalUpdatedAt).toBeTruthy();
  expect(outcome.record).toMatchObject({
    id: submitted.data.proposalId,
    status: "superseded",
    data: { supersededReason: submitted.reason },
  });
  await expect(dialog).toBeHidden();
  const merchantId = new URL(response.url()).searchParams.get("merchantId");
  const saved = await request.get(`/api/v1/records/allocations?merchantId=${merchantId}&id=${submitted.data.proposalId}&limit=1`);
  expect(saved.ok()).toBeTruthy();
  expect((await saved.json()).items[0].status).toBe("superseded");
  expect(unbounded).toHaveLength(0);
  await navigate(page, "Reports");
  await expect(
    page.getByRole("heading", { name: "Reports & analytics" }),
  ).toBeVisible();
});
