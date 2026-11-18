import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, startCrawlSite } from './fixtures/crawl-site/server.mjs';

// The whole-site crawl runs against a CRM-like fixture with planted wiring problems. The fixture records every request,
// so the test proves that no write, destructive call, sign-out or WebSocket ever reached it.
type Site = Awaited<ReturnType<typeof startCrawlSite>>;
let site: Site, work = '';
test.beforeAll(async () => { site = await startCrawlSite(); work = mkdtempSync(join(tmpdir(), 'bugframe-e2e-crawl-')); });
test.afterAll(async () => { await site.close(); rmSync(work, { recursive: true, force: true }); });

test('bugframe crawl maps the whole site, finds every planted problem and never lets a write leave the browser', async () => {
  test.setTimeout(240_000);
  const out = join(work, 'out'), auth = join(work, 'auth.json');
  // A saved session, as `bugframe crawl login` would write it, for the login-protected /account page.
  writeFileSync(auth, JSON.stringify({ cookies: [{ name: SESSION_COOKIE, value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
  const { code, stdout } = await new Promise<{ code: number; stdout: string }>(r => execFile(process.execPath, ['src/cli/bin.mjs', 'crawl', `${site.base}/`, '--out', out, '--storage-state', auth, '--fail-on', 'high'], { timeout: 220_000 },
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
});
