import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SESSION_COOKIE, startCrawlSite } from './fixtures/crawl-site/server.mjs';
import { startHostileSite } from './fixtures/crawl-site/hostile.mjs';

// The whole-site crawl runs against a CRM-like fixture with planted wiring problems. The fixture records every request,
// so the test proves that no write, destructive call, sign-out or WebSocket ever reached it.
type Site = Awaited<ReturnType<typeof startCrawlSite>>;
let site: Site, work = '';
test.beforeAll(async () => { site = await startCrawlSite(); work = mkdtempSync(join(tmpdir(), 'bugframe-e2e-crawl-')); });
test.afterAll(async () => { await site.close(); rmSync(work, { recursive: true, force: true }); });

test('bugframe crawl maps the whole site, finds every planted problem and never lets a write leave the browser', async ({ page }) => {
  test.setTimeout(240_000);
  const out = join(work, 'out'), auth = join(work, 'auth.json');
  // A saved session, as `bugframe crawl login` would write it, for the login-protected /account page.
  writeFileSync(auth, JSON.stringify({ cookies: [{ name: SESSION_COOKIE, value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
  const { code, stdout } = await new Promise<{ code: number; stdout: string }>(r => execFile(process.execPath, ['src/cli/bin.mjs', '--dir', join(work, 'reports'), 'crawl', `${site.base}/`, '--out', out, '--storage-state', auth, '--fail-on', 'high'], { timeout: 220_000 },
    (err, so) => r({ code: err ? Number((err as { code?: number }).code) : 0, stdout: so })));
  expect(stdout).toContain('crawl.html');
  expect(code).toBe(1); // --fail-on high and there are high findings

  // Safety: no write, no destructive call, no sign-out, no WebSocket, and the 50 client records were not crawled 50 times.
  expect(site.seen.filter(r => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([]);
  expect(site.seen.some(r => r.path.startsWith('/api/account') || r.path === '/api/save')).toBe(false);
  expect(site.seen.some(r => r.path === '/logout')).toBe(false);
  expect(site.sockets).toEqual([]);
  expect(new Set(site.seen.filter(r => /^\/clients\/\d+$/.test(r.path)).map(r => r.path)).size).toBeLessThanOrEqual(2);

  const crawl = JSON.parse(readFileSync(join(out, 'crawl.json'), 'utf8'));
  const paths: string[] = crawl.pages.map((p: { path: string }) => p.path);
  for (const p of ['/', '/clients', '/about', '/contact', '/support', '/app', '/orphan', '/account']) expect(paths).toContain(p);
  expect(paths.filter(p => /^\/clients\/\d+$/.test(p))).toHaveLength(2);
  expect(crawl.skipped.template).toContainEqual(expect.objectContaining({ route: '/clients/:id', count: 48 }));
  const pageOf = (p: string) => crawl.pages.find((x: { path: string }) => x.path === p);
  expect(pageOf('/app#/reports').via).toBe('click'); // the hash route is reachable only by clicking "Open reports"
  expect(pageOf('/account')).toMatchObject({ status: 200, title: 'Account · Fixture CRM' }); // signed in through the saved state
  expect(pageOf('/orphan').via).toBe('sitemap');

  type Edge = { page: string; label: string; outcome: string; calls?: string[]; reason?: string; to?: string; kind: string };
  const edge = (page: string, label: string) => crawl.edges.find((e: Edge) => e.page === page && e.label === label && e.kind === 'button');
  expect(edge('/', 'Save')).toMatchObject({ outcome: 'calls-backend', calls: ['POST /api/save'] });
  expect(edge('/', 'Delete account')).toMatchObject({ outcome: 'skipped', reason: 'destructive' });
  expect(edge('/', 'Open menu').outcome).toBe('opens');
  expect(edge('/app', 'Open reports')).toMatchObject({ outcome: 'navigates', to: '/app#/reports' });
  expect(edge('/app#/reports', 'Refresh reports')).toMatchObject({ outcome: 'calls-backend', calls: ['GET /api/reports'] });
  expect(crawl.edges.find((e: Edge) => e.page === '/account' && e.label === 'Sign out').outcome).toBe('skipped');
  expect(crawl.blockedRequests).toContainEqual({ method: 'WEBSOCKET', url: '/live' });

  type Finding = { type: string; title: string; pages: string[]; selector: string; evidence: string; severity: string };
  const find = (type: string, pred: (f: Finding) => boolean = () => true) => crawl.findings.find((f: Finding) => f.type === type && pred(f));
  expect(find('dead-control', f => f.selector === '#export' && f.severity === 'high')).toBeTruthy();
  expect(find('dead-control', f => f.selector === '#client-save')).toBeTruthy();
  expect(find('broken-link', f => /\/pricing is broken \(404\)/.test(f.title))).toBeTruthy();
  expect(find('orphan-route', f => f.pages[0] === '/orphan')).toBeTruthy();
  expect(find('nav-inconsistent', f => f.pages.includes('/about') && /"Contact" points to \/support instead of \/contact/.test(f.evidence) && /missing "App"/.test(f.evidence))).toBeTruthy();
  expect(find('label-multiple-destinations', f => /"Contact"/.test(f.title))).toBeTruthy();
  expect(find('action-inconsistent', f => /"Save"/.test(f.title) && /calls-backend POST \/api\/save on \/; dead on \/clients\/1/.test(f.evidence))).toBeTruthy();
  expect(find('repeated-console-error', f => /Theme config missing/.test(f.title) && f.pages.length >= 8)).toBeTruthy();

  // Reports: the agent's Markdown and a self-contained HTML page with the page text escaped.
  const html = readFileSync(join(out, 'crawl.html'), 'utf8'), md = readFileSync(join(out, 'CRAWL.md'), 'utf8');
  expect(html).not.toContain('<img src=x onerror=alert(1)>');
  expect(html).toContain('Export &lt;img src=x onerror=alert(1)&gt;');
  expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  expect(html).toContain('src="data:image/jpeg;base64,');
  expect(md).toContain('## Wiring map');
  expect(md).toMatch(/\| \/ \| Save \| button \| calls-backend \| POST \/api\/save \|/);
  for (const p of crawl.pages) if (p.screenshot) expect(existsSync(join(out, p.screenshot))).toBe(true);
  // crawl.html in a browser: the filters really hide what they filter out, and the counter matches what is on screen.
  await page.goto(pathToFileURL(join(out, 'crawl.html')).href);
  const total = await page.locator('.finding').count(), high = crawl.findings.filter((f: Finding) => f.severity === 'high').length;
  expect(total).toBe(crawl.findings.length); expect(high).toBeGreaterThan(0); expect(high).toBeLessThan(total);
  await expect(page.locator('.finding:visible')).toHaveCount(total);
  await page.locator('#f-sev').selectOption('high');
  await expect(page.locator('.finding:visible')).toHaveCount(high);
  await expect(page.locator('#shown')).toHaveText(String(high));
  await page.locator('#f-text').fill('Export');
  await expect(page.locator('.finding:visible')).toHaveCount(1);
  await page.locator('#f-text').fill('nothing matches this text');
  await expect(page.locator('.finding:visible')).toHaveCount(0);
  // --dir files the crawl in the inbox: a finished page analysis with the short report and a real picture of the start page.
  const [filed] = readdirSync(join(work, 'reports'));
  expect(stdout).toContain(`Filed in the inbox at ${join(work, 'reports')} as ${filed}`);
  const report = JSON.parse(readFileSync(join(work, 'reports', filed, 'report.json'), 'utf8'));
  expect(report).toMatchObject({ kind: 'audit', status: 'ready_for_review', files: { audit: 'audit.md' } });
  expect(readFileSync(join(work, 'reports', filed, 'audit.md'), 'utf8')).toMatch(/^# Site crawl: http:\/\/127\.0\.0\.1:\d+/);
  expect(readFileSync(join(work, 'reports', filed, 'full.png')).length).toBeGreaterThan(2000);
});

// The hostile fixture tries every way around the guard. Its two servers record what reached them.
test.describe('crawl guard against a hostile site', () => {
  type Hostile = Awaited<ReturnType<typeof startHostileSite>>;
  type Edge = { page: string; label: string; outcome: string; calls?: string[]; reason?: string; to?: string; kind: string };
  let hostile: Hostile, dir = '';
  const crawl = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(r => execFile(process.execPath, ['src/cli/bin.mjs', 'crawl', ...args], { timeout: 220_000 },
    (err, stdout, stderr) => r({ code: err ? Number((err as { code?: number }).code) : 0, stdout, stderr })));
  test.beforeAll(async () => { hostile = await startHostileSite(); dir = mkdtempSync(join(tmpdir(), 'bugframe-e2e-hostile-')); });
  test.afterAll(async () => { await hostile.close(); rmSync(dir, { recursive: true, force: true }); });

  test('workers, shared workers and iframes cannot open a socket or send a write; redirects never leave the site; the session survives', async () => {
    test.setTimeout(240_000);
    const out = join(dir, 'out');
    const { stdout } = await crawl([`${hostile.base}/`, '--out', out, '--viewports', '1280x800', '--max-pages', '30']);
    expect(stdout).toContain('crawl.html');
    const data = JSON.parse(readFileSync(join(out, 'crawl.json'), 'utf8'));
    const requested = (p: string) => hostile.seen.some(r => r.path === p);
    const edge = (page: string, label: string) => data.edges.find((e: Edge) => e.page === page && e.label === label);
    const blocked: { method: string; url: string }[] = data.blockedRequests;

    // 1. No WebSocket from a page, an iframe, a worker, a module worker, a blob worker or a SharedWorker; no write at all.
    expect(hostile.sockets).toEqual([]);
    expect(hostile.seen.filter(r => r.method !== 'GET' && r.method !== 'HEAD')).toEqual([]);
    for (const ws of ['/worker-ws', '/imported-ws', '/module-ws', '/module-dep-ws', '/blob-ws', '/frame-ws']) expect(blocked, ws).toContainEqual({ method: 'WEBSOCKET', url: ws });
    expect(blocked).toContainEqual({ method: 'POST', url: '/api/worker-write' });
    expect(blocked).toContainEqual({ method: 'SHAREDWORKER', url: '/shared.js' });
    // A write the guard blocked rejects in the page; that "Failed to fetch" is the guard's doing, not an error of the click.
    expect(edge('/', 'Sync now')).toMatchObject({ outcome: 'calls-backend', calls: ['POST /api/sync'] });
    expect(requested('/shared.js')).toBe(false); // a SharedWorker's requests cannot be guarded, so it never starts
    expect(requested('/nested.js')).toBe(false); // nor can a worker started by a worker
    // The guarded dedicated worker still runs: it answered the page (strict mode and its own query string intact).
    expect(edge('/workers', 'Ask the worker').outcome).toBe('changes');

    // 2. Redirects that leave the site are not followed, from a link, a click or a page load; the report names the target.
    expect(hostile.otherSeen).toEqual([]);
    const off = data.findings.filter((f: { type: string }) => f.type === 'offsite-redirect');
    expect(off.map((f: { title: string }) => f.title).join('\n')).toContain(`${hostile.otherBase}/landing`);
    expect(off.map((f: { title: string }) => f.title).join('\n')).toContain(`${hostile.otherBase}/clicked`);
    expect(JSON.stringify(data.pages)).not.toContain('"redirectedTo":"/landing'); // never shown as a local path
    // A redirect that stays on the site still works, by page load and by click.
    expect(data.pages.find((p: { path: string }) => p.path === '/hop')).toMatchObject({ redirectedTo: '/landed' });
    expect(data.pages.find((p: { path: string }) => p.path === '/landed')).toMatchObject({ status: 200 });
    expect(edge('/', 'Open moved page')).toMatchObject({ outcome: 'navigates', to: '/landed' });
    expect(edge('/', 'Open partner').outcome).toBe('navigates');
    expect(edge('/', 'Open partner').reason).toContain(`${hostile.otherBase}/clicked`);

    // 3. Session-ending controls: "Log off", a Portuguese label, a sign-out link with a harmless URL, and a click
    //    that fires GET /api/logout are never clicked, crawled or sent.
    for (const p of ['/logoff', '/session/end', '/bye', '/api/logout']) expect(requested(p), p).toBe(false);
    expect(edge('/', 'Log off')).toMatchObject({ outcome: 'skipped', reason: 'destructive' });
    expect(edge('/', 'Encerrar sessão')).toMatchObject({ outcome: 'skipped', reason: 'destructive' });
    expect(edge('/', 'Switch workspace').calls?.join()).toContain('GET /api/logout');
    expect(data.pages.some((p: { path: string }) => ['/logoff', '/bye', '/session/end'].includes(p.path))).toBe(false);

    // 4. A dead href="#" link is dead, not "navigates to this page"; a working in-page anchor is not flagged.
    expect(edge('/', 'Hash dead')).toMatchObject({ kind: 'button', outcome: 'dead' });
    expect(data.findings.some((f: { type: string; selector: string }) => f.type === 'dead-control' && f.selector === '#hash-dead')).toBe(true);
    expect(data.findings.some((f: { selector: string }) => f.selector === '#to-notes')).toBe(false);

    // 5. On a page that keeps polling and ticking, a handler-less button is "unknown", not "calls-backend"; a real one is found.
    expect(edge('/poll', 'Archive').outcome).toBe('unknown');
    expect(edge('/poll', 'Archive').reason).toMatch(/keeps changing on its own/);
    expect(edge('/poll', 'Filters').outcome).toBe('opens');
    expect(data.findings.some((f: { selector: string }) => f.selector === '#archive')).toBe(false);

    // 6. The endless calendar is one route: two months opened, the rest counted.
    expect(new Set(hostile.seen.filter(r => r.path.startsWith('/cal/')).map(r => r.path)).size).toBeLessThanOrEqual(2);
    expect(data.pages.filter((p: { route: string }) => p.route === '/cal/:date')).toHaveLength(2);
  });

  test('a start URL that redirects to another site is refused before anything is fetched there', async () => {
    test.setTimeout(120_000);
    hostile.otherSeen.length = 0;
    const out = join(dir, 'out-start');
    const { stdout } = await crawl([`${hostile.base}/out`, '--out', out, '--viewports', '1280x800', '--no-click']);
    expect(hostile.otherSeen).toEqual([]);
    const data = JSON.parse(readFileSync(join(out, 'crawl.json'), 'utf8'));
    expect(data.findings.map((f: { type: string }) => f.type)).toContain('offsite-redirect');
    expect(data.pages[0]).toMatchObject({ path: '/out', status: 302 });
    expect(stdout).toContain('crawl.html');
    // A baseline turns --fail-on into a ratchet: the same findings fail a plain run and pass a baselined one.
    const baseline = join(dir, 'crawl-baseline.json'), args = [`${hostile.base}/out`, '--viewports', '1280x800', '--no-click', '--fail-on', 'low'];
    const plain = await crawl([...args, '--out', join(dir, 'out-plain'), '--save-baseline', baseline]);
    expect(plain.code).toBe(1); expect(plain.stdout).toContain('Saved the baseline');
    expect(Object.values(JSON.parse(readFileSync(baseline, 'utf8')).fingerprints)).toContainEqual(expect.objectContaining({ type: 'offsite-redirect', severity: 'low' }));
    const ratchet = await crawl([...args, '--out', join(dir, 'out-ratchet'), '--baseline', baseline]);
    expect(ratchet.code).toBe(0); expect(ratchet.stdout).toMatch(/Since the baseline: 0 new, 1 known, 0 fixed/);
    expect((await crawl([...args, '--out', join(dir, 'out-bad'), '--baseline', join(dir, 'missing.json')])).code).toBe(2);
  });
});
