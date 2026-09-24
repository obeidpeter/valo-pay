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

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();
/** Answers the workspace as a staff pilot's, signed in as administrator A; everything else stays the synthetic API's. */
async function staffAdministrator(page: Page) {
  await page.route("**/api/v1/workspace", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), accessMode: "staff", actor: "Clerk:user_admin_a", role: "Admin" } });
  });
}
/** Answers a staff request as the service would, after long enough for the pressed button to wait disabled. */
const slowly = () => new Promise((resolve) => setTimeout(resolve, 600));

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

test("a decision on Team & access moves focus to what it did, and a staff administrator is still warned", async ({ page }) => {
  // Console review of 24 September, item 3, with the staff answers at the network edge.
  await staffAdministrator(page);
  const member = (id: string, name: string, role: string, expiresAt: string) => ({ id, actor: `Clerk:user_${id}`, name, role, status: "active", expiresAt, updatedAt: inDays(-1), lenderIds: [], allLenders: role === "Admin" });
  const members = [member("admin_a", "Ada Admin", "Admin", inDays(10)), member("admin_b", "Bola Admin", "Admin", inDays(60)), member("ops", "Chidi Ops", "Operations", inDays(80)), member("fin", "Funmi Obi", "Finance", inDays(80))];
  const change = (id: string, memberId: string, name: string, from: string, to: string) => ({ id, memberId, name, from: { role: from, status: "active" }, to: { role: to, status: "active" }, reason: "Covers the close reviews", requestedBy: "Clerk:user_admin_b", requestedAt: inDays(-0.1) });
  let invitations = [{ id: "i-1", email: "finance.new@example.test", role: "Finance", status: "pending", expiresAt: inDays(6), invitedBy: "Clerk:user_admin_b", approval: "awaiting", approvedBy: null }];
  let changes = [change("c-1", "ops", "Chidi Ops", "Operations", "Finance"), change("c-2", "fin", "Funmi Obi", "Finance", "Compliance reviewer")];
  await page.route("**/api/v1/team", (route) => route.request().method() === "GET" ? route.fulfill({ json: { mode: "staff", actor: "Clerk:user_admin_a", members, lenders: [], invitations, changes, events: [], message: "Verified staff access." } }) : route.fallback());
  await page.route(/\/api\/v1\/team\/(invitations|changes)\/[^/]+\/(approve|decline)$/, async (route) => {
    await slowly();
    const [, , , , kind, id, decision] = new URL(route.request().url()).pathname.split("/");
    if (kind === "invitations") { invitations = []; return route.fulfill({ json: { message: "Invitation approved: finance.new@example.test can now accept it as Finance." } }); }
    const request = changes.find((item) => item.id === id)!;
    changes = changes.filter((item) => item !== request);
    if (decision === "decline") return route.fulfill({ json: { message: "Change request declined. The membership is unchanged." } });
    return route.fulfill({ json: { id: request.memberId, actor: `Clerk:user_${request.memberId}`, name: request.name, role: request.to.role, status: "active", expiresAt: inDays(80), updatedAt: new Date().toISOString(), message: `Change approved: ${request.name} is now ${request.to.role} (active).`, pendingChange: null } });
  });
  await page.goto("/team");
  // Administrator A's access ends within 14 days: the warning's code loads for a staff administrator.
  await expect(page.getByRole("status", { name: "Administrator access" })).toContainText("Your administrator access ends on");
  const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Waiting for a second administrator" }) });
  for (const [name, said] of [["Approve invitation", /^Invitation approved/], ["Approve change", /^Change approved: Chidi Ops/], ["Decline change", /^Change request declined/]] as const) {
    const count = await panel.getByRole("button", { name }).count();
    await panel.getByRole("button", { name }).first().focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name })).toHaveCount(count - 1);
    await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(said) });
  }
});

test("Approve turning it off and Keep the stop on move focus to what they did when their box goes", async ({ page }) => {
  // Console review of 24 September, item 3: another administrator asked to lift the stop.
  await staffAdministrator(page);
  let waiting = true, stopOn = true;
  await page.route(/\/api\/v1\/settings\?/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch(), body = await response.json();
    const release = { lender: { requestedBy: "Clerk:user_admin_b", requestedAt: inDays(-0.02), reason: "Provider incident resolved", policyId: null } };
    await route.fulfill({ response, json: { ...body, merchant: { ...body.merchant, killSwitch: stopOn }, settings: { ...body.settings, ...(waiting ? { emergencyStopReleases: release } : {}) } } });
  });
  await page.route(/\/api\/v1\/actions\?/, async (route) => {
    const sent = route.request().postDataJSON();
    if (!["approve_kill_switch_off", "kill_switch"].includes(sent.action)) return route.fallback();
    await slowly();
    waiting = false;
    stopOn = sent.action === "kill_switch";
    await route.fulfill({ json: { message: `Lender emergency stop is ${stopOn ? "on" : "off"}. No collection instruction was sent.`, data: { enabled: stopOn } } });
  });
  for (const [name, said] of [["Approve turning it off", /^Lender emergency stop is off\./], ["Keep the stop on", /^Lender emergency stop is on\./]] as const) {
    waiting = true;
    stopOn = true;
    await page.goto("/settings");
    await page.getByLabel("Reason for changing the emergency stop").fill("Second administrator's decision on the request");
    const button = page.getByRole("button", { name });
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveCount(0);
    await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(said) });
  }
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

test("the landing page and the anonymous sandbox carry no shared schemas, zod or administrator warning in their entry script", async ({ page, request }) => {
  const scripts = new Set<string>();
  page.on("request", (sent) => { if (sent.resourceType() === "script" || sent.url().endsWith(".js")) scripts.add(sent.url()); });
  // Text the minifier keeps: zod's type names, a message of the shared record schemas and the warning's heading.
  const signatures = { zod: /ZodObject/, "shared schemas": /Use YYYY-MM-DD or a UTC timestamp/, "administrator warning": /Administrator access is ending/ };
  const entryCarries = async (route: string) => {
    const entry = await page.locator('script[type="module"][src]').getAttribute("src");
    const code = await (await request.get(entry!)).text();
    return Object.entries(signatures).filter(([, signature]) => signature.test(code)).map(([name]) => `${route}: ${name}`);
  };
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await entryCarries("/")).toEqual([]);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1, name: "Operations overview" })).toBeVisible();
  expect(await entryCarries("/overview")).toEqual([]);
  // The console fetches every page's code while idle; none of it is the warning, which only a staff administrator loads.
  await expect.poll(() => [...scripts].some((url) => /\/team-[\w-]+\.js$/.test(url)), { timeout: 15_000 }).toBe(true);
  await page.waitForLoadState("networkidle");
  const withWarning: string[] = [];
  for (const url of scripts) if (signatures["administrator warning"].test(await (await request.get(url)).text())) withWarning.push(url);
  expect(withWarning).toEqual([]);
});

// Second review of the audit fixes, the older focus patterns, by keyboard in a real browser: paging, Discard original
// request and Revoke access.
/** A moment for each list answer, as a pilot's takes, so there is a page load to wait through. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const onBody = (page: Page) => page.evaluate(() => !document.activeElement || document.activeElement === document.body);

test("paging Customers and the Audit log by keyboard keeps focus on the pager control pressed, never on the page", async ({ page, request }) => {
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const rows = Array.from({ length: 60 }, (_, i) => `Pager customer ${String(i).padStart(2, "0")},E2E-PAGER-${i},Synthetic consent,Sandbox Bank,•••• 0001`);
  expect((await request.post(`/api/v1/imports?merchantId=${lender}`, { data: { kind: "customers", csv: "name,reference,consentProvenance,bankName,accountMasked\n" + rows.join("\n"), mapping: {}, syntheticOnly: true, commit: true } })).ok()).toBeTruthy();
  // Every audited write adds an entry: enough for three pages of the log.
  for (let i = 0; i < 60; i++) expect((await request.post(`/api/v1/actions?merchantId=${lender}`, { data: { action: "run_reconciliation" } })).ok()).toBeTruthy();
  await page.route(/\/api\/v1\/records\/(customers|audit)\?/, async (route) => { await pause(500); await route.fallback(); });
  for (const [path, label] of [["/customers", "customers"], ["/audit", "audit entries"]] as const) {
    await page.goto(path);
    const pager = page.getByRole("navigation", { name: `${label} pagination` });
    const next = pager.getByRole("button", { name: `Next page of ${label}` });
    await next.focus();
    await page.keyboard.press("Enter");
    // While the next page loads the rows and the pager stay, and the pressed button keeps the focus.
    await expect(next).toHaveAttribute("aria-disabled", "true");
    expect(await focused(page), path).toMatchObject({ tag: "button", text: `Next page of ${label}` });
    await expect(next).not.toHaveAttribute("aria-disabled", "true");
    expect(await focused(page), path).toMatchObject({ tag: "button", text: `Next page of ${label}` });
    await page.keyboard.press("Enter");
    await expect(pager.getByText("Page 3 of 3", { exact: true })).toBeVisible();
    // On the last page Next has nowhere to go: Previous takes the focus.
    await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: `Previous page of ${label}` });
    expect(await onBody(page)).toBe(false);
  }
});

test("paging either picker by keyboard gives the focus back to the pager control pressed once the page arrives", async ({ page, request }) => {
  const lender = (await (await request.get("/api/v1/workspace")).json()).merchants[0].id;
  const rows = Array.from({ length: 60 }, (_, i) => `Picker customer ${String(i).padStart(2, "0")},E2E-PICKER-${i},Synthetic consent,Sandbox Bank,•••• 0001`);
  expect((await request.post(`/api/v1/imports?merchantId=${lender}`, { data: { kind: "customers", csv: "name,reference,consentProvenance,bankName,accountMasked\n" + rows.join("\n"), mapping: {}, syntheticOnly: true, commit: true } })).ok()).toBeTruthy();
  await page.route(/\/api\/v1\/records\/(customers|due-items)\?/, async (route) => { await pause(500); await route.fallback(); });
  await page.goto("/mandates");
  await page.getByRole("button", { name: "Create synthetic mandate" }).first().click();
  const mandate = page.getByRole("dialog", { name: "Create synthetic mandate" });
  await expect(mandate.getByText(/^1–25 of [\d,]+ customer choices$/)).toBeVisible();
  await mandate.getByRole("button", { name: "Next page of customer choices" }).focus();
  await page.keyboard.press("Enter");
  await expect(mandate.getByText(/^26–50 of [\d,]+ customer choices$/)).toBeVisible();
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Next page of customer choices" });
  await page.keyboard.press("Escape");
  await expect(mandate).toHaveCount(0);

  await page.goto("/reconciliation");
  await page.getByRole("row").filter({ hasText: "SBX-UNIDENTIFIED-001" }).getByRole("button", { name: "Allocate", exact: true }).click();
  const allocate = page.getByRole("dialog", { name: "Allocate payment" });
  await expect(allocate.getByText(/^1–25 of [\d,]+ instalment choices$/)).toBeVisible();
  await allocate.getByRole("button", { name: "Next page of instalment choices" }).focus();
  await page.keyboard.press("Enter");
  await expect(allocate.getByText(/^26–50 of [\d,]+ instalment choices$/)).toBeVisible();
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Next page of instalment choices" });
});

test("Discard original request moves focus back to the control that sent the request", async ({ page }) => {
  await staffAdministrator(page);
  // Another administrator asked to lift the stop; the approval never reaches the service, so the request still waits.
  await page.route(/\/api\/v1\/settings\?/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, merchant: { ...body.merchant, killSwitch: true }, settings: { ...body.settings, emergencyStopReleases: { lender: { requestedBy: "Clerk:user_admin_b", requestedAt: inDays(-0.02), reason: "Provider incident resolved", policyId: null } } } } });
  });
  await page.route(/\/api\/v1\/actions\?/, async (route) => {
    if (route.request().postDataJSON().action !== "approve_kill_switch_off") return route.fallback();
    await slowly();
    await route.abort("connectionreset");
  });
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.goto("/settings");
  await page.getByLabel("Reason for changing the emergency stop").fill("Second administrator's decision on the request");
  const approve = page.getByRole("button", { name: "Approve turning it off" });
  await approve.focus();
  await page.keyboard.press("Enter");
  const discard = page.getByRole("button", { name: "Discard original request" });
  await expect(discard).toBeVisible();
  await discard.focus();
  await page.keyboard.press("Enter");
  await expect(discard).toHaveCount(0);
  await expect.poll(() => focused(page)).toMatchObject({ tag: "button", text: "Approve turning it off" });
});

test("confirming Revoke access moves focus to what the revocation did once it is answered", async ({ page }) => {
  await staffAdministrator(page);
  const person = (id: string, name: string, role: string) => ({ id, actor: `Clerk:user_${id}`, name, role, status: "active", expiresAt: inDays(60), updatedAt: inDays(-1), lenderIds: [] as string[], allLenders: role === "Admin" });
  let chidi = person("ops", "Chidi Ops", "Operations");
  const admins = [person("admin_a", "Ada Admin", "Admin"), person("admin_b", "Bola Admin", "Admin")];
  await page.route("**/api/v1/team", (route) => route.request().method() === "GET" ? route.fulfill({ json: { mode: "staff", actor: "Clerk:user_admin_a", members: [...admins, chidi], lenders: [], invitations: [], changes: [], events: [], message: "Verified staff access." } }) : route.fallback());
  await page.route(/\/api\/v1\/team\/members\/ops$/, async (route) => {
    await slowly();
    chidi = { ...chidi, status: "revoked", updatedAt: new Date().toISOString() };
    const { lenderIds: _lenders, allLenders: _all, ...answer } = chidi;
    await route.fulfill({ json: { ...answer, message: "Chidi Ops’s access is revoked. Their lender access and pending invitations are removed.", pendingChange: null } });
  });
  await page.goto("/team");
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Chidi Ops" }) });
  await card.getByLabel("Access for Chidi Ops").selectOption("revoked");
  await card.getByLabel("Reason for changing Chidi Ops").fill("Left the pilot team this week");
  await card.getByRole("button", { name: "Save access change" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Revoke Chidi Ops’s access?" });
  await dialog.getByRole("button", { name: "Revoke access" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  // While the answer is on its way, focus waits on the page's main region, never on the body.
  expect(await focused(page)).toMatchObject({ tag: "main", id: "main" });
  await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(/^Chidi Ops’s access is revoked\./) });
  await expect(card.getByText(/^Operations · revoked/)).toBeVisible();
  await expect.poll(() => focused(page)).toMatchObject({ tag: "p", text: expect.stringMatching(/^Chidi Ops’s access is revoked\./) });
});
