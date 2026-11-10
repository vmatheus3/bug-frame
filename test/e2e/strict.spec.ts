import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ page }) => signIn(page));
for (const status of [401, 403, 413, 429, 500, 'offline'] as const) {
  test(`strict server mode keeps the report after ${status}, with no download, then retries`, async ({ page }) => {
    await page.route('**/strict-demo*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Server-only demo</h1><script src="/bugframe.min.js" data-mode="server" data-endpoint="/api/bugframe" data-allow-download-fallback="false"></script>' }));
    let failed = true;
    await page.route('**/api/bugframe/reports', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (!failed) return route.fulfill({ status: 201, json: { id: 'bug-retry', status: 'open' } });
      return status === 'offline' ? route.abort('failed') : route.fulfill({ status, json: { error: 'test_failure' } });
    });
    const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
    await page.goto('/strict-demo?bugs=1');
    await page.locator('.fab').click(); await page.getByRole('menuitem', { name: /Leave feedback/ }).click();
    await page.getByRole('button', { name: 'Pick a spot' }).click(); await page.getByRole('button', { name: 'Whole screen' }).click();
    await page.locator('textarea').fill('Preserve this report after a failure');
    await page.locator('.send').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('textarea')).toHaveValue('Preserve this report after a failure');
    await expect(page.locator('.preview')).toHaveAttribute('src', /^data:image\/png/);
    await expect(page.getByRole('button', { name: 'Download as a file instead' })).toHaveCount(0);
    failed = false; await page.locator('.send').click(); await expect(page.locator('.sent')).toBeVisible();
    expect(downloads).toEqual([]);
  });
}

test('a missing server endpoint fails visibly instead of downloading a local report', async ({ page }) => {
  await page.goto('/'); await page.addScriptTag({ url: '/bugframe.min.js' });
  const message = await page.evaluate(() => {
    const api = (window as unknown as { Bugframe: { init: (options: unknown) => void } }).Bugframe;
    try { api.init({ mode: 'server', allowDownloadFallback: false }); return ''; } catch (error) { return String(error); }
  });
  expect(message).toContain('requires an endpoint');
});
