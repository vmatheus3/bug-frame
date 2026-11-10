// Reproducible documentation screenshots of the real UI, on a fictional website with disposable local accounts.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`, data = await mkdtemp(join(tmpdir(), 'bugframe-docs-'));
// A disposable copy lets the example headline really change before the customer reviews it.
const demoRoot = join(data, 'app');
await mkdir(join(demoRoot, 'examples/plain-html'), { recursive: true });
for (const name of ['server.mjs', 'index.html', 'login.html', 'review-demo.html']) await cp(`examples/plain-html/${name}`, join(demoRoot, 'examples/plain-html', name));
await cp('src/server', join(demoRoot, 'src/server'), { recursive: true });
await cp('package.json', join(demoRoot, 'package.json'));
await mkdir(join(demoRoot, 'dist'), { recursive: true });
await cp('dist/bugframe.min.js', join(demoRoot, 'dist/bugframe.min.js'));
const ownerPassword = randomBytes(24).toString('hex'), customerPassword = randomBytes(24).toString('hex');
const server = spawn(process.execPath, ['examples/plain-html/server.mjs'], { cwd: demoRoot, env: { ...process.env, PORT: String(port), BUGFRAME_DIR: join(data, 'reports'), BUGFRAME_SITE_NAME: 'Northstar · Website review', BUGFRAME_DEMO_ADMIN_PASSWORD: ownerPassword, BUGFRAME_DEMO_CUSTOMER_PASSWORD: customerPassword }, stdio: ['ignore', 'ignore', 'inherit'] });
let browser;
const directory = join(process.cwd(), 'docs/images'); await mkdir(directory, { recursive: true });
try {
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(origin + '/api/bugframe/health')).ok) break; } catch { /* starting */ }
    if (tries >= 100 || server.exitCode !== null) throw new Error('The disposable documentation server did not start.');
    await pause(100);
  }
  browser = await chromium.launch();
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light' });
  const customerContext = await browser.newContext({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light' });
  const owner = await ownerContext.newPage(), customer = await customerContext.newPage();
  const login = async (page, password) => { await page.goto(origin + '/login'); await page.getByLabel('Demo password').fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor(); };
  const capture = (page, file, fullPage = true) => page.screenshot({ path: join(directory, file), fullPage, animations: 'disabled' });
  await login(owner, ownerPassword); await login(customer, customerPassword);
  const invitation = await (await owner.request.post(origin + '/api/bugframe/invitations', { data: { email: 'customer@example.test' } })).json();
  await customer.goto(`${origin}/bugs/invite?lang=en#token=${invitation.token}`);
  await customer.locator('#accept').waitFor(); await capture(customer, 'customer-invitation.png');
  await customer.locator('#accept').click(); await customer.locator('#next').waitFor();
  await customer.goto(origin + '/review-demo?bugs=1&lang=en');
  await customer.locator('.feedback-start').click();
  await customer.locator('#bf-text').fill('Could we make this headline clearer?');
  await capture(customer, 'simple-feedback.png');
  await customer.getByRole('button', { name: 'Pick a spot' }).click();
  await customer.locator('.layer').waitFor();
  const area = await customer.locator('#review-headline').boundingBox();
  await customer.mouse.move(area.x - 12, area.y - 12); await customer.mouse.down(); await customer.mouse.move(area.x + area.width + 12, area.y + area.height + 12, { steps: 12 });
  await capture(customer, 'frame-the-problem.png'); await customer.mouse.up(); await customer.locator('.sheet').waitFor();
  await customer.locator('.extras summary').click(); await customer.getByRole('button', { name: 'Change text or an image', exact: true }).click();
  await customer.locator('#bf-text').fill('Could we make the headline more about our customers?');
  await customer.locator('#bf-currentText').fill('Thoughtful websites. Built together.');
  await customer.locator('#bf-suggestedText').fill('Websites your customers love.');
  await capture(customer, 'describe-and-send.png');
  const sent = customer.waitForResponse(response => response.url().endsWith('/reports') && response.request().method() === 'POST');
  await customer.locator('.send').click(); const { id } = await (await sent).json();
  await owner.goto(origin + '/bugs/?lang=en');
  await owner.locator('#reports button').filter({ hasText: 'Could we make the headline' }).click();
  await owner.locator('#region').waitFor();
  await owner.locator('#status').selectOption('in_progress'); await owner.locator('#note').fill('We’re updating the headline to speak directly to your customers.');
  await owner.locator('#save').click(); await owner.getByRole('status').filter({ hasText: 'Status saved.' }).waitFor();
  await capture(owner, 'bugframe-overview.png');
  const example = join(demoRoot, 'examples/plain-html/review-demo.html');
  await writeFile(example, (await readFile(example, 'utf8')).replace('Thoughtful websites.<br>Built together.', 'Websites your<br>customers love.'));
  await owner.locator('#status').selectOption('ready_for_review'); await owner.locator('#note').fill('The new headline is ready. Please check the page and tell us what you think.');
  await owner.locator('#save').click(); await owner.locator('#resolution').filter({ hasText: 'new headline is ready' }).waitFor();
  await customer.goto(origin + '/bugs/review?lang=en');
  await customer.locator('#reports button').filter({ hasText: 'Could we make the headline' }).click(); await customer.locator('#review-form').waitFor();
  await capture(customer, 'customer-review.png');
  await customer.locator('#language').selectOption('es'); await capture(customer, 'customer-review-es.png');
  await customer.locator('#language').selectOption('pt'); await capture(customer, 'customer-review-pt.png');
  await customer.locator('#language').selectOption('en');
  await customer.locator('#approve').click(); await customer.getByRole('status').filter({ hasText: 'Approved. Thank you!' }).waitFor();
  await capture(customer, 'customer-approved.png');
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await customerContext.storageState(), locale: 'en-US', colorScheme: 'light' });
  const phone = await phoneContext.newPage(); await phone.goto(origin + '/review-demo?bugs=1&lang=en'); await phone.locator('.feedback-start').click(); await phone.locator('#bf-text').fill('Please make this button easier to see.'); await capture(phone, 'mobile-feedback.png', false); await phoneContext.close();
  console.log('Updated 10 real UI screenshots in docs/images. Fictional content; no live accounts or report data used.');
} finally {
  await browser?.close();
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill();
  await Promise.race([exited, pause(5000)]); if (server.exitCode === null) server.kill('SIGKILL');
  await rm(data, { recursive: true, force: true });
}
