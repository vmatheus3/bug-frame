import { expect, test } from '@playwright/test';
import { signIn } from './session';

test('a visitor cannot enable reporting with the URL, forged cookies, or direct API requests', async ({ page, context }) => {
  await page.goto('/?bugs=1');
  await expect(page.locator('[data-bugframe]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in as an approved tester' })).toBeVisible();
  await context.addCookies([{ name: 'bugframe_demo_session', value: 'admin', url: 'http://127.0.0.1:4455' }]);
  const response = await page.request.post('/api/bugframe/reports?bugs=1', {
    headers: { 'x-bugframe-token': 'demo-public-token', 'x-bugframe-reporter': 'admin' },
    data: { description: 'Unauthorized direct request' },
  });
  expect(response.status()).toBe(401);
  expect((await page.request.get('/api/bugframe/reports')).status()).toBe(401);
  await page.reload();
  await expect(page.locator('[data-bugframe]')).toHaveCount(0);
});

test('signing out revokes an open report and does not offer a download fallback', async ({ page, context }) => {
  await signIn(page);
  const session = (await context.cookies()).find(cookie => cookie.name === 'bugframe_demo_session')!;
  expect(session.httpOnly).toBe(true); expect(session.sameSite).toBe('Strict');
  await page.locator('.fab').click();
  await page.getByRole('menuitem', { name: /Leave feedback/ }).click();
  await page.getByRole('button', { name: 'Pick a spot' }).click(); await page.getByRole('button', { name: 'Whole screen' }).click();
  await page.locator('textarea').fill('Session was revoked');
  const result = await page.request.post('/logout', { headers: { origin: 'http://127.0.0.1:4455' } });
  expect(result.ok()).toBe(true);
  const response = page.waitForResponse(r => r.url().endsWith('/reports') && r.request().method() === 'POST');
  await page.locator('.send').click();
  expect((await response).status()).toBe(401);
  await expect(page.getByRole('alert')).toContainText('Sign in with an account authorized');
  await expect(page.getByRole('button', { name: 'Download as a file instead' })).toHaveCount(0);
  await expect(page.locator('.sent')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-bugframe]')).toHaveCount(0);
  // A copied credential is also invalid once that server-side session is revoked.
  const replay = await page.request.post('/api/bugframe/reports', { headers: { cookie: `bugframe_demo_session=${session.value}` }, data: {} });
  expect(replay.status()).toBe(401);
});
