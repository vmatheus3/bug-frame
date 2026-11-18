// `bugframe crawl`: walk a whole site in a real browser, click its controls under the page-audit guards, and report
// how everything is wired and where it is not. Script only: no AI model unless --summarize is given.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from '../commands.mjs';
import { createFileStorage } from '../../server/storage-fs.mjs';
import { MAX_ATTACHMENT_BYTES, newReportId } from '../../server/util.mjs';
import { isLocalUrl, stamp } from '../audit/index.mjs';
import { CONTEXT, DEFAULT_SETTLE_MS, checkLink, clickOne, guard, isDestructive, load, loadPlaywright, pageChecks, parseViewports, redactUrl, watch } from '../audit/probe.mjs';
import { SEVERITIES, analyze, applyBaseline, baselineOf, classifyClick, languageMix } from './detect.mjs';
import { crawlHtml, crawlMarkdown } from './report.mjs';
import { createFrontier, isHashRoute, normalizeUrl, routeTemplate, shortUrl } from './urls.mjs';

export const DEFAULTS = { maxPages: 200, maxDepth: 6, viewports: '390x844,1440x900', maxControls: 60, concurrency: 2, timeoutMs: 15_000, maxMinutes: 30, perTemplate: 2, settleMs: DEFAULT_SETTLE_MS, loginWaitMs: 600_000 };
export const DEFAULT_AUTH_FILE = '.bugframe-auth.json';
const PAUSE_MS = 150, MAX_LINK_CHECKS = 300, MAX_THUMBS = 150;

// ---- runs inside the page
function collectPage() {
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const text = el => clean(el.innerText ?? el.textContent);
  const label = el => clean(el.getAttribute('aria-label') || text(el) || el.getAttribute('title') || el.querySelector?.('img[alt]')?.getAttribute('alt')).slice(0, 80);
  const REGION = 'nav, [role=navigation], header, footer, [role=banner], [role=contentinfo]';
  const LINK = 'a[href], area[href], [data-href], [routerlink]';
  const hrefOf = el => { const v = el.getAttribute('href') ?? el.getAttribute('data-href') ?? el.getAttribute('routerlink'); try { return v === null ? null : new URL(v, location.href).href; } catch { return null; } };
  const sel = el => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    const parts = []; for (let n = el; n && n.nodeType === 1 && n !== document.documentElement && parts.length < 5; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const same = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [];
      parts.unshift(same.length > 1 ? `${n.tagName.toLowerCase()}:nth-of-type(${same.indexOf(n) + 1})` : n.tagName.toLowerCase());
    }
    return parts.join(' > ');
  };
  const ui = el => Boolean(el.closest('[data-bug-ui], [data-bugframe]'));
  const counts = {};
  const regions = [...document.querySelectorAll(REGION)].filter(r => !ui(r) && !r.parentElement?.closest(REGION)).map(r => {
    const role = r.getAttribute('role'), name = r.getAttribute('aria-label') || r.id;
    let key = role ? `[role=${role}]` : r.tagName.toLowerCase(); if (name) key += ` "${clean(name).slice(0, 40)}"`;
    counts[key] = (counts[key] ?? 0) + 1; if (counts[key] > 1) key += ` (${counts[key]})`;
    return { key, items: [...r.querySelectorAll(LINK)].map(a => ({ label: label(a), url: hrefOf(a) })).filter(i => i.url).slice(0, 80) };
  });
  const links = [...document.querySelectorAll(LINK)].filter(a => !ui(a)).slice(0, 2000).map(a => ({ label: label(a), hint: clean(`${a.getAttribute('title') ?? ''} ${a.getAttribute('aria-label') ?? ''}`).slice(0, 160), url: hrefOf(a), selector: sel(a), inNav: Boolean(a.closest('nav, [role=navigation]')) })).filter(l => l.url);
  const h1 = [...document.querySelectorAll('h1')].filter(h => !ui(h) && h.getBoundingClientRect().height > 0).map(text).filter(Boolean).slice(0, 5);
  return { title: clean(document.title).slice(0, 200), h1, lang: document.documentElement.lang || '', regions, links, text: (document.body?.innerText ?? '').slice(0, 20_000) };
}
function enrich(selectors) {
  return selectors.map(s => {
    let el = null; try { el = document.querySelector(s); } catch { /* bad selector */ }
    if (!el) return {};
    const form = el.form ?? el.closest('form');
    return { chrome: Boolean(el.closest('nav, [role=navigation], header, footer, [role=banner], [role=contentinfo]')), submit: Boolean(form && el.matches('button:not([type]), button[type=submit], input[type=submit], input[type=image]')),
      href: el.matches('a[href], area[href]') ? el.getAttribute('href') : null, resolved: el.matches('a[href], area[href]') ? el.href : null };
  });
}
function loadingIndicator() {
  for (const el of document.querySelectorAll('[aria-busy=true], [role=progressbar], .spinner, .loader, .loading, .skeleton, [class*=spinner], [class*=skeleton], [data-loading]')) {
    if (el.closest('[data-bug-ui], [data-bugframe]') || (el.getAttribute('role') === 'progressbar' && el.hasAttribute('aria-valuenow'))) continue;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') return el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`;
  }
  return null;
}
async function downscale(dataUrl) {
  const img = new Image(); img.src = dataUrl; await img.decode();
  const w = Math.min(480, img.naturalWidth), h = Math.round(img.naturalHeight * w / img.naturalWidth);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h }); c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.62);
}

/** Refuse a non-local target unless --allow-remote, which prints a loud warning. Same rule as `bugframe audit`. */
export function assertLocalTarget(url, allowRemote, warn = m => console.error(m), what = 'crawl') {
  let u; try { u = new URL(url); } catch { throw new CliError(`Give the start URL, e.g. bugframe ${what} http://localhost:3000/`); }
  if (!/^https?:$/.test(u.protocol)) throw new CliError('Only http and https sites can be crawled.');
  if (isLocalUrl(url)) return;
  if (!allowRemote) throw new CliError(`Refusing to ${what} ${redactUrl(url)}: it is not a local address. The crawl loads every page and clicks its controls, so it only runs against your dev server (localhost, *.localhost, *.test, 127.x, ::1); pass --allow-remote to accept the risk.`);
  warn(`bugframe ${what}: WARNING --allow-remote: ${redactUrl(url)} is NOT a local address. The crawl opens every page and clicks controls with the session you gave it; it blocks writes but cannot know what a GET does on that server. Never point it at production.`);
}

async function readStorageState(file) {
  if (!file) return undefined;
  let state; try { state = JSON.parse(await readFile(resolve(file), 'utf8')); } catch { throw new CliError(`--storage-state ${file} is not a readable Playwright storage-state JSON file (make one with: bugframe crawl login <url> --save ${DEFAULT_AUTH_FILE}).`); }
  if (!Array.isArray(state?.cookies)) throw new CliError(`--storage-state ${file} has no cookies list; it is not a Playwright storage state.`);
  return state;
}

/**
 * Crawl a site. Returns the crawl data (also written to `out` as crawl.json, CRAWL.md and crawl.html).
 * Every option has a cap; the run stops early on `signal` or the time limit and reports what it covered (partial).
 */
export async function crawlSite(o) {
  const opt = { ...DEFAULTS, include: [], exclude: [], click: true, allowRemote: false, log: () => {}, warn: m => console.error(m), ...o };
  assertLocalTarget(opt.startUrl, opt.allowRemote, opt.warn);
  for (const [k, lo, hi] of [['maxPages', 1, 5000], ['maxDepth', 0, 50], ['maxControls', 0, 500], ['concurrency', 1, 8], ['timeoutMs', 1000, 300_000], ['maxMinutes', 1, 1440], ['settleMs', 100, 10_000]])
    if (!Number.isInteger(opt[k]) || opt[k] < lo || opt[k] > hi) throw new CliError(`--${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`).replace('max-controls', 'max-controls-per-page').replace('timeout-ms', 'timeout')} must be a whole number from ${lo} to ${hi}.`);
  const viewports = Array.isArray(opt.viewports) ? opt.viewports : parseViewports(opt.viewports);
  const desktop = [...viewports].sort((a, b) => b.width - a.width)[0];
  const storageState = await readStorageState(opt.storageState);
  let baseline; if (opt.baseline) { try { baseline = JSON.parse(await readFile(resolve(opt.baseline), 'utf8')); } catch { throw new CliError(`--baseline ${opt.baseline} is not a readable JSON file (write one with --save-baseline FILE).`); } applyBaseline([], baseline); }
  const start = normalizeUrl(opt.startUrl), origin = new URL(start).origin, out = resolve(opt.out);
  await mkdir(join(out, 'screens'), { recursive: true });
  const pw = opt.playwright ?? await loadPlaywright(opt.project);
  const deadline = Date.now() + opt.maxMinutes * 60_000, stopped = () => opt.signal?.aborted || Date.now() > deadline;
  const frontier = createFrontier({ origin, maxPages: opt.maxPages, maxDepth: opt.maxDepth, include: opt.include, exclude: opt.exclude, perTemplate: opt.perTemplate });
  frontier.add(start, { depth: 0, via: 'start' });
  const crawl = { tool: 'bugframe crawl', origin: redactUrl(origin).replace(/\/$/, ''), start: shortUrl(redactUrl(start)), startedAt: new Date().toISOString(), partial: false, signedIn: Boolean(storageState),
    limits: { maxPages: opt.maxPages, maxDepth: opt.maxDepth, perTemplate: opt.perTemplate, maxControlsPerPage: opt.click ? opt.maxControls : 0, timeoutMs: opt.timeoutMs, settleMs: opt.settleMs, maxMinutes: opt.maxMinutes, viewports: viewports.map(v => v.name), include: opt.include, exclude: opt.exclude },
    sitemap: [], pages: [], findings: [], notes: [] };
  const pages = [], blockedAll = [], tests = new Map(), clickCounter = { n: 0 };
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) { throw new CliError(`Could not start Chromium (${String(e?.message ?? e).split('\n')[0]}). Run: npx playwright install chromium`); }
  try {
    // One set of guarded contexts per worker, so each worker's blocked-request log belongs to its own clicks.
    const workers = [];
    for (let w = 0; w < opt.concurrency; w++) {
      const blocked = [], contexts = new Map();
      for (const vp of viewports) {
        const phone = vp.width < 600, context = await browser.newContext({ ...CONTEXT, viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, storageState });
        await guard(context, origin, blocked, start); contexts.set(vp.name, context);
      }
      workers.push({ blocked, contexts });
    }
    const request = workers[0].contexts.get(desktop.name).request;
    // sitemap.xml: same-origin URLs only, through the frontier's caps.
    try {
      const r = await checkLink(request, `${origin}/sitemap.xml`, origin);
      if (r.status === 200) {
        const res = await request.get(`${origin}/sitemap.xml`, { maxRedirects: 0, timeout: 10_000, failOnStatusCode: false });
        const xml = (await res.text()).slice(0, 2_000_000); await res.dispose();
        for (const [, loc] of [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].slice(0, 1000)) {
          const url = normalizeUrl(loc.replace(/&amp;/g, '&'), origin); if (!url || new URL(url).origin !== origin) continue;
          crawl.sitemap.push(url); frontier.add(url, { depth: 1, via: 'sitemap' });
        }
      }
    } catch { /* no sitemap */ }

    let busy = 0, index = 0;
    const run = async worker => {
      for (;;) {
        if (stopped()) return;
        const item = frontier.next();
        if (!item) { if (!busy) return; await sleep(50); continue; }
        busy++;
        try { const n = ++index; const page = await crawlPage({ item, n, worker, opt, viewports, desktop, origin, out, frontier, tests, clickCounter, stopped }); pages.push(page);
          opt.log(`${String(n).padStart(3)}/${opt.maxPages} ${page.path}${page.route !== page.path ? `  [${page.route}]` : ''}  ${page.status ?? page.error ?? '-'}${page.redirectedTo ? ` → ${page.redirectedTo}` : ''}  ${page.controls.filter(c => !['skipped', 'unknown'].includes(c.outcome) && c.kind === 'button').length} controls  ${page.controls.filter(c => c.outcome === 'dead' || c.outcome === 'error').length} dead/error`); }
        catch (e) { if (!opt.signal?.aborted) crawl.notes.push(`${shortUrl(item.url)}: crawl error (${String(e?.message ?? e).split('\n')[0].slice(0, 160)})`); }
        finally { busy--; }
        await sleep(PAUSE_MS);
      }
    };
    await Promise.all(workers.map(run));
    if (stopped()) { crawl.partial = true; crawl.notes.push(opt.signal?.aborted ? 'Stopped before the end (Ctrl+C); the report covers the pages crawled so far.' : `Stopped at the ${opt.maxMinutes}-minute limit (--max-minutes); the report covers the pages crawled so far.`); }
    for (const w of workers) blockedAll.push(...w.blocked);

    // Link targets that were not crawled: one GET each through the guard, except routes already represented.
    const linkStatus = await checkTargets({ pages, frontier, stopped, check: target => checkLink(request, target, origin) });
    if (!crawl.partial && [...linkStatus.values()].some(v => v.skipped === 'stopped')) { crawl.partial = true; crawl.notes.push(opt.signal?.aborted ? 'Stopped before every link target was checked (Ctrl+C).' : `Stopped at the ${opt.maxMinutes}-minute limit (--max-minutes) before every link target was checked.`); }

    // Thumbnails for the HTML report, made in a separate context with no network at all.
    const thumbs = new Map(), thumbCtx = await browser.newContext({ offline: true, javaScriptEnabled: true });
    try {
      const tp = await thumbCtx.newPage(); await tp.route('**/*', r => r.abort());
      const files = [...new Set(pages.flatMap(p => [p.screenshot, ...p.controls.map(c => c.screenshot)]).filter(Boolean))].slice(0, MAX_THUMBS);
      for (const f of files) { try { const buf = await readFile(join(out, f)); thumbs.set(f, await tp.evaluate(downscale, `data:image/${f.endsWith('.png') ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`)); } catch { /* skip that one */ } }
    } finally { await thumbCtx.close(); }

    crawl.findings = analyze({ pages, linkStatus, sitemap: crawl.sitemap, settleMs: opt.settleMs });
    if (baseline) crawl.baseline = applyBaseline(crawl.findings, baseline);
    crawl.finishedAt = new Date().toISOString();
    const pub = toPublic(crawl, pages, frontier, blockedAll, linkStatus);
    await writeFile(join(out, 'crawl.json'), JSON.stringify(pub, null, 2));
    if (opt.saveBaseline) await writeFile(resolve(opt.saveBaseline), `${JSON.stringify(baselineOf(pub.findings), null, 2)}\n`);
    await writeFile(join(out, 'CRAWL.md'), crawlMarkdown(pub));
    await writeFile(join(out, 'crawl.html'), crawlHtml(pub, thumbs));
    return { ...pub, out };
  } finally { await browser.close(); }
}

/**
 * One GET for every link target that was not crawled, through the guard's rules. Never checked: other sites,
 * destructive URLs (by address or because their link is labelled so), routes a crawled page already represents and
 * hash routes. Stops with the crawl (`stopped`: Ctrl+C or --max-minutes); what is left is marked, not fetched.
 */
export async function checkTargets({ pages, frontier, stopped, check, max = MAX_LINK_CHECKS }) {
  const linkStatus = new Map(), crawled = new Set(pages.map(p => p.url));
  let checks = 0;
  for (const target of new Set(pages.flatMap(p => p.links.map(l => l.url)))) {
    if (crawled.has(target) || linkStatus.has(target)) continue;
    const v = frontier.check(target, 0);
    if (['offsite', 'invalid'].includes(v.status)) continue;
    if (v.status === 'destructive') { linkStatus.set(target, { status: null, skipped: 'destructive' }); continue; }
    if (pages.some(p => p.route === routeTemplate(target) && p.status !== null && p.status < 400) && v.status !== 'excluded') { linkStatus.set(target, { status: null, skipped: 'same route as a crawled page' }); continue; }
    if (isHashRoute(new URL(target).hash)) { linkStatus.set(target, { status: null, skipped: 'not checked' }); continue; }
    if (stopped()) { linkStatus.set(target, { status: null, skipped: 'stopped' }); continue; }
    if (checks >= max) { linkStatus.set(target, { status: null, skipped: 'link-check limit' }); continue; }
    checks++;
    try { linkStatus.set(target, await check(target)); } catch (e) { linkStatus.set(target, { status: null, error: String(e?.message ?? e).split('\n')[0].slice(0, 80) }); }
  }
  return linkStatus;
}

/** One page at every viewport, then its controls. */
async function crawlPage({ item, n, worker, opt, viewports, desktop, origin, out, frontier, tests, clickCounter, stopped }) {
  const rec = { n, url: item.url, path: shortUrl(redactUrl(item.url)), pathname: new URL(item.url).pathname, route: item.route, depth: item.depth, via: item.via, from: item.from, status: null, title: '', h1: [], lang: '', screenshots: {}, screenshot: null,
    regions: [], links: [], controls: [], probe: [], consoleErrors: [], pageErrors: [], failed: [], stuckLoading: null, waitedMs: 0 };
  let candidates = [];
  for (const vp of [desktop, ...viewports.filter(v => v !== desktop)]) {
    const context = worker.contexts.get(vp.name), page = await context.newPage(), log = watch(page, origin), phone = vp.width < 600;
    try {
      let response; const t0 = Date.now();
      try { response = await load(page, item.url, opt.timeoutMs); } catch (e) {
        if (vp !== desktop) continue;
        // A redirect the guard refused (another site, a destructive URL, a loop) is a fact about the page, not a load error.
        if (e.blockedRedirect) { rec.status = e.blockedRedirect.status; rec.blockedRedirect = { to: e.blockedRedirect.to, reason: e.blockedRedirect.reason }; }
        else rec.error = String(e?.message ?? e).split('\n')[0].slice(0, 160);
        return rec;
      }
      if (vp === desktop) {
        rec.status = response ? response.status() : null;
        const final = normalizeUrl(page.url());
        if (final && final !== item.url) { rec.redirectedTo = shortUrl(redactUrl(final)); frontier.add(final, { depth: item.depth, via: 'redirect', from: item.route }); return rec; }
        // Loading indicators get until the page timeout to go away.
        for (;;) { rec.stuckLoading = await page.evaluate(loadingIndicator).catch(() => null); if (!rec.stuckLoading || Date.now() - t0 > opt.timeoutMs) break; await page.waitForTimeout(250); }
        rec.waitedMs = Date.now() - t0;
      }
      const shot = `screens/p${n}-${vp.name}.jpg`;
      await page.screenshot({ path: join(out, shot), type: 'jpeg', quality: 70, timeout: 20_000 }).then(() => { rec.screenshots[vp.name] = shot; }, () => {});
      const res = await page.evaluate(pageChecks, { phone, structural: true, max: 15 }).catch(() => null);
      if (res) for (const f of res.findings) rec.probe.push({ ...f, viewport: vp.name });
      if (vp === desktop) {
        rec.screenshot = rec.screenshots[vp.name] ?? null;
        // The start page as a PNG, for filing the crawl in the inbox (--dir).
        if (n === 1 && opt.startShot) await page.screenshot({ path: join(out, 'screens', 'start.png'), type: 'png', timeout: 20_000 }).catch(() => {});
        const c = await page.evaluate(collectPage);
        Object.assign(rec, { title: c.title, h1: c.h1, lang: c.lang, languages: languageMix(c.text) });
        rec.regions = c.regions.map(r => ({ key: r.key, items: r.items.map(i => ({ label: i.label, url: normalizeUrl(i.url) })).filter(i => i.url && new URL(i.url).origin === origin) }));
        const seenLinks = new Set();
        for (const l of c.links) {
          const url = normalizeUrl(l.url); if (!url || new URL(url).origin !== origin || url === item.url || seenLinks.has(url)) continue; seenLinks.add(url);
          // "Sign out" pointing at /bye: the label makes the address destructive too. It is never opened or fetched.
          const destructive = isDestructive(`${l.label} ${l.hint}`); if (destructive) frontier.ban(url);
          rec.links.push({ label: l.label, url, selector: l.selector, inNav: l.inNav, ...(destructive ? { destructive: true } : {}) });
        }
        if (res) { const extra = await page.evaluate(enrich, res.candidates.map(x => x.selector)).catch(() => []); candidates = res.candidates.map((x, i) => ({ ...x, ...(extra[i] ?? {}) })); }
      }
      rec.consoleErrors.push(...log.console); rec.pageErrors.push(...log.pageErrors); rec.failed.push(...log.failed);
    } finally { await page.close().catch(() => {}); }
  }
  for (const k of ['consoleErrors', 'pageErrors']) rec[k] = [...new Set(rec[k])];
  rec.failed = [...new Map(rec.failed.map(r => [`${r.method} ${r.url} ${r.status}`, r])).values()];

  // Same-origin links are followed, not clicked; buttons and script links are clicked one by one in a fresh page.
  for (const l of rec.links) if (!l.destructive) frontier.add(l.url, { depth: item.depth + 1, via: 'link', from: item.route });
  const context = worker.contexts.get(desktop.name);
  let clicked = 0;
  for (const c of candidates) {
    const base = { label: c.label, selector: c.selector, kind: 'button', submit: Boolean(c.submit) };
    if (c.resolved !== null && c.resolved !== undefined) {
      const url = normalizeUrl(c.resolved), hash = (c.href ?? '').trim();
      if (c.destructive ?? isDestructive(c.text)) { rec.controls.push({ ...base, kind: 'link', outcome: 'skipped', reason: 'destructive' }); continue; }
      if (!url || new URL(url).origin !== origin) continue; // other sites, mailto:, tel:
      if (hash.startsWith('#') && hash.length > 1 && !isHashRoute(hash)) continue; // in-page anchor
      if (!(hash === '#' || /^javascript:/i.test(hash) || isHashRoute(hash))) { rec.controls.push({ ...base, kind: 'link', outcome: 'navigates', toUrl: url, to: routeTemplate(url) }); continue; }
    }
    if (isDestructive(c.text)) { rec.controls.push({ ...base, outcome: 'skipped', reason: 'destructive' }); continue; }
    if (!opt.click || stopped()) continue;
    const key = c.chrome ? `chrome\u0000${c.selector}\u0000${c.label}` : `${item.route}\u0000${c.selector}\u0000${c.label}`;
    if (tests.has(key)) { rec.controls.push({ ...base, ...(await tests.get(key)), reused: true }); continue; }
    if (clicked >= opt.maxControls) { rec.controls.push({ ...base, outcome: 'skipped', reason: 'per-page control limit' }); continue; }
    clicked++;
    const test = (async () => {
      const r = await clickOne({ context, url: item.url, c, n: ++clickCounter.n, outDir: out, evidencePrefix: '.', origin, blocked: worker.blocked, vp: desktop, raw: [], timeout: opt.timeoutMs, settleMs: opt.settleMs });
      const cls = classifyClick(r), result = { ...cls, ...(r.screenshot ? { screenshot: r.screenshot.replace(/^\.\//, '') } : {}) };
      if (cls.to) { const url = normalizeUrl(cls.to, origin); if (url && new URL(url).origin === origin) { result.toUrl = url; result.to = routeTemplate(url); frontier.add(url, { depth: item.depth + 1, via: 'click', from: item.route }); } }
      return result;
    })();
    tests.set(key, test);
    rec.controls.push({ ...base, ...(await test) });
  }
  return rec;
}

/** The data written to crawl.json: page paths and route templates only (no origin-specific URLs per page, no secrets). */
function toPublic(crawl, pages, frontier, blocked, linkStatus) {
  const outcomes = {}, tested = pages.flatMap(p => p.controls.filter(c => c.kind === 'button' && !c.reused));
  for (const c of pages.flatMap(p => p.controls)) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
  const sev = Object.fromEntries(SEVERITIES.map(s => [s, crawl.findings.filter(f => f.severity === s).length]));
  const statusByUrl = new Map(pages.map(p => [p.url, p.status]));
  const pub = {
    ...crawl,
    sitemap: crawl.sitemap.map(u => shortUrl(redactUrl(u))),
    stats: { pages: pages.length, routes: new Set(pages.map(p => p.route)).size, controlsTested: tested.filter(c => !['skipped', 'unknown'].includes(c.outcome)).length,
      controlsSkippedDestructive: pages.flatMap(p => p.controls).filter(c => c.reason === 'destructive').length, linksChecked: [...linkStatus.values()].filter(s => !s.skipped).length, outcomes, findings: sev, blockedRequests: blocked.length },
    skipped: { destructive: [...frontier.skipped.destructive].slice(0, 200), excluded: [...frontier.skipped.excluded].slice(0, 200), depth: [...frontier.skipped.depth].slice(0, 200), pagesCap: [...frontier.skipped.pages].slice(0, 200), offsite: frontier.skipped.offsite,
      template: [...frontier.skipped.template].map(([route, urls]) => ({ route, count: urls.size, examples: [...urls].slice(0, 3).map(u => shortUrl(redactUrl(u))) })) },
    blockedRequests: [...new Map(blocked.map(b => [`${b.method} ${b.url}`, b])).values()].slice(0, 200),
    pages: pages.sort((a, b) => a.n - b.n).map((p, i) => ({ id: `p${i + 1}`, path: p.path, route: p.route, status: p.status, ...(p.error ? { error: p.error } : {}), ...(p.redirectedTo ? { redirectedTo: p.redirectedTo } : {}), ...(p.blockedRedirect ? { blockedRedirect: p.blockedRedirect } : {}), title: p.title, h1: p.h1, lang: p.lang,
      depth: p.depth, via: p.via, from: p.from, screenshot: p.screenshot, screenshots: p.screenshots, consoleErrors: p.consoleErrors, pageErrors: p.pageErrors, failedRequests: p.failed, stuckLoading: p.stuckLoading,
      links: p.links.length, controls: p.controls.map(({ toUrl, ...c }) => c) })),
    edges: pages.flatMap(p => [
      ...[...new Map(p.links.map(l => [routeTemplate(l.url), l])).values()].map(l => ({ from: p.route, page: p.path, kind: 'link', label: l.label, selector: l.selector, ...(l.destructive || isDestructive(shortUrl(l.url)) ? { outcome: 'skipped', reason: `destructive link to ${shortUrl(redactUrl(l.url))}, never opened` } : { outcome: 'navigates', to: routeTemplate(l.url) }), status: statusByUrl.get(l.url) ?? linkStatus.get(l.url)?.status ?? null })),
      ...p.controls.filter(c => c.kind === 'button').map(c => ({ from: p.route, page: p.path, kind: 'button', label: c.label, selector: c.selector, outcome: c.outcome, ...(c.to ? { to: c.to } : {}), ...(c.calls ? { calls: c.calls } : {}), ...(c.reason ? { reason: c.reason } : {}), ...(c.reused ? { reused: true } : {}) })),
    ]),
  };
  return pub;
}

/** A 1x1 PNG for a crawl whose start page gave no picture. */
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * `bugframe --dir REPORTS crawl …`: file the crawl in the private inbox as a finished page analysis (kind `audit`,
 * ready for review), with the short report as audit.md and the counts in the note. Returns the new report id.
 */
export async function fileInInbox({ dir, crawl, png, now = new Date() }) {
  const storage = createFileStorage({ dir }), f = crawl.stats.findings, at = now.toISOString();
  const tally = SEVERITIES.filter(s => f[s]).map(s => `${f[s]} ${s}`).join(', ') || 'no findings';
  const note = `Site crawl: ${tally}.${crawl.findings.length ? ` Top: ${crawl.findings.slice(0, 3).map(x => `${x.id} ${x.title}`).join('; ')}.` : ''} Full report: audit.md.`.slice(0, 2000);
  let markdown = crawlMarkdown(crawl, { brief: true });
  if (Buffer.byteLength(markdown) > MAX_ATTACHMENT_BYTES) markdown = `${Buffer.from(markdown).subarray(0, MAX_ATTACHMENT_BYTES - 200).toString('utf8')}\n\n(Shortened: the full report is CRAWL.md.)\n`;
  for (let attempt = 0; ; attempt++) {
    const id = newReportId(now);
    const report = { id, status: 'ready_for_review', note, createdAt: at, reporter: 'admin:cli', description: `Site crawl: ${crawl.origin} (${crawl.stats.pages} page${crawl.stats.pages === 1 ? '' : 's'})`, kind: 'audit', currentText: '', suggestedText: '', reviewVersion: 1, reviewNote: '',
      activity: [{ status: 'ready_for_review', note, at, by: 'developer' }], types: ['Site crawl'], context: { url: `${crawl.origin}${crawl.start}`, title: 'Site crawl', viewport: null, scroll: null, region: null, userAgent: 'bugframe crawl', language: '', capturedAt: at, elements: [], consoleErrors: [], metadata: {} },
      files: { region: 'region.png', full: 'full.png', audit: 'audit.md' }, audit: { attempts: 1, startedAt: crawl.startedAt, finishedAt: at, degraded: false, counts: { blocker: 0, high: f.high, medium: f.medium, low: f.low } } };
    try { await storage.create(report, { region: png ?? BLANK_PNG, full: png ?? BLANK_PNG }); await storage.writeAttachment(id, 'audit.md', Buffer.from(markdown)); return id; }
    catch (e) { if (e?.code !== 'EXISTS' || attempt >= 4) throw e; }
  }
}

/** Highest severity rank that fails the run: --fail-on high fails on high findings; medium on medium or high; … */
export function failsOn(findings, level, { onlyNew = false } = {}) {
  if (!level || level === 'none') return false;
  const at = SEVERITIES.indexOf(level);
  if (at < 0) throw new CliError('--fail-on must be high, medium, low or none.');
  // With a baseline only findings that are new since it can fail the run: the crawl is a ratchet, not a wall.
  return findings.some(f => SEVERITIES.indexOf(f.severity) <= at && (!onlyNew || f.new));
}

/**
 * `bugframe crawl login <url> --save FILE`: open a visible browser, let the person sign in themself, then save the
 * Playwright storage state (cookies + local storage) with mode 0600. Bugframe never sees or types the password.
 */
export async function crawlLogin({ url, save = DEFAULT_AUTH_FILE, allowRemote = false, playwright, project, input = process.stdin, waitMs = DEFAULTS.loginWaitMs, say = m => console.error(m), warn = m => console.error(m) }) {
  assertLocalTarget(url, allowRemote, warn, 'crawl login on');
  const pw = playwright ?? await loadPlaywright(project);
  let browser; try { browser = await pw.chromium.launch({ headless: false }); } catch (e) { throw new CliError(`Could not open a browser window (${String(e?.message ?? e).split('\n')[0]}). Run: npx playwright install chromium`); }
  try {
    const context = await browser.newContext(), page = await context.newPage();
    await page.goto(url).catch(() => {});
    say(`A browser window is open at ${redactUrl(url)}. Sign in there yourself (Bugframe never sees your password), then come back here and press Enter. Keep the window open until then.`);
    const closed = new Promise(r => browser.on?.('disconnected', () => r('closed')));
    const rl = createInterface({ input });
    let answer = await Promise.race([new Promise(r => rl.once('line', () => r('enter'))), new Promise(r => rl.once('close', () => r('no-terminal'))), closed]);
    rl.close();
    if (answer === 'no-terminal') {
      // Nobody can press Enter (stdin is closed or piped). Saving at once would store a session that is not signed in,
      // so wait until the browser has left the sign-in page, and say so; give up with a clear message otherwise.
      const at = href => { try { const u = new URL(href); return u.origin + u.pathname.replace(/\/$/, ''); } catch { return String(href); } }, start = at(page.url?.() ?? url);
      say(`No terminal input is available, so the session is saved as soon as the browser leaves the sign-in page (waiting up to ${Math.round(waitMs / 60_000) || 1} min).`);
      answer = await Promise.race([closed, page.waitForURL(u => at(String(u)) !== start, { timeout: waitMs, waitUntil: 'load' }).then(() => 'signed-in', () => 'timeout')]);
      if (answer === 'timeout') throw new CliError(`Nothing was saved: the browser was still on the sign-in page after ${Math.round(waitMs / 1000)} s and there is no terminal to confirm in. Run the command in a terminal and press Enter after signing in.`);
      if (answer === 'signed-in') await sleep(1500); // let the session cookie land
    }
    if (answer === 'closed') throw new CliError('The browser window was closed before the session was saved. Run the command again and press Enter here while the window is still open.');
    const state = await context.storageState(), file = resolve(save);
    await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 }); await chmod(file, 0o600);
    return `Saved the signed-in session to ${save} (mode 600: ${state.cookies?.length ?? 0} cookie(s), ${state.origins?.length ?? 0} origin(s) with local storage).\nIt holds live session cookies: treat it like a password, never commit it (add ".bugframe-auth*.json" to .gitignore), and delete it when done.\nNext: bugframe crawl ${new URL(url).origin}/ --storage-state ${save}`;
  } finally { await browser.close().catch(() => {}); }
}

/** The `bugframe crawl` command line. */
export async function crawlCommand(args, v, { summarize: summarizeFn } = {}) {
  const [first, second] = args;
  if (first === 'login') {
    if (!second) throw new CliError('Usage: bugframe crawl login <url> [--save .bugframe-auth.json] [--allow-remote]');
    return crawlLogin({ url: second, save: v.save, allowRemote: v['allow-remote'], project: v.project });
  }
  if (!first) throw new CliError('Usage: bugframe crawl <start-url> [--out DIR] [--max-pages 200] [--max-depth 6] [--include GLOB]... [--exclude GLOB]... [--storage-state FILE] [--no-click] [--settle-ms 700] [--summarize] (see bugframe --help).');
  const int = (name, def) => { if (v[name] === undefined) return def; const n = Number(v[name]); if (!Number.isInteger(n)) throw new CliError(`--${name} must be a whole number.`); return n; };
  const failOn = v['fail-on'] ?? 'none'; failsOn([], failOn);
  if (v.model && !v.summarize) throw new CliError('--model only applies with --summarize.');
  const controller = new AbortController(); let signals = 0;
  const stop = () => { if (++signals > 1) process.exit(130); console.error('[crawl] stopping: finishing the current page and writing the report (Ctrl+C again to quit at once)'); controller.abort(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const res = await crawlSite({ startUrl: first, out: v.out ?? `bugframe-crawl-${stamp()}`, maxPages: int('max-pages', DEFAULTS.maxPages), maxDepth: int('max-depth', DEFAULTS.maxDepth), include: v.include ?? [], exclude: v.exclude ?? [],
      viewports: v.viewports ?? DEFAULTS.viewports, storageState: v['storage-state'], click: !v['no-click'], maxControls: int('max-controls-per-page', DEFAULTS.maxControls), concurrency: int('concurrency', DEFAULTS.concurrency),
      timeoutMs: int('timeout', DEFAULTS.timeoutMs), maxMinutes: int('max-minutes', DEFAULTS.maxMinutes), settleMs: int('settle-ms', DEFAULTS.settleMs), allowRemote: v['allow-remote'], project: v.project, baseline: v.baseline, saveBaseline: v['save-baseline'], startShot: Boolean(v.dir), signal: controller.signal, log: m => console.error(`[crawl] ${m}`) });
    const f = res.stats.findings, lines = [
      `Crawled ${res.stats.pages} page(s) (${res.stats.routes} route(s)), tested ${res.stats.controlsTested} control(s), skipped ${res.stats.controlsSkippedDestructive} destructive one(s)${res.partial ? ' (partial run)' : ''}.`,
      `Findings: ${f.high} high, ${f.medium} medium, ${f.low} low.${res.baseline ? ` Since the baseline: ${res.baseline.new} new, ${res.baseline.known} known, ${res.baseline.fixed.length} fixed.` : ''}`,
      ...(v['save-baseline'] ? [`Saved the baseline to ${v['save-baseline']}: commit it, then run with --baseline ${v['save-baseline']} --fail-on high so only new findings fail.`] : []),
      `Wrote ${join(res.out, 'crawl.html')} (open it in a browser), ${join(res.out, 'CRAWL.md')} (hand it to your coding agent) and crawl.json.`];
    if (v.summarize) {
      const s = await (summarizeFn ?? (await import('./summary.mjs')).summarize)({ crawl: res, out: res.out, model: v.model ?? 'haiku', budget: v.budget, log: m => console.error(`[crawl] ${m}`) });
      lines.push(s.degraded ? `SUMMARY.md: the model's answer was not usable (${s.errors.slice(0, 2).join('; ')}); wrote the script-only grouping instead and kept the raw answer in summary-output.txt.` : `Wrote ${join(res.out, 'SUMMARY.md')} (${s.model}, ~${s.estTokens} input tokens, ${s.seconds} s).`);
    }
    if (v.dir) {
      const png = await readFile(join(res.out, 'screens', 'start.png')).catch(() => null);
      lines.push(`Filed in the inbox at ${v.dir} as ${await fileInInbox({ dir: v.dir, crawl: res, png })} (a finished page analysis with the short report).`);
    }
    if (failsOn(res.findings, failOn, { onlyNew: Boolean(res.baseline) })) { process.exitCode = 1; lines.push(`Exit code 1: ${res.baseline ? 'new ' : ''}findings at or above --fail-on ${failOn}.`); }
    return lines.join('\n');
  } catch (e) {
    // Exit code 1 means "findings at --fail-on"; anything that stops the run itself is a run error (exit 2).
    if (e instanceof CliError) throw e;
    throw new CliError(`the crawl stopped with an error: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
