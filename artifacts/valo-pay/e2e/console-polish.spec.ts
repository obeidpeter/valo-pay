import { test, expect, type Page } from "@playwright/test";
import path from "node:path";

// Focus, headings and the presentation guide in a real browser (audit of 23
// September, items 6 to 8).
test.beforeEach(async ({ request, page }) => {
  await request.post("/__test/reset");
  await page.emulateMedia({ reducedMotion: "reduce" });
});

const focused = (page: Page) => page.evaluate(() => {
  const active = document.activeElement as HTMLElement | null;
  return active ? { tag: active.tagName.toLowerCase(), id: active.id, text: (active.getAttribute("aria-label") || active.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80) } : null;
});

/** Whether the page has an h1, as axe's best-practice rule asks. */
async function headingOne(page: Page) {
  await page.addScriptTag({ path: path.resolve("node_modules/axe-core/axe.min.js") });
  return page.evaluate(async () => (await (window as any).axe.run(document, { runOnly: { type: "rule", values: ["page-has-heading-one"] } })).violations.map((v: any) => v.id));
}

test("focus follows Edit, Cancel and Save on Settings instead of falling to the page", async ({ page }) => {
  await page.goto("/settings");
  const edit = page.getByRole("button", { name: "Edit", exact: true });
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toMatchObject({ id: "settings-authorisationMode" });
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Edit" });
  await page.keyboard.press("Enter");
  await page.getByLabel("Lender contact details for customer notices").pressSequentially(" (updated)");
  await page.getByRole("button", { name: "Save", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Settings saved").first()).toBeVisible();
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Edit" });
});

test("a pay-by-bank step that removes its button moves focus to what it did", async ({ page }) => {
  await page.goto("/pay-by-bank");
  await page.getByRole("button", { name: /Create sample checkout/ }).click();
  await page.getByRole("button", { name: "Review & authorise" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Review sample payment details");
  await dialog.getByRole("button", { name: "Confirm sample action" }).click();
  const browserReturn = page.getByRole("button", { name: "Simulate browser return" });
  await browserReturn.focus();
  await page.keyboard.press("Enter");
  await expect(browserReturn).toHaveCount(0);
  await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(/^Browser return recorded\./) });
});

test("End presentation moves focus to the page content", async ({ page }) => {
  await page.goto("/presentation");
  await page.getByRole("button", { name: "Start presentation guide" }).click();
  const guide = page.getByRole("region", { name: "Presentation guide" });
  await guide.getByRole("button", { name: "End presentation" }).focus();
  await page.keyboard.press("Enter");
  await expect(guide).toHaveCount(0);
  await expect.poll(() => focused(page)).toMatchObject({ tag: "main", id: "main" });
});

test("loading and error states keep an h1", async ({ page }) => {
  // The workspace on its way.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/workspace", async (route) => { await held; await route.continue(); });
  await page.goto("/overview");
  await expect(page.getByRole("status").filter({ hasText: "Loading your workspace…" })).toBeVisible();
  expect(await headingOne(page)).toEqual([]);
  release();
  await expect(page.getByRole("heading", { level: 1, name: "Operations overview" })).toBeVisible();
  await page.unroute("**/api/v1/workspace");

  // A page whose first load failed, with nothing to show.
  for (const [route, api, problem] of [
    ["/overview", "**/api/v1/overview?*", "Unable to load the overview"],
    ["/pay-by-bank", "**/api/v1/connected?*", "Unable to load pay-by-bank"],
    ["/credit-desk", "**/api/v1/connected?*", "Unable to load Credit Desk"],
    ["/cash-desk", "**/api/v1/connected?*", "Unable to load Cash Desk"],
    ["/connections", "**/api/v1/connected?*", "Unable to load permissions"],
  ] as const) {
    await page.route(api, (request) => request.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Lender not found in this workspace.", requestId: "browser-missing" }) }));
    await page.goto(route);
    await expect(page.getByText(problem)).toBeVisible();
    expect(await page.locator("h1").count(), route).toBe(1);
    expect(await headingOne(page), route).toEqual([]);
    await page.unroute(api);
  }
});

test("on a phone the presentation guide keeps its title on a line or two and leaves the page in view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto("/presentation");
  await page.getByRole("button", { name: "Start presentation guide" }).click();
  const guide = page.getByRole("region", { name: "Presentation guide" });
  await guide.getByLabel("Talking point").selectOption("2");
  const title = guide.getByText("3 of 6 · Explain the match");
  await expect(title).toBeVisible();
  const titleBox = (await title.boundingBox())!, guideBox = (await guide.boundingBox())!;
  const lineHeight = await title.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
  // Before, the title was squeezed beside the buttons to one word a line (six lines) and the guide covered about 60% of the screen.
  expect(titleBox.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
  expect(guideBox.height).toBeLessThanOrEqual(664 * 0.5);
  const action = guide.getByRole("link", { name: "Open the sample customer" });
  expect((await action.boundingBox())!.y).toBeGreaterThan(titleBox.y + titleBox.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("the anonymous sandbox on a host without sign-in never fetches Clerk's code", async ({ page, request }) => {
  const scripts = new Set<string>();
  page.on("request", (sent) => { if (sent.resourceType() === "script" || sent.url().endsWith(".js")) scripts.add(sent.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1, name: "Operations overview" })).toBeVisible();
  // The console fetches every page's code while the browser is idle, Team & access among them.
  await expect.poll(() => [...scripts].some((url) => /\/team-[\w-]+\.js$/.test(url)), { timeout: 15_000 }).toBe(true);
  await page.waitForLoadState("networkidle");
  const withClerk: string[] = [];
  for (const url of scripts) if ((await (await request.get(url)).text()).includes('"@clerk/react"')) withClerk.push(url);
  expect(withClerk).toEqual([]);
  expect(scripts.size).toBeGreaterThan(5);
});
