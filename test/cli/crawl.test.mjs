import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createFrontier, globToRegExp, isIdSegment, normalizeUrl, routeTemplate } from '../../src/cli/crawl/urls.mjs';
import { analyze, classifyClick, languageMix } from '../../src/cli/crawl/detect.mjs';
import { crawlHtml, crawlMarkdown } from '../../src/cli/crawl/report.mjs';
import { assertLocalTarget, crawlLogin, crawlSite, failsOn } from '../../src/cli/crawl/index.mjs';
import { fallbackSummary, summarize, trimForSummary, validateSummary } from '../../src/cli/crawl/summary.mjs';
import { cleanup, tmpDir } from '../helpers.mjs';

const O = 'http://127.0.0.1:4000';

test('URLs are normalised: fragments dropped unless they are hash routes, tracking parameters removed, the rest sorted', () => {
  assert.equal(normalizeUrl('/clients/?utm_source=x&b=2&a=1#top', O), `${O}/clients?a=1&b=2`);
  assert.equal(normalizeUrl('/app#/reports', O), `${O}/app#/reports`);
  assert.equal(normalizeUrl('/app#!/reports/7', O), `${O}/app#!/reports/7`);
  assert.equal(normalizeUrl('//127.0.0.1:4000//a//b/', O), `${O}/a/b`);
  assert.equal(normalizeUrl('https://user:pw@127.0.0.1:4000/x?gclid=1&fbclid=2', O), 'https://127.0.0.1:4000/x');
  for (const bad of ['mailto:a@b.c', 'tel:123', 'javascript:void(0)', 'http://[bad']) assert.equal(normalizeUrl(bad, O), null, bad);
});

test('record ids collapse into one route template, so a 10,000-record list is one route', () => {
  for (const s of ['123', '550e8400-e29b-41d4-a716-446655440000', 'a3f9c2d1e8', 'ord8f7a6b5c4d3e2f1a']) assert.equal(isIdSegment(s), true, s);
  for (const s of ['clients', 'how-we-built-it-2024', 'v2', 'settings', 'abc123']) assert.equal(isIdSegment(s), false, s);
  assert.equal(routeTemplate(`${O}/clients/123`), '/clients/:id');
  assert.equal(routeTemplate(`${O}/clients/456/invoices/9?tab=2&page=3`), '/clients/:id/invoices/:id?page&tab');
  assert.equal(routeTemplate(`${O}/app#/reports/77?sort=asc`), '/app#/reports/:id?sort');
  assert.equal(routeTemplate(`${O}/blog/how-we-built-it-2024`), '/blog/how-we-built-it-2024');
});

test('include/exclude globs: * stays in one segment, ** spans segments', () => {
  assert.ok(globToRegExp('/admin/**').test('/admin/users/7'));
  assert.ok(!globToRegExp('/admin/*').test('/admin/users/7'));
  assert.ok(globToRegExp('/clients/*').test('/clients/7'));
});

test('the frontier enforces every cap: pages, depth, two pages per route template, same origin, destructive URLs, include/exclude', () => {
  const f = createFrontier({ origin: O, maxPages: 5, maxDepth: 2, exclude: ['/admin/**'] });
  assert.equal(f.add(`${O}/`, { depth: 0 }).status, 'queued');
  assert.equal(f.add(`${O}/#section`).status, 'seen', 'an in-page anchor is the same page');
  assert.equal(f.add('https://other.example/').status, 'offsite');
  assert.equal(f.add(`${O}/logout`).status, 'destructive');
  assert.equal(f.add(`${O}/items/7?op=delete`).status, 'destructive');
  assert.equal(f.add(`${O}/admin/users`).status, 'excluded');
  assert.equal(f.add(`${O}/deep`, { depth: 3 }).status, 'depth');
  for (let i = 1; i <= 50; i++) f.add(`${O}/clients/${i}`, { depth: 1 });
  assert.deepEqual(f.queue.filter(q => q.route === '/clients/:id').map(q => q.url), [`${O}/clients/1`, `${O}/clients/2`]);
  assert.equal(f.skipped.template.get('/clients/:id').size, 48);
  f.add(`${O}/a`); f.add(`${O}/b`);
  assert.equal(f.add(`${O}/c`).status, 'pages', '--max-pages counts every accepted page');
  assert.equal(f.accepted, 5);
  const inc = createFrontier({ origin: O, include: ['/clients/**'] });
  assert.equal(inc.add(`${O}/`).status, 'queued', 'the start page is always crawled');
  assert.equal(inc.add(`${O}/about`).status, 'excluded');
  assert.equal(inc.add(`${O}/clients/1`).status, 'queued');
});

test('click outcomes: navigates, opens, changes, calls-backend, error, dead, skipped', () => {
  const r = effects => ({ outcome: 'responded', effects: { blockedRequests: [], calls: [], consoleErrors: [], pageErrors: [], failedRequests: [], ...effects } });
  assert.deepEqual(classifyClick(r({ navigatedUrl: `${O}/app#/reports` })), { outcome: 'navigates', to: `${O}/app#/reports` });
  assert.equal(classifyClick(r({ blockedRequests: ['would have sent NAVIGATE /logout'] })).outcome, 'navigates');
  assert.deepEqual(classifyClick(r({ blockedRequests: ['would have sent POST /api/save'] })), { outcome: 'calls-backend', calls: ['POST /api/save'] });
  assert.deepEqual(classifyClick(r({ calls: ['GET /api/reports'] })), { outcome: 'calls-backend', calls: ['GET /api/reports'] });
  assert.deepEqual(classifyClick(r({ blockedRequests: ['would have sent FORM POST /api/contact'], formSubmitIntercepted: true })).calls, ['FORM POST /api/contact']);
  assert.equal(classifyClick(r({ pageErrors: ['totals is undefined'], domChanged: true })).outcome, 'error');
  assert.equal(classifyClick(r({ opened: true, domChanged: true })).outcome, 'opens');
  assert.equal(classifyClick(r({ popup: '/help' })).outcome, 'opens');
  assert.equal(classifyClick(r({ domChanged: true })).outcome, 'changes');
  assert.equal(classifyClick(r({ focusMoved: true })).outcome, 'changes');
  assert.equal(classifyClick(r({})).outcome, 'dead');
  assert.match(classifyClick(r({ formSubmitIntercepted: true })).reason, /no action/);
  assert.equal(classifyClick({ outcome: 'could not click' }).outcome, 'dead');
  assert.deepEqual(classifyClick({ outcome: 'skipped: destructive' }), { outcome: 'skipped', reason: 'destructive' });
  assert.equal(classifyClick({ outcome: 'probe error', error: 'x' }).outcome, 'unknown');
});

const page = (path, over = {}) => ({ url: `${O}${path}`, path, pathname: path.split('#')[0], route: routeTemplate(`${O}${path}`), status: 200, via: 'link', title: `${path} · Demo`, h1: ['Heading'], screenshot: `screens/${path.replace(/\W/g, '') || 'home'}.jpg`, regions: [], links: [], controls: [], probe: [], consoleErrors: [], pageErrors: [], failed: [], ...over });
const nav = (items, key = 'nav "Main"') => [{ key, items: items.map(([label, p]) => ({ label, url: `${O}${p}` })) }];
const links = (items, inNav = true) => items.map(([label, p], i) => ({ label, url: `${O}${p}`, selector: `nav a:nth-of-type(${i + 1})`, inNav }));
const MAIN = [['Home', '/'], ['Clients', '/clients'], ['Contact', '/contact']];

test('whole-site checks find inconsistent navigation, labels, wiring, titles, repeated errors, failing endpoints, orphans and broken links', () => {
  const pages = [
    page('/', { regions: nav(MAIN), links: [...links(MAIN), ...links([['Pricing', '/pricing']], false)], consoleErrors: ['Theme config missing: palette'], failed: [{ method: 'GET', url: '/api/stats/12', status: 500 }],
      controls: [{ kind: 'button', label: 'Save', selector: '#save', outcome: 'calls-backend', calls: ['POST /api/save'] }, { kind: 'button', label: 'Export', selector: '#export', outcome: 'dead' }] }),
    page('/clients', { regions: nav(MAIN), links: links(MAIN), consoleErrors: ['Theme config missing: palette'], failed: [{ method: 'GET', url: '/api/stats/13', status: 500 }] }),
    page('/contact', { title: '/ · Demo', regions: nav(MAIN), links: links(MAIN), consoleErrors: ['Theme config missing: palette'] }),
    page('/about', { h1: [], regions: nav([['Home', '/'], ['Contact', '/support']]), links: links([['Home', '/'], ['Contact', '/support'], ['Start', '/']]),
      controls: [{ kind: 'button', label: 'Save', selector: '#save2', outcome: 'dead', submit: true, reason: 'the form was submitted, but it has no action and no handler did anything' }] }),
    page('/support', { regions: nav(MAIN), links: links(MAIN) }),
    page('/orphan', { via: 'sitemap', stuckLoading: '.spinner', waitedMs: 15000, languages: languageMix('the order and your account are with you for this week and that is about what we have. Você não tem uma conta para isso, então você não pode mais usar também.') }),
    page('/pricing', { status: 404, title: 'Not found' }),
  ];
  const sitemap = [`${O}/orphan`, `${O}/gone`];
  const f = analyze({ pages, linkStatus: new Map([[`${O}/gone`, { status: 404 }]]), sitemap });
  const one = (type, pred = () => true) => { const hit = f.filter(x => x.type === type && pred(x)); assert.ok(hit.length, `${type} found in ${JSON.stringify(f.map(x => [x.type, x.title]))}`); return hit[0]; };
  assert.deepEqual(one('dead-control').pages, ['/']);
  assert.equal(one('dead-form').selector, '#save2');
  assert.match(one('broken-link').title, /\/pricing is broken \(404\)/);
  assert.equal(f.some(x => x.type === 'route-error'), false, 'a 404 reached by a link is reported once, as the broken link');
  assert.match(one('nav-inconsistent').evidence, /"Contact" points to \/support instead of \/contact; missing "Clients"/);
  assert.deepEqual(one('nav-inconsistent').pages, ['/about'], 'the page that is the missing item\'s own destination is not blamed for it');
  assert.match(one('label-multiple-destinations').evidence, /\/contact .* vs \/support/);
  assert.match(one('destination-multiple-labels').title, /"Home" and "Start"/);
  assert.match(one('action-inconsistent').evidence, /calls-backend POST \/api\/save on \/; dead on \/about/);
  assert.equal(one('repeated-console-error').pages.length, 3);
  assert.equal(one('repeated-console-error').severity, 'high');
  assert.match(one('failing-endpoint').title, /GET \/api\/stats\/:id fails on 2 page/);
  assert.equal(one('failing-endpoint').severity, 'high');
  assert.equal(one('orphan-route').pages[0], '/orphan');
  assert.match(one('sitemap-broken').title, /\/gone/);
  assert.match(one('duplicate-title').evidence, /\/ · demo/);
  assert.equal(one('missing-h1').pages[0], '/about');
  assert.equal(one('stuck-loading').selector, '.spinner');
  assert.deepEqual(one('mixed-language').title.match(/en|pt/g), ['en', 'pt']);
  assert.deepEqual(f.map(x => x.id), f.map((_, i) => `C${i + 1}`));
  assert.ok(f.every((x, i) => i === 0 || ['high', 'medium', 'low'].indexOf(f[i - 1].severity) <= ['high', 'medium', 'low'].indexOf(x.severity)), 'sorted by severity');
  assert.ok(f.every(x => x.fix && x.evidence !== undefined));
  assert.equal(languageMix('the order and your account are with you for this week').mixed, undefined, 'one language is not mixed');
});

test('list rows failing the same probe check are one finding, not fifty', () => {
  const probe = Array.from({ length: 50 }, (_, i) => ({ type: 'small-tap-target', severity: 'low', selector: `ul > li:nth-of-type(${i + 1}) > a`, title: `Tap target ${50 + (i % 3)}x18px`, evidence: `"Client ${i + 1}" is small`, viewport: '390x844' }));
  const f = analyze({ pages: [page('/clients', { probe })] });
  assert.equal(f.length, 1); assert.match(f[0].title, /and 49 similar/); assert.match(f[0].evidence, /50 elements matching ul > li:nth-of-type\(\*\) > a/);
});

const XSS = '<img src=x onerror=alert(1)>';
function sampleCrawl() {
  const pages = [page('/', { title: `Home ${XSS}`, links: links([[`Go ${XSS}`, '/x']]), controls: [{ kind: 'button', label: `Export ${XSS}`, selector: '#export', outcome: 'dead' }] })];
  return { tool: 'bugframe crawl', origin: O, start: '/', startedAt: '2026-11-18T00:00:00.000Z', partial: false, signedIn: false, limits: { perTemplate: 2 }, sitemap: [], notes: [`note ${XSS}`],
    stats: { pages: 1, routes: 1, controlsTested: 1, controlsSkippedDestructive: 0, linksChecked: 0, outcomes: { dead: 1 }, findings: { high: 1, medium: 0, low: 0 }, blockedRequests: 0 },
    skipped: { destructive: [], excluded: [], depth: [], pagesCap: [], offsite: 0, template: [] }, blockedRequests: [{ method: 'POST', url: `/api/${XSS}` }],
    pages: pages.map(p => ({ ...p, links: 1 })), edges: [{ from: '/', page: '/', kind: 'button', label: `Export ${XSS}`, selector: '#export', outcome: 'dead' }, { from: '/', page: '/', kind: 'link', label: `Go ${XSS}`, outcome: 'navigates', to: '/x' }],
    findings: analyze({ pages }) };
}

test('crawl.html escapes every page-supplied string, is self-contained and locks itself down with a CSP', () => {
  const html = crawlHtml(sampleCrawl(), new Map([['screens/home.jpg', 'data:image/jpeg;base64,AAAA']]));
  assert.ok(!html.includes(XSS), 'the raw payload never appears');
  assert.ok(html.includes('Export &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('Home &lt;img src=x onerror=alert(1)&gt;'));
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  assert.ok(!/(src|href)="(https?:)?\/\//.test(html), 'no external assets');
  assert.ok(html.includes('src="data:image/jpeg;base64,AAAA"'), 'thumbnails are inline');
  assert.match(html, /prefers-color-scheme:dark/);
  const md = crawlMarkdown(sampleCrawl());
  assert.ok(!md.includes(XSS)); assert.ok(md.includes('\\<img src=x onerror=alert(1)\\>'));
  for (const h of ['## Summary', '## Top issues', '## Findings', '## Dead controls', '## Broken links and routes', '## Inconsistencies', '## Wiring map', '## Pages', '## Not crawled and limits']) assert.ok(md.includes(h), h);
});

test('only local sites are crawled unless --allow-remote, checked before any browser starts', async () => {
  const warnings = [], playwright = { chromium: { launch: () => { throw new Error('must not start'); } } };
  await assert.rejects(crawlSite({ startUrl: 'https://prod.example/', out: 'unused', playwright }), /not a local address.*--allow-remote/s);
  await assert.rejects(crawlSite({ startUrl: 'http://192.168.1.10:3000/', out: 'unused', playwright }), /not a local address/);
  assert.doesNotThrow(() => assertLocalTarget('http://localhost:3000/', false));
  assertLocalTarget('https://staging.example/', true, m => warnings.push(m));
  assert.match(warnings[0], /WARNING --allow-remote.*staging\.example.*Never point it at production/s);
  await assert.rejects(crawlSite({ startUrl: 'http://localhost:1/', out: 'unused', maxPages: 0, playwright }), /--max-pages must be a whole number from 1/);
  await assert.rejects(crawlSite({ startUrl: 'http://localhost:1/', out: 'unused', storageState: '/nonexistent/auth.json', playwright }), /not a readable Playwright storage-state/);
});

test('--fail-on: exit 1 only for findings at or above the level', () => {
  const f = [{ severity: 'medium' }];
  assert.equal(failsOn(f, 'none'), false); assert.equal(failsOn(f, 'high'), false); assert.equal(failsOn(f, 'medium'), true); assert.equal(failsOn(f, 'low'), true);
  assert.throws(() => failsOn(f, 'blocker'), /--fail-on/);
});

test('crawl login saves the session the person created, mode 0600, and never prints it', async () => {
  const dir = await tmpDir(), file = join(dir, '.bugframe-auth.json'), said = [];
  try {
    const input = new PassThrough(), state = { cookies: [{ name: 'sid', value: 'SECRET-COOKIE-123', domain: 'localhost', path: '/' }], origins: [] };
    let headless;
    const playwright = { chromium: { launch: async o => { headless = o.headless; return { on() {}, close: async () => {}, newContext: async () => ({ newPage: async () => ({ goto: async () => {} }), storageState: async () => state }) }; } } };
    setTimeout(() => input.write('\n'), 20);
    const msg = await crawlLogin({ url: 'http://localhost:3000/login', save: file, playwright, input, say: m => said.push(m) });
    assert.equal(headless, false, 'a visible window: the person signs in themself');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), state);
    assert.ok(![msg, ...said].join('\n').includes('SECRET-COOKIE-123'), 'the cookie value is never printed');
    assert.match(msg, /never commit it.*\.gitignore/s);
    await assert.rejects(crawlLogin({ url: 'https://prod.example/login', save: file, playwright, input }), /not a local address/);
  } finally { await cleanup(dir); }
});

test('summary input is trimmed to the token budget, lowest severity first', () => {
  const c = sampleCrawl();
  c.findings = Array.from({ length: 300 }, (_, i) => ({ id: `C${i + 1}`, type: 'contrast', severity: i < 5 ? 'high' : 'low', title: 'x'.repeat(150), pages: ['/a'], routes: ['/a'], evidence: 'y'.repeat(250), fix: 'z' }));
  const t = trimForSummary(c, 5000);
  assert.ok(t.estTokens <= 5000, `${t.estTokens}`);
  assert.ok(t.dropped > 0);
  for (let i = 1; i <= 5; i++) assert.ok(t.ids.has(`C${i}`), 'high findings kept');
  assert.ok(JSON.parse(t.json).note.includes('untrusted'));
});

const GOOD = `# Crawl summary: ${O}\n\nVerdict: One dead button.\n\n## Root causes\n\n### R1. Export is not wired\n- Severity: high\n- Findings: C1\n- Pages: /\n- Why: the click did nothing.\n- Fix direction: wire it.\n\n## Fix plan\n\n1. R1 — wire Export.\n\n## Not covered\n\n- design\n`;
test('the summary must cite only finding ids from the data and follow the format', () => {
  assert.deepEqual(validateSummary(GOOD, new Set(['C1'])).errors, []);
  assert.match(validateSummary(GOOD.replace('C1\n', 'C1, C99\n'), new Set(['C1'])).errors.join(), /C99/);
  assert.match(validateSummary('Sure! Looks fine.', new Set(['C1'])).errors.join(), /# Crawl summary/);
  assert.match(validateSummary(GOOD.replace('1. R1 — wire Export.', '1. wire Export.'), new Set(['C1'])).errors.join(), /R1: not in the fix plan/);
  assert.deepEqual(validateSummary(fallbackSummary(sampleCrawl()), new Set(sampleCrawl().findings.map(f => f.id))).errors, []);
});

test('--summarize runs the confined model in an empty folder holding only the trimmed data; a bad answer is kept raw and marked degraded', async () => {
  const out = await tmpDir(), tmpRoot = await tmpDir();
  try {
    const crawl = sampleCrawl(); let seen;
    const run = answer => async (cmd, args, { cwd }) => {
      seen = { cmd, args, files: await readdir(cwd), cwd, prompt: args[args.indexOf('--system-prompt-file') + 1] };
      return answer;
    };
    const ok = await summarize({ crawl, out, run: run(GOOD), tmpRoot });
    assert.equal(ok.degraded, false, ok.errors.join());
    assert.equal(seen.cmd, 'claude'); assert.deepEqual(seen.files, ['crawl-data.json']);
    assert.ok(!seen.prompt.startsWith(seen.cwd), 'the system prompt lives outside the model\'s folder');
    for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', 'Read,Grep,Glob']) assert.ok(seen.args.includes(flag), flag);
    assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'haiku');
    assert.equal(await readFile(join(out, 'SUMMARY.md'), 'utf8'), GOOD);
    const bad = await summarize({ crawl, out, run: run('Everything looks great! C42 is fine.'), tmpRoot, model: 'sonnet' });
    assert.equal(bad.degraded, true);
    assert.match(await readFile(join(out, 'SUMMARY.md'), 'utf8'), /script-only grouping/);
    assert.equal(await readFile(join(out, 'summary-output.txt'), 'utf8'), 'Everything looks great! C42 is fine.');
    assert.deepEqual(await readdir(tmpRoot), [], 'the temporary folder is removed');
    await writeFile(join(out, 'x'), '');
  } finally { await cleanup(out); await cleanup(tmpRoot); }
});
