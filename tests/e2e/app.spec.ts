import { test, expect, type Page } from '@playwright/test';

const PAGES = [
  ['/', 'Dashboard'],
  ['/chart', 'Live Charts'],
  ['/strategy', 'ELF Strategy'],
  ['/planner', 'Trade Planner'],
  ['/alerts', 'Alerts'],
  ['/journal', 'Trade Journal'],
  ['/replay', 'Replay'],
  ['/backtest', 'Backtesting'],
  ['/providers', 'Market Data Providers'],
  ['/settings', 'Settings & Rules'],
] as const;

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('every page renders without errors or horizontal overflow', async ({ page }) => {
  const errors = watchErrors(page);
  for (const [path, title] of PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('live chart shows a candlestick canvas and an honest feed status', async ({ page }) => {
  await page.goto('/chart');
  await expect(page.locator('.chart canvas').first()).toBeVisible();
  const badge = page.locator('.chart-bar .badge').first();
  await expect(badge).toHaveText(/LIVE|REST POLLING|DELAYED|DISCONNECTED|NEEDS KEY|ERROR|CONNECTING/);
});

test('journal entries persist after reload', async ({ page }) => {
  await page.goto('/journal');
  await page.getByRole('button', { name: '+ New entry' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Symbol', { exact: true }).fill('E2ETEST');
  await modal.getByLabel('Entry', { exact: true }).fill('100');
  await modal.getByLabel('Stop-loss', { exact: true }).fill('95');
  await modal.getByLabel('Actual exit').fill('110');
  await modal.getByLabel('Notes', { exact: true }).fill('playwright persistence check');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('cell', { name: /E2ETEST/ }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: '+2.00R' }).first()).toBeVisible();
});

test('rule settings persist and can be restored to v1.1 defaults', async ({ page }) => {
  await page.goto('/settings');
  const rule = page.locator('.rule', { hasText: 'Max sweep → confirmation bars' });
  await rule.locator('input').fill('25');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await page.reload();
  await expect(page.locator('.rule', { hasText: 'Max sweep → confirmation bars' }).locator('input')).toHaveValue('25');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Restore ELF v1.1 defaults' }).click();
  await expect(page.locator('.rule', { hasText: 'Max sweep → confirmation bars' }).locator('input')).toHaveValue('20');
});

test('replay hides future candles', async ({ page }) => {
  test.skip(!process.env.NODE_USE_ENV_PROXY && !process.env.ELF_E2E_NETWORK, 'needs provider network access');
  await page.goto('/replay');
  await page.getByRole('button', { name: 'Load replay' }).click();
  await expect(page.getByText(/bar \d+\/\d+/)).toBeVisible({ timeout: 60_000 });
  const before = await page.getByText(/bar \d+\/\d+/).textContent();
  await page.getByRole('button', { name: '1 ▶' }).click();
  const after = await page.getByText(/bar \d+\/\d+/).textContent();
  const n = (s: string | null) => Number(/bar (\d+)/.exec(s ?? '')![1]);
  expect(n(after)).toBe(n(before) + 1);
});
