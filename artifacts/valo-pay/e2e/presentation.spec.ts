import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

test('presentation preparation, downloads and guide are usable on desktop and phone', async ({ page }, testInfo) => {
  const writes: string[] = [];
  page.on('request', req => { if (req.url().includes('/api/') && req.method() !== 'GET') writes.push(req.method()); });
  await page.goto('/presentation');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Show how a lender/);
  await page.getByRole('checkbox', { name: /I chose one sample lender/ }).check();
  const briefEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download presenter brief' }).click();
  const brief = await briefEvent;
  expect(brief.suggestedFilename()).toBe('valo-pay-presenter-brief.md');
  expect(await readFile((await brief.path())!, 'utf8')).toContain('external connection has not been verified');
  const csvEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download payment evidence CSV' }).click();
  const csv = await csvEvent;
  expect(await readFile((await csv.path())!, 'utf8')).toContain('18000.50,statement,PRES-D001');
  await page.addScriptTag({ path: path.resolve('node_modules/axe-core/axe.min.js') });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    // Inspect the settled theme, after its colour transitions have finished.
    await page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))); });
    const violations = await page.evaluate(async () => (await (window as any).axe.run(document.getElementById('main'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map((v: any) => ({ id: v.id, targets: v.nodes.map((n: any) => n.target) })));
    expect(violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.evaluate(() => { document.getElementById('main')!.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`presentation-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.getByRole('button', { name: 'Start presentation guide' }).focus();
  await page.keyboard.press('Enter');
  const guide = page.getByRole('region', { name: 'Presentation guide' });
  await expect(guide).toBeVisible();
  await guide.getByRole('link', { name: 'Open overview' }).click();
  await expect(page.getByRole('heading', { name: 'Operations overview' })).toBeVisible();
  await guide.getByRole('button', { name: 'Next talking point' }).click();
  await page.reload();
  await expect(guide.getByText('2 of 6 · Bring in payment evidence')).toBeVisible();
  await guide.getByRole('link', { name: 'Open import batches' }).click();
  await expect(page.getByRole('heading', { name: 'Import batches' })).toBeVisible();
  await guide.getByRole('button', { name: 'End presentation' }).click();
  await expect(guide).toHaveCount(0);
  expect(writes).toEqual([]);
});
