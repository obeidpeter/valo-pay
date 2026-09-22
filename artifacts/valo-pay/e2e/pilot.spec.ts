import { test, expect } from "@playwright/test";
import path from "node:path";
test.beforeEach(async ({ request }) => {
  await request.post("/__test/reset");
});
test("saved import and case handover work across reload with accessible responsive screens", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/imports");
  await page.getByRole("button", { name: "Use sample", exact: true }).click();
  await page.getByRole("button", { name: "Save and check batch" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved check results" }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: /Customers sample.*Pilot sample/ })
    .click();
  await expect(page.getByLabel("CSV content")).toHaveValue(/PILOT-C001/);
  await page.getByRole("button", { name: "Commit checked batch" }).click();
  await expect(
    page.getByRole("heading", { name: "Import complete" }),
  ).toBeVisible();
  await page.addScriptTag({
    path: path.resolve("node_modules/axe-core/axe.min.js"),
  });
  expect(
    await page.evaluate(async () =>
      (
        await (window as any).axe.run(document.getElementById("main"), {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v: any) => ({
        id: v.id,
        nodes: v.nodes.map((n: any) => n.target),
      })),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("saved-import.png"),
    fullPage: true,
  });
  const lender = await page
    .locator('select[id^="lender-"]:visible')
    .inputValue();
  const record = (
    await (
      await request.get(`/api/v1/records/exceptions?merchantId=${lender}`)
    ).json()
  ).items[0];
  await page.goto(`/cases/${record.id}`);
  await page
    .getByLabel("Next action", { exact: true })
    .fill("Review the source payment");
  await page
    .getByLabel("Handover or progress note")
    .fill("Verified the sample reference and source batch.");
  await page.getByRole("button", { name: "Claim and save next step" }).click();
  await expect(
    page.getByText("Case update saved with its handover history."),
  ).toBeVisible();
  await page.getByLabel("Assigned to").selectOption("Sandbox Finance");
  await page
    .getByLabel("Handover or progress note")
    .fill("Finance to check the proposed allocation.");
  await page.getByRole("button", { name: "Save handover" }).click();
  await expect(page.getByText("Case handed over · Demo Finance")).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Finance to check the proposed allocation."),
  ).toBeVisible();
  await page.addScriptTag({
    path: path.resolve("node_modules/axe-core/axe.min.js"),
  });
  expect(
    await page.evaluate(async () =>
      (
        await (window as any).axe.run(document.getElementById("main"), {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((v: any) => v.id),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("case-handover.png"),
    fullPage: true,
  });
});
