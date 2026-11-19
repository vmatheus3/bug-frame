// Reproducible documentation screenshots of the real UI, on a fictional website with disposable local accounts.
// `node scripts/capture-docs.mjs a.png b.png` rewrites only those pictures (every step still runs); no names: all.
import { chromium } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`, data = await mkdtemp(join(tmpdir(), 'bugframe-docs-'));
// A disposable copy lets the example headline really change before the customer reviews it.
const demoRoot = join(data, 'app');
await mkdir(join(demoRoot, 'examples/plain-html'), { recursive: true });
for (const name of ['server.mjs', 'studio.mjs', 'index.html', 'login.html', 'review-demo.html', 'audit-demo.html']) await cp(`examples/plain-html/${name}`, join(demoRoot, 'examples/plain-html', name));
await cp('src/server', join(demoRoot, 'src/server'), { recursive: true });
await cp('package.json', join(demoRoot, 'package.json'));
await mkdir(join(demoRoot, 'dist'), { recursive: true });
await cp('dist/bugframe.min.js', join(demoRoot, 'dist/bugframe.min.js'));
const ownerPassword = randomBytes(24).toString('hex'), customerPassword = randomBytes(24).toString('hex'), adminToken = randomBytes(24).toString('hex');
const only = process.argv.slice(2), want = file => !only.length || only.includes(file), written = [];
const demoEnv = { ...process.env, BUGFRAME_DIR: join(data, 'reports'), BUGFRAME_SITE_NAME: 'Northstar · Website review', BUGFRAME_ADMIN_TOKEN: adminToken, BUGFRAME_DEMO_ADMIN_PASSWORD: ownerPassword, BUGFRAME_DEMO_CUSTOMER_PASSWORD: customerPassword };
const server = spawn(process.execPath, ['examples/plain-html/server.mjs'], { cwd: demoRoot, env: { ...demoEnv, PORT: String(port) }, stdio: ['ignore', 'ignore', 'inherit'] });
let browser, second;
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
  const shot = async (page, file, options = {}) => { if (!want(file)) return; await page.screenshot({ path: join(directory, file), animations: 'disabled', ...options }); written.push(file); };
  const capture = (page, file, fullPage = true) => shot(page, file, { fullPage });
  // The CLI as a person runs it: inside the disposable folder, so every path it prints is relative.
  const BIN = join(process.cwd(), 'src/cli/bin.mjs');
  const cli = (args, options = {}) => promisify(execFile)(process.execPath, [BIN, ...args], { cwd: data, timeout: 300_000, env: { ...process.env, BUGFRAME_ADMIN_TOKEN: adminToken }, ...options }).then(r => `${r.stderr}${r.stdout}`.trim(), e => { if (options.allowFailure) return `${e.stderr}${e.stdout}`.trim(); throw e; });
  const esc = text => String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  // A terminal picture: the commands as typed and their real, unedited output, in a plain page.
  const terminal = async (file, blocks) => {
    if (!want(file)) return;
    const context = await browser.newContext({ viewport: { width: 1100, height: 120 }, deviceScaleFactor: 1 }), page = await context.newPage();
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>html{background:#16181d}body{margin:0;color:#e7e5e0;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:22px 26px 8px}pre{margin:0 0 16px;white-space:pre-wrap;overflow-wrap:anywhere}.cmd{color:#f0a070;font-weight:600}.cmd::before{content:"$ ";color:#8a8f98}</style>${blocks.map(b => `<pre class="cmd">${esc(b.command)}</pre><pre>${esc(b.output)}</pre>`).join('')}`);
    await shot(page, file, { fullPage: true }); await context.close();
  };
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
  // "Analyze this page": the developer queues a page analysis from the widget menu on a page with planted problems.
  await owner.goto(origin + '/plans?bugs=1&lang=en');
  await owner.locator('.fab').click(); await owner.locator('.menu .analyze').waitFor();
  await capture(owner, 'analyze-page-menu.png', false);
  await owner.locator('.menu .analyze').click(); await owner.getByRole('status').filter({ hasText: 'Analysis queued' }).waitFor();
  await capture(owner, 'analyze-page-queued.png', false);
  // The real `bugframe audit --watch` run, probe-only (--agent none): no AI model is called.
  await promisify(execFile)(process.execPath, ['src/cli/bin.mjs', 'audit', '--watch', '--once', '--dir', join(data, 'reports'), '--project', demoRoot, '--agent', 'none'], { timeout: 300_000 });
  await owner.goto(origin + '/bugs/?lang=en');
  await owner.locator('#reports button').filter({ hasText: 'Page analysis requested' }).click();
  await owner.locator('#audit-text').filter({ hasText: 'Page audit' }).waitFor();
  // Request, note and the start of the report (summary table and the first two findings): the rest is more of the same.
  const second2 = await owner.locator('#audit-text ul').nth(1).boundingBox();
  await shot(owner, 'page-audit-report.png', { fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.ceil(second2.y + second2.height + 12) } });
  // `bugframe crawl` on the demo dashboard (/studio, problems planted on purpose): a real script-only run, no AI model.
  const crawlOut = join(data, 'crawl');
  // --dir also files the run in the inbox; --save-baseline keeps its findings for the second run below.
  await promisify(execFile)(process.execPath, ['src/cli/bin.mjs', '--dir', join(data, 'reports'), 'crawl', origin + '/studio', '--out', crawlOut, '--save-baseline', join(data, 'crawl-baseline.json')], { timeout: 300_000 });
  const reportContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light' });
  const report = await reportContext.newPage(); await report.goto(pathToFileURL(join(crawlOut, 'crawl.html')).href);
  const box = locator => locator.boundingBox().then(b => { if (!b) throw new Error('crawl report element not found'); return b; });
  const fifth = await box(report.locator('.finding').nth(4));
  await shot(report, 'crawl-report.png', { fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.ceil(fifth.y + fifth.height + 28) } });
  const mapTop = (await box(report.locator('#sitemap'))).y - 20, sixth = await box(report.locator('.map .page').nth(5));
  await shot(report, 'crawl-sitemap.png', { fullPage: true, clip: { x: 0, y: mapTop, width: 1440, height: Math.ceil(sixth.y + sixth.height + 6 - mapTop) } });
  const reportPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light' });
  const phoneReport = await reportPhone.newPage(); await phoneReport.goto(pathToFileURL(join(crawlOut, 'crawl.html')).href);
  await phoneReport.locator('#findings').scrollIntoViewIfNeeded(); await phoneReport.evaluate(() => window.scrollTo(0, document.querySelector('#findings').getBoundingClientRect().top + window.scrollY - 12));
  await capture(phoneReport, 'crawl-report-mobile.png', false);
  await reportPhone.close();
  // The crawl in the inbox (filed by --dir above): a finished page analysis with the rendered short report.
  await owner.goto(origin + '/bugs/?lang=en');
  await owner.locator('#reports button').filter({ hasText: 'Site crawl' }).click();
  await owner.locator('#audit-text h3').filter({ hasText: 'Site crawl' }).waitFor();
  const topIssues = await box(owner.locator('#audit-text ol').first());
  await shot(owner, 'crawl-in-inbox.png', { fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.ceil(topIssues.y + topIssues.height + 40) } });
  // A baseline run. "Version 2" of the dashboard, in the disposable copy only, has two regressions: the Clients "Save"
  // button lost its handler, and a new footer link redirects to another website (which the crawl must never contact).
  const edit = async (file, from, to) => { const path = join(demoRoot, 'examples/plain-html', file), text = await readFile(path, 'utf8'); if (!text.includes(from)) throw new Error(`capture-docs: ${file} no longer contains the text to change`); await writeFile(path, text.replace(from, to)); };
  await edit('studio.mjs', "script: `document.getElementById('save-clients').addEventListener('click', () => fetch('/studio/api/clients', { method: 'POST', body: '{}' }).catch(() => {}));` }),", '}),');
  await edit('studio.mjs', '<footer><a href="/studio/about">About the studio</a>', '<footer><a href="/studio/about">About the studio</a><a href="/studio/partners">Partner portal</a>');
  await edit('server.mjs', "    const html = studioPage(path);", "    if (path === '/studio/partners') { res.writeHead(302, { location: 'https://partners.northstar.example/portal' }); return res.end(); }\n    const html = studioPage(path);");
  const listener2 = createServer(); await new Promise(resolve => listener2.listen(0, '127.0.0.1', resolve));
  const port2 = listener2.address().port; await new Promise(resolve => listener2.close(resolve));
  second = spawn(process.execPath, ['examples/plain-html/server.mjs'], { cwd: demoRoot, env: { ...demoEnv, PORT: String(port2), BUGFRAME_DIR: join(data, 'reports-v2') }, stdio: ['ignore', 'ignore', 'inherit'] });
  for (let tries = 0; ; tries++) { try { if ((await fetch(`http://127.0.0.1:${port2}/api/bugframe/health`)).ok) break; } catch { /* starting */ } if (tries >= 100) throw new Error('The second demo server did not start.'); await pause(100); }
  const baselineOut = join(data, 'crawl-v2');
  await promisify(execFile)(process.execPath, ['src/cli/bin.mjs', 'crawl', `http://127.0.0.1:${port2}/studio`, '--out', baselineOut, '--baseline', join(data, 'crawl-baseline.json')], { timeout: 300_000 });
  const compared = await reportContext.newPage(); await compared.goto(pathToFileURL(join(baselineOut, 'crawl.html')).href);
  await compared.locator('#f-new').selectOption('new');
  const lastNew = await box(compared.locator('.finding:visible').last());
  await shot(compared, 'crawl-baseline.png', { fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.ceil(lastNew.y + lastNew.height + 28) } });
  await reportContext.close();
  // One request that is still open, so the remote worklist and the agent connector have something to carry.
  await customer.goto(origin + '/review-demo?bugs=1&lang=en');
  await customer.locator('.feedback-start').click();
  await customer.locator('#bf-text').fill('The "Start a project" button is hard to find on a phone.');
  const queued = customer.waitForResponse(response => response.url().endsWith('/reports') && response.request().method() === 'POST');
  await customer.locator('.send').click(); await queued;
  // Terminal pictures: real output of the CLI against the demo server.
  const api = `${origin}/api/bugframe`;
  await terminal('cli-doctor.png', [{ command: 'npx bugframe doctor --dir reports', output: await cli(['doctor', '--dir', 'reports']) }]);
  const exported = await cli(['--remote', api, '--allow-localhost', 'export', '--out', 'pulled/WORKLIST.md']);
  const worklist = (await readFile(join(data, 'pulled/WORKLIST.md'), 'utf8')).split('\n');
  await terminal('remote-export.png', [{ command: `npx bugframe --remote ${api} --allow-localhost export --out pulled/WORKLIST.md`, output: exported },
    { command: 'head -16 pulled/WORKLIST.md', output: worklist.slice(0, 16).join('\n') }]);
  const agentCmd = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('my command received:',s.trim()))"`;
  await terminal('connect-agent.png', [{ command: `npx bugframe connect agent --remote ${api} --allow-localhost --project . --agent-cmd '${agentCmd}' --include-existing --once`,
    output: await cli(['connect', 'agent', '--remote', api, '--allow-localhost', '--project', '.', '--state-dir', 'connections', '--agent-cmd', agentCmd, '--include-existing', '--once']) }]);
  console.log(`Updated ${written.length} real UI screenshot${written.length === 1 ? '' : 's'} in docs/images: ${written.join(', ')}. Fictional content; no live accounts or report data used.`);
} finally {
  await browser?.close();
  for (const child of [server, second].filter(Boolean)) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await Promise.race([exited, pause(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  await rm(data, { recursive: true, force: true });
}
