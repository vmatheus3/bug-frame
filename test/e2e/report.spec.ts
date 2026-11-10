import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signIn } from './session';

const DIR = '.e2e-reports';
const CLI = (...args: string[]) => execFileSync('node', ['src/cli/bin.mjs', ...args], { encoding: 'utf8' }).trim();
const pngSize = (file: string) => { const b = readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };

test.beforeAll(() => rmSync(DIR, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => signIn(page));

async function openMenu(page: Page) {
  await page.goto('/?bugs=1');
  await page.locator('.fab').click();
}
async function dragOver(page: Page, selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  const x0 = box.x - 8, y0 = box.y - 8, x1 = box.x + box.width + 8, y1 = box.y + box.height + 8;
  await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 }); await page.mouse.move(x1, y1, { steps: 5 }); await page.mouse.up();
}

test('drag a box, describe, send: the report lands on disk and the CLI exports it', async ({ page }) => {
  await openMenu(page);
  await page.getByRole('menuitem', { name: /Leave feedback on this page/ }).click();
  await expect(page.locator('.sheet')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => console.error('Demo error before report'));
  await page.getByRole('button', { name: 'Pick a spot' }).click();
  await dragOver(page, '#total');
  await expect(page.locator('.sheet')).toBeVisible();
  await expect(page.locator('.preview')).toHaveAttribute('src', /^data:image\/png/);
  await page.locator('textarea').fill('The total is wrong, it should be $1,420.00');
  await page.locator('.extras summary').click();
  await page.getByRole('button', { name: 'Something isn’t working', exact: true }).click();
  const [request] = await Promise.all([page.waitForRequest(r => r.url().endsWith('/api/bugframe/reports') && r.method() === 'POST'), page.locator('.send').click()]);
  await expect(page.locator('.sent')).toBeVisible();

  // The pictures: masked fields are painted over in the full screenshot, the region is smaller than the full page picture.
  const body = JSON.parse(request.postData()!);
  const pixel = await page.evaluate(async ({ full, sel }) => {
    const img = new Image(); img.src = full; await img.decode();
    const el = document.querySelector(sel)!.getBoundingClientRect(), s = img.naturalWidth / window.innerWidth;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(Math.round((el.left + 6) * s), Math.round((el.top + el.height / 2) * s), 1, 1).data);
  }, { full: body.full as string, sel: '#password' });
  expect(pixel.slice(0, 3)).toEqual([58, 63, 75]);
  const acct = await page.evaluate(async ({ full, sel }) => {
    const img = new Image(); img.src = full; await img.decode();
    const el = document.querySelector(sel)!.getBoundingClientRect(), s = img.naturalWidth / window.innerWidth;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(Math.round((el.left + 4) * s), Math.round((el.top + el.height / 2) * s), 1, 1).data);
  }, { full: body.full as string, sel: '#acct' });
  expect(acct.slice(0, 3)).toEqual([58, 63, 75]);

  const ids = readdirSync(DIR).filter(n => n.startsWith('bug-'));
  expect(ids.length).toBe(1);
  const id = ids[0];
  expect(readdirSync(join(DIR, id)).sort()).toEqual(['full.png', 'region.png', 'report.json']);
  const region = pngSize(join(DIR, id, 'region.png')), full = pngSize(join(DIR, id, 'full.png'));
  expect(region.w).toBeLessThan(full.w); expect(region.h).toBeLessThan(full.h);
  const report = JSON.parse(readFileSync(join(DIR, id, 'report.json'), 'utf8'));
  expect(report.description).toContain('$1,420.00'); expect(report.kind).toBe('bug'); expect(report.types).toEqual([]); expect(report.status).toBe('open');
  expect(report.context.url).toContain('/?bugs=1'); expect(report.context.viewport.w).toBeGreaterThan(300);
  expect(report.context.elements.some((e: { component: string; path: string }) => e.component.includes('invoice-summary') || e.path.includes('total'))).toBe(true);
  expect(report.context.consoleErrors.some((e: { message: string }) => e.message.includes('Demo error before report'))).toBe(true);

  // CLI: export a grouped worklist, close it, and see the answer in "My requests".
  expect(CLI('--dir', DIR, 'export')).toMatch(/1 report/);
  const md = readFileSync(join(DIR, 'WORKLIST.md'), 'utf8');
  expect(md).toContain('The total is wrong'); expect(md).toContain(`${id}/region.png`); expect(md).toContain('## /');
  expect(existsSync(join(DIR, `${id}/region.png`))).toBe(true);
  CLI('--dir', DIR, 'close', id, '--note', 'Corrected the total calculation');
  await page.reload();
  await page.locator('.fab').click();
  await expect(page.locator('.menu')).toContainText('Fixed');
  await expect(page.locator('.menu')).toContainText('Corrected the total calculation');
  await expect(page.locator('.menu .thumb').first()).toHaveAttribute('src', /^blob:/);
});

test('whole screen, and the tool stays off without ?bugs=1', async ({ page }) => {
  await page.goto('/?bugs=0');
  await expect(page.locator('[data-bugframe]')).toHaveCount(0);
  await openMenu(page);
  await page.getByRole('menuitem', { name: /Leave feedback/ }).click();
  await page.getByRole('button', { name: 'Pick a spot' }).click(); await page.getByRole('button', { name: 'Whole screen' }).click();
  await page.locator('textarea').fill('Everything looks off');
  await page.locator('.send').click();
  await expect(page.locator('.sent')).toBeVisible();
  await page.goto('/');                                    // still on without the query string
  await expect(page.locator('.fab')).toBeVisible();
  await page.locator('.fab').click(); await page.getByRole('menuitem', { name: /Turn off/ }).click();
  await expect(page.locator('[data-bugframe]')).toHaveCount(0);
});

test('keyboard only: open, pick a region with the arrow keys, type, send', async ({ page }) => {
  await page.goto('/?bugs=1');
  await page.locator('.fab').focus(); await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /Leave feedback/ }).press('Enter');
  await page.getByRole('button', { name: 'Pick a spot' }).click();
  await expect(page.locator('.layer')).toBeFocused({ timeout: 20_000 });
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter');
  await expect(page.locator('.sheet')).toBeVisible();
  await page.locator('textarea').fill('Keyboard report'); await page.keyboard.press('Escape');
  await expect(page.locator('.sheet')).toHaveCount(0);
  await expect(page.locator('.feedback-start')).toBeFocused();
});

test('download mode: no backend, a .zip is saved and `bugframe import` reads it', async ({ page }) => {
  await page.route(/download\.html/, r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title><h1>Static</h1><script src="/bugframe.min.js" data-download></script>' }));
  await page.goto('/download.html?bugs=1');
  await page.locator('.fab').click();
  await expect(page.locator('.menu .list')).toHaveCount(0);
  await page.getByRole('menuitem', { name: /Leave feedback/ }).click();
  await page.getByRole('button', { name: 'Pick a spot' }).click(); await page.getByRole('button', { name: 'Whole screen' }).click();
  await page.locator('textarea').fill('Static page problem');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.send').click()]);
  const tmp = mkdtempSync(join(tmpdir(), 'bf-e2e-')); const zip = join(tmp, 'r.zip'); await download.saveAs(zip);
  expect(CLI('--dir', join(tmp, 'reports'), 'import', zip)).toMatch(/Imported 1 report/);
  expect(CLI('--dir', join(tmp, 'reports'), 'list')).toContain('Static page problem');
  rmSync(tmp, { recursive: true, force: true });
});

test('private inbox shows safe report content and screenshots, updates status, then clears on revocation', async ({ page }, testInfo) => {
  expect((await page.request.get('/bugs/')).status()).toBe(403); // an approved reporter is not an admin
  await signIn(page, 'e2e-admin-password');
  const { PNG_URL } = await import('../helpers.mjs');
  const description = '<img src=x onerror=alert(1)> Example report';
  const res = await page.request.post('/api/bugframe/reports', { data: { description, region: PNG_URL, full: PNG_URL, context: { url: 'javascript:alert(1)', viewport: { w: 390, h: 844 }, consoleErrors: [{ at: 'now', message: '<script>untrusted()</script>' }] } } });
  expect(res.status()).toBe(201); const { id } = await res.json();
  await page.goto('/bugs/');
  await page.locator('#reports button').filter({ hasText: description }).click();
  await expect(page.locator('#description')).toHaveText(description);
  await expect(page.locator('#description img')).toHaveCount(0);
  await expect(page.locator('#page-link')).toBeHidden();
  await expect(page.locator('#region')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('#full')).toHaveAttribute('src', /^blob:/);
  await page.locator('#technical summary').click(); await expect(page.locator('#context')).toContainText('<script>untrusted()</script>');
  await page.screenshot({ path: testInfo.outputPath('inbox.png'), fullPage: true });
  await page.getByLabel('Status', { exact: true }).selectOption('fixed');
  await page.getByLabel('Note for the reporter').fill('Deployed and verified');
  await page.getByRole('button', { name: 'Save status' }).click();
  await expect(page.getByRole('status')).toHaveText('Status saved.');
  expect((await (await page.request.get(`/api/bugframe/reports/${id}`)).json()).status).toBe('fixed');
  await page.request.post('/logout', { headers: { origin: 'http://127.0.0.1:4455' } });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#detail')).toBeHidden();
  await expect(page.locator('#description')).toBeEmpty();
  await expect(page.locator('#context')).toBeEmpty();
  await expect(page.locator('#note')).toHaveValue('');
  await expect(page.getByRole('status')).toContainText('administrator session');
  expect((await page.request.get(`/api/bugframe/reports/${id}/region.png`)).status()).toBe(401);
});

test('developer invites a customer, who suggests a content change, requests an adjustment and approves the next delivery', async ({ page, browser }, testInfo) => {
  await signIn(page, 'e2e-admin-password');
  await page.goto('/bugs/');
  await page.locator('#invitations-panel summary').click();
  await page.getByLabel('Customer email').fill('customer@example.test');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.locator('#invite-result')).toBeVisible();
  const inviteUrl = await page.locator('#invite-link').inputValue();
  expect(inviteUrl).toMatch(/\/bugs\/invite#token=[a-f0-9]{64}$/);
  const customerContext = await browser.newContext(); const customer = await customerContext.newPage();
  try {
    await customer.goto(inviteUrl);
    expect(new URL(customer.url()).hash).toBe('');
    await customer.locator('#language').selectOption('es');
    await expect(customer.getByRole('button', { name: 'Aceptar invitación', exact: true })).toBeVisible();
    await customer.locator('#language').selectOption('pt');
    await expect(customer.getByRole('button', { name: 'Aceitar convite', exact: true })).toBeVisible();
    await customer.locator('#language').selectOption('en');
    await customer.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(customer.getByRole('status')).toContainText('Sign in');
    await signIn(customer, 'e2e-customer-password');
    expect((await customer.request.post('/api/bugframe/reports', { data: {} })).status()).toBe(401);
    await customer.goto(inviteUrl);
    await customer.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(customer.getByRole('status')).toContainText('You’re ready');
    await customer.getByRole('link', { name: 'Review the website' }).click();
    await customer.locator('.fab').click(); await customer.getByRole('menuitem', { name: /Leave feedback/ }).click();
    await customer.getByRole('button', { name: 'Pick a spot' }).click(); await customer.getByRole('button', { name: 'Whole screen' }).click();
    await customer.locator('.extras summary').click(); await customer.getByRole('button', { name: 'Change text or an image', exact: true }).click();
    await customer.getByLabel('What would you like to change?').fill('Please use a friendlier headline');
    await customer.getByLabel('Current wording (optional)').fill('Invoice #4021');
    await customer.getByLabel('Suggested wording (optional)').fill('Your project summary');
    const sent = customer.waitForResponse(response => response.url().endsWith('/reports') && response.request().method() === 'POST');
    await customer.getByRole('button', { name: 'Send feedback', exact: true }).click();
    const { id } = await (await sent).json();
    expect((await customer.request.get('/bugs/')).status()).toBe(403);
    expect((await customer.request.get(`/api/bugframe/reports/${id}`)).status()).toBe(403);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('#reports button').filter({ hasText: 'Please use a friendlier headline' }).click();
    await expect(page.locator('#suggested-text')).toHaveText('Your project summary');
    await expect(page.locator('#region')).toHaveAttribute('src', /^blob:/);
    await page.getByLabel('Status', { exact: true }).selectOption('in_progress');
    await page.getByLabel('Note for the reporter').fill('We are updating the headline.');
    await page.getByRole('button', { name: 'Save status' }).click();
    await expect(page.getByRole('status')).toHaveText('Status saved.');
    await page.getByLabel('Status', { exact: true }).selectOption('ready_for_review');
    await page.getByLabel('Note for the reporter').fill('The headline was updated. Please review.');
    await page.getByRole('button', { name: 'Save status' }).click();
    await expect(page.locator('#activity')).toContainText('Ready for your review');
    await customer.goto('/bugs/review');
    await customer.locator('#reports button').filter({ hasText: 'Please use a friendlier headline' }).click();
    await expect(customer.locator('#technical')).toBeHidden(); await expect(customer.locator('#invitations-panel')).toBeHidden();
    await customer.getByLabel('What still needs adjustment?', { exact: false }).fill('Please make it shorter.');
    await customer.getByRole('button', { name: 'Request an adjustment', exact: true }).click();
    await expect(customer.getByRole('status')).toContainText('adjustment request was sent');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#customer-note')).toContainText('Please make it shorter.');
    await page.getByLabel('Status', { exact: true }).selectOption('ready_for_review');
    await page.getByLabel('Note for the reporter').fill('Shortened it. Please check the page again.');
    await page.getByRole('button', { name: 'Save status' }).click();
    await expect(page.locator('#resolution')).toContainText('Shortened it.');
    await customer.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(customer.locator('#review-form')).toBeVisible();
    await customer.screenshot({ path: testInfo.outputPath('customer-review.png'), fullPage: true });
    await customer.getByRole('button', { name: 'Looks good', exact: true }).click();
    await expect(customer.getByRole('status')).toHaveText('Approved. Thank you!');
    await expect(customer.locator('#review-form')).toBeHidden();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#info')).toContainText('Approved');
    const row = page.locator('#invitations li').filter({ hasText: 'customer@example.test' }).filter({ has: page.getByRole('button', { name: 'Revoke access' }) });
    await row.getByRole('button', { name: 'Revoke access' }).click();
    await customer.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(customer.locator('#detail')).toBeHidden();
    await expect(customer.getByRole('status')).toContainText('access has expired');
    expect((await customer.request.get(`/api/bugframe/reports/${id}/region.png`)).status()).toBe(401);
  } finally { await customerContext.close(); }
});

for (const [locale, statusLabel, saveLabel, saved, approval, approved, invitationHeading] of [
  ['en', 'Status', 'Save status', 'Status saved.', 'Looks good', 'Approved. Thank you!', 'Customer invitations'],
  ['es', 'Estado', 'Guardar estado', 'Estado guardado.', 'Está bien', 'Aprobado. ¡Gracias!', 'Invitaciones de clientes'],
  ['pt', 'Status', 'Salvar status', 'Status salvo.', 'Está bom', 'Aprovado. Obrigado!', 'Convites de clientes'],
]) {
  test(`${locale}: developer and customer copy, validation, approval and drafts follow the selected language`, async ({ page, browser }) => {
    const { PNG_URL } = await import('../helpers.mjs');
    const description = `Language workflow ${locale}`;
    const created = await page.request.post('/api/bugframe/reports', { data: { description, kind: 'content', currentText: 'Before', suggestedText: 'After', region: PNG_URL, full: PNG_URL, context: { url: 'http://127.0.0.1:4455/' } } });
    const { id } = await created.json();
    await signIn(page, 'e2e-admin-password'); await page.goto(`/bugs/?lang=${locale}`);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('#invitations-panel summary')).toHaveText(invitationHeading);
    await page.locator('#reports button').filter({ hasText: description }).click();
    await page.locator('#note').fill('Unsaved developer note');
    await page.locator('#status').selectOption('in_progress');
    await page.locator('#language').selectOption(locale === 'es' ? 'pt' : 'es');
    await expect(page.locator('#note')).toHaveValue('Unsaved developer note'); await expect(page.locator('#status')).toHaveValue('in_progress');
    await page.locator('#language').selectOption(locale);
    await page.getByLabel(statusLabel, { exact: true }).selectOption('ready_for_review');
    await page.getByRole('button', { name: saveLabel, exact: true }).click(); await expect(page.getByRole('status')).toHaveText(saved);
    const context = await browser.newContext({ locale }); const customer = await context.newPage();
    try {
      await signIn(customer); await customer.goto(`/bugs/review?lang=${locale}`);
      await customer.locator('#reports button').filter({ hasText: description }).click();
      await customer.locator('#request-changes').click();
      await expect(customer.getByRole('status')).toHaveText({ en: 'Describe what still needs adjustment.', es: 'Describe qué falta ajustar.', pt: 'Descreva o que ainda precisa de ajuste.' }[locale]!);
      await customer.locator('#adjustment').fill('Keep this customer draft');
      await customer.locator('#language').selectOption(locale === 'pt' ? 'es' : 'pt');
      await expect(customer.locator('#adjustment')).toHaveValue('Keep this customer draft');
      await customer.locator('#language').selectOption(locale);
      await customer.getByRole('button', { name: approval, exact: true }).click(); await expect(customer.getByRole('status')).toHaveText(approved);
      await customer.locator('#language').selectOption(locale === 'es' ? 'en' : 'es');
      await expect(customer.getByRole('status')).not.toHaveText(approved);
    } finally { await context.close(); }
  });
}
