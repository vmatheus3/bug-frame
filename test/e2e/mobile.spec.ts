import { expect, test } from '@playwright/test';
import { signIn } from './session';

test.beforeEach(async ({ page }) => signIn(page));

test('phone: one button, one message, and send stays above the keyboard', async ({ page }, testInfo) => {
  let payload: any;
  await page.route('**/api/bugframe/reports', route => route.request().method() === 'POST' ? (payload = route.request().postDataJSON(), route.fulfill({ status: 201, json: { id: 'bug-20261109-100000-aaaa', status: 'open' } })) : route.continue());
  await page.goto('/?bugs=1');
  await expect(page.locator('.feedback-start')).toHaveCount(0); // one round bug button, no wide button over the page
  const primary = page.locator('.fab'), chat = (await page.locator('#chat').boundingBox())!, vp = page.viewportSize()!;
  const bounds = (await primary.boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(56); expect(bounds.x + bounds.width).toBeLessThanOrEqual(vp.width);
  const overlap = !(bounds.x + bounds.width <= chat.x || chat.x + chat.width <= bounds.x || bounds.y + bounds.height <= chat.y || chat.y + chat.height <= bounds.y);
  expect(overlap).toBe(false);
  await primary.click(); await page.getByRole('menuitem', { name: /Leave feedback/ }).click(); await expect(page.locator('.sheet')).toBeVisible();
  await expect(page.locator('.layer')).toHaveCount(0); await expect(page.locator('.extras')).not.toHaveAttribute('open');
  await expect(page.locator('.send')).toBeDisabled();
  await page.locator('#bf-text').fill('Please make this easier to read.');
  expect(parseFloat(await page.locator('#bf-text').evaluate(el => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await page.evaluate(() => { Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 360 }); window.visualViewport!.dispatchEvent(new Event('resize')); });
  const send = (await page.locator('.send').boundingBox())!;
  expect(send.y).toBeGreaterThanOrEqual(0); expect(send.y + send.height).toBeLessThanOrEqual(361);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-keyboard-layout.png') });
  await page.locator('.send').click(); await expect(page.locator('.sent')).toBeVisible();
  expect(payload.description).toBe('Please make this easier to read.'); expect(payload.context.viewport.h).toBe(vp.height);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(primary).toBeVisible(); expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
});

test('phone: tap a spot without dragging and send the selected area', async ({ page }) => {
  let payload: any;
  await page.route('**/api/bugframe/reports', route => route.request().method() === 'POST' ? (payload = route.request().postDataJSON(), route.fulfill({ status: 201, json: { id: 'bug-20261109-100001-bbbb', status: 'open' } })) : route.continue());
  await page.goto('/?bugs=1'); await page.locator('.fab').click(); await page.getByRole('menuitem', { name: /Leave feedback/ }).click();
  await page.getByRole('button', { name: 'Pick a spot' }).click();
  const box = (await page.locator('#total').boundingBox())!; await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.sheet')).toBeVisible();
  await page.locator('#bf-text').fill('This number looks wrong.'); await page.locator('.send').click(); await expect(page.locator('.sent')).toBeVisible();
  expect(payload.context.region.w).toBeLessThan(page.viewportSize()!.width); expect(payload.context.region.h).toBeGreaterThan(0);
});

test('phone: customer requests open as one clear screen with a back button', async ({ page }) => {
  const { PNG_B64 } = await import('../helpers.mjs');
  await page.route('**/api/bugframe/reports', route => route.fulfill({ json: { reports: [{ id: 'bug-20261109-100002-cccc', status: 'ready_for_review', note: 'Updated the heading.', description: 'Please change the heading.', page: '/', kind: 'content', createdAt: '2026-11-09T12:00:00Z', reviewVersion: 1 }] } }));
  await page.route('**/api/bugframe/reports/*/*.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(PNG_B64, 'base64') }));
  await page.goto('/bugs/review?lang=pt'); await page.locator('#reports button').click();
  await expect(page.locator('main > aside')).toBeHidden(); await expect(page.locator('#review-form')).toBeVisible();
  await expect(page.locator('#technical')).toBeHidden(); await expect(page.locator('#agent-panel')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Voltar aos pedidos', exact: true }).click(); await expect(page.locator('main > aside')).toBeVisible();
});

test('phone: on an app page whose CSS matches inline styles, the form opens within 5 seconds', async ({ page }) => {
  // Safari (every iPhone browser) took ~17 s on a real app page with selectors like `:has(> .dot[style*="--red"])`: each
  // style write must be rechecked against them, and the screenshot wrote ~575 properties per element one at a time, with
  // scrolling locked and nothing on screen (2026-11-18). One write per element fixes it.
  await page.goto('/?bugs=1');
  await page.evaluate(() => { const css = document.createElement('style'); css.textContent = '.tabs button:has(> .dot[style*="--red"]) b { color: red } [style*="grid-template-columns"] { gap: 4px } ' + Array.from({ length: 2_000 }, (_, i) => `.r${i} > .c${i % 97} { padding: ${i % 9}px }`).join('\n'); document.head.append(css); });
  await page.evaluate(() => { const box = document.createElement('section'); for (let i = 0; i < 600; i++) { const d = document.createElement('div');
    d.textContent = 'Row ' + i; d.style.cssText = 'padding:4px 8px;margin:2px;border:1px solid #ddd;border-radius:6px;font:14px/1.4 system-ui;color:#333;background:#fafafa'; box.append(d); }
    document.body.prepend(box); });
  await page.locator('.fab').click();
  const t0 = Date.now(); await page.getByRole('menuitem', { name: /Leave feedback/ }).click();
  await expect(page.locator('.sheet')).toBeVisible({ timeout: 5_000 });
  expect(Date.now() - t0).toBeLessThan(5_000);
});
