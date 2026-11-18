// What a click did, and the whole-site checks: dead wiring, broken routes, and inconsistencies between pages
// (navigation, labels, actions, titles, repeated errors, failing endpoints). Pure functions over the crawl data.
import { FIXES } from '../audit/report.mjs';
import { routeTemplate, shortUrl } from './urls.mjs';

export const SEVERITIES = ['high', 'medium', 'low'];
export const OUTCOMES = ['navigates', 'opens', 'changes', 'calls-backend', 'error', 'dead'];

/**
 * One click record from the shared click probe → { outcome, to?, calls?, reason? }:
 * navigates (the URL changed: full load, pushState or hash route), error (console/page error or failed request),
 * calls-backend (a request was fired or a write was blocked: `POST /api/x`), opens (dialog, menu, popover, popup,
 * aria-expanded), changes (the DOM changed in place or focus moved), dead (none of these), skipped and unknown.
 */
export function classifyClick(rec) {
  const o = String(rec?.outcome ?? '');
  if (o.startsWith('skipped')) return { outcome: 'skipped', reason: o.replace(/^skipped:\s*/, '') };
  if (o === 'not found in a fresh page' || o === 'probe error') return { outcome: 'unknown', reason: rec.error ? `${o}: ${rec.error}` : o };
  if (o === 'could not click') return { outcome: 'dead', reason: 'the control could not be clicked (covered, disabled or detached)' };
  if (o.startsWith('unclear')) return { outcome: 'unknown', reason: 'the page keeps changing on its own (polling or timers), so a click with no effect of its own cannot be told apart from a dead one' };
  const e = rec.effects ?? {};
  const writes = (e.blockedRequests ?? []).map(b => String(b).replace(/^would have sent /, ''));
  const navBlocked = writes.find(w => w.startsWith('NAVIGATE ')), redirectBlocked = writes.find(w => w.startsWith('REDIRECT '));
  // A blocked GET is also in the list of requests the click fired: keep the entry that says it was blocked.
  const sent = writes.filter(w => !/^(NAVIGATE|REDIRECT) /.test(w)), calls = uniq([...sent, ...(e.calls ?? []).filter(c => !sent.includes(`BLOCKED ${c}`))]);
  if (e.navigatedUrl) return { outcome: 'navigates', to: e.navigatedUrl, ...(calls.length ? { calls } : {}) };
  if (redirectBlocked) return { outcome: 'navigates', to: null, reason: `redirect not followed by the crawl guard: ${redirectBlocked.slice(9)}` };
  if (navBlocked) return { outcome: 'navigates', to: null, reason: `navigation blocked by the crawl guard: ${navBlocked.slice(9)}` };
  const errors = [...(e.pageErrors ?? []), ...(e.consoleErrors ?? []), ...(e.failedRequests ?? [])];
  if (errors.length) return { outcome: 'error', reason: errors[0], ...(calls.length ? { calls } : {}) };
  if (calls.length) return { outcome: 'calls-backend', calls };
  if (e.opened || e.popup || e.dialog) return { outcome: 'opens', reason: e.popup ? 'popup window' : e.dialog ? 'browser dialog' : 'dialog, menu or panel' };
  if (e.domChanged || e.focusMoved) return { outcome: 'changes' };
  if (e.anchor) return { outcome: 'changes', reason: `scrolls to ${e.anchor}` };
  if (e.formSubmitIntercepted) return { outcome: 'dead', reason: 'the form was submitted, but it has no action and no handler did anything' };
  return { outcome: 'dead' };
}

const CRAWL_FIXES = {
  'dead-control': 'Wire the control to its action, or remove it (or show it disabled with a reason) until it works.',
  'dead-form': 'Give the form a submit handler or an action that saves the data, and show the result (success or error) to the person.',
  'click-error': 'Fix the error this click raises (see the evidence) and add a test that clicks it.',
  'broken-link': 'Point the link at a page that exists, or remove it; check the route table for a renamed path.',
  'route-error': 'Make this route render (fix the server error or add the page), or stop linking to it.',
  'offsite-redirect': 'Check that this redirect is meant to leave the site; if it is, link to the target directly and mark it as an external link.',
  'redirect-loop': 'Break the redirect chain: make the route answer with a page, or redirect straight to the final address.',
  'orphan-route': 'Link to this page from the navigation or a related page, or remove it from the sitemap if it is retired.',
  'sitemap-broken': 'Remove the URL from sitemap.xml or restore the page.',
  'nav-inconsistent': 'Render the navigation from one shared component and one list of items on every page.',
  'label-multiple-destinations': 'Use one destination per label, or rename the links so each label means one place.',
  'destination-multiple-labels': 'Name each destination the same way everywhere in the navigation.',
  'action-inconsistent': 'Use one shared handler for this action so the same button does the same thing on every page.',
  'missing-title': 'Give every page a unique <title> that names the page and the product.',
  'missing-h1': 'Give the page one <h1> that says what it is.',
  'duplicate-title': 'Make each page title unique (page name first, product name second).',
  'repeated-console-error': 'One shared code path throws on every listed page: fix it once at the source (layout, shared component or config).',
  'failing-endpoint': 'Fix this endpoint (or the URL the pages build for it) and show a clear error state when it fails.',
  'stuck-loading': 'Make the loading state finish: resolve or fail the request, and replace the spinner with the content, an empty state or an error.',
  'mixed-language': 'Translate the leftover strings so the page uses one language (check the i18n keys used on this page).',
};
export const fixFor = type => CRAWL_FIXES[type] ?? FIXES[type] ?? 'Investigate the measured evidence.';

/** Labels too generic to compare across pages. */
const GENERIC = new Set(['', 'more', 'read more', 'learn more', 'see more', 'see all', 'view', 'view all', 'details', 'edit', 'open', 'back', 'next', 'previous', 'prev', 'here', 'click here', 'link', 'show', 'close', 'cancel', 'ok', 'skip to content', 'skip to main content', 'menu', 'search']);
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const comparable = label => { const l = norm(label); return l.length > 0 && l.length <= 40 && !GENERIC.has(l) && !/^[\d\s#.,:/-]+$/.test(l); };
const uniq = list => [...new Set(list)];
const groupBy = (items, key) => { const m = new Map(); for (const it of items) { const k = key(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it); } return m; };
/** Error text with numbers and quoted values blurred, so the same error on different records groups together. */
const errorKey = m => String(m).split('\n')[0].replace(/https?:\/\/[^\s'")]+/g, u => shortUrl(u)).replace(/\d+/g, 'N').slice(0, 200);

/**
 * Every whole-site check. `pages` are crawl page records, `linkStatus` maps a normalised URL to { status, error,
 * skipped } for link targets that were not crawled, `sitemap` lists normalised sitemap URLs.
 */
export function analyze({ pages, linkStatus = new Map(), sitemap = [], settleMs = 700 }) {
  const out = [];
  const ok = pages.filter(p => p.status !== null && p.status < 400 && !p.redirectedTo && !p.blockedRedirect);
  const add = f => out.push({ selector: '', screenshot: null, ...f, routes: uniq(f.routes ?? []), pages: uniq(f.pages ?? []).slice(0, 50), fix: fixFor(f.type) });
  const pageOf = new Map(pages.map(p => [p.url, p]));
  const statusOf = url => { const p = pageOf.get(url); if (p) return { status: p.status, error: p.error }; return linkStatus.get(url) ?? null; };

  // 1. Controls: dead, dead forms, errors on click.
  for (const p of pages) for (const c of p.controls ?? []) {
    if (c.reused) continue;
    if (c.outcome === 'dead') add({ type: c.submit ? 'dead-form' : 'dead-control', severity: 'high', title: c.submit ? `Form submit "${c.label || c.selector}" does nothing` : `"${c.label || c.selector}" does nothing when clicked`, routes: [p.route], pages: [p.path], selector: c.selector, evidence: c.reason ?? `click caused no navigation, request, dialog, DOM change, focus change or console output within ${settleMs} ms`, screenshot: c.screenshot ?? p.screenshot });
    if (c.outcome === 'error') add({ type: 'click-error', severity: 'high', title: `Clicking "${c.label || c.selector}" raises an error`, routes: [p.route], pages: [p.path], selector: c.selector, evidence: c.reason, screenshot: c.screenshot ?? p.screenshot });
  }

  // 2. Routes that fail to load, and links (any page) to routes that fail. Links from navigation regions are high.
  // A 404 reached by an ordinary link is reported once, as that broken link (below); here: start, clicks, redirects.
  // A redirect the guard refused: off the site (worth knowing, often intended) or going round in circles (a bug).
  for (const p of pages) if (p.blockedRedirect) {
    const { to, reason } = p.blockedRedirect, offsite = reason === 'another site';
    if (!offsite && reason !== 'too many redirects') continue; // a destructive target is listed under "never opened"
    add({ type: offsite ? 'offsite-redirect' : 'redirect-loop', severity: offsite ? 'low' : 'medium', title: offsite ? `${p.path} redirects to another site: ${to}` : `${p.path} redirects more than 5 times`, routes: [p.route], pages: [p.path],
      evidence: `GET ${p.path} → ${p.status}, Location ${to}; ${offsite ? 'the crawl never follows a redirect off the site, so nothing was requested there' : 'the chain was stopped'}; reached via ${p.via}${p.from ? ` from ${p.from}` : ''}` });
  }
  for (const p of pages) if ((p.status === null || p.status >= 400) && !['link', 'sitemap'].includes(p.via)) add({ type: 'route-error', severity: p.status >= 500 || p.status === null ? 'high' : 'medium', title: `${p.path} answers ${p.status ?? p.error ?? 'nothing'}`, routes: [p.route], pages: [p.path], evidence: `GET ${p.path} → ${p.status ?? p.error}; reached via ${p.via}${p.from ? ` from ${p.from}` : ''}` });
  const linkEdges = ok.flatMap(p => (p.links ?? []).map(l => ({ ...l, page: p })));
  for (const [url, edges] of groupBy(linkEdges, l => l.url)) {
    const st = statusOf(url); if (!st || st.skipped || (st.status !== null && st.status !== undefined && st.status < 400)) continue;
    const inNav = edges.some(e => e.inNav);
    add({ type: 'broken-link', severity: inNav ? 'high' : 'medium', title: `${inNav ? 'Navigation link' : 'Link'} to ${shortUrl(url)} is broken (${st.status ?? st.error ?? 'no answer'})`, routes: edges.map(e => e.page.route), pages: edges.map(e => e.page.path), selector: edges[0].selector,
      evidence: `GET ${shortUrl(url)} → ${st.status ?? st.error}; linked as ${uniq(edges.map(e => `"${e.label}"`)).slice(0, 5).join(', ')} from ${uniq(edges.map(e => e.page.path)).length} page(s)`, screenshot: edges[0].page.screenshot });
  }

  // 3. Sitemap: broken entries and orphans (listed, but nothing crawled links or clicks to them).
  const inbound = new Set();
  for (const p of ok) { for (const l of p.links ?? []) if (l.url !== p.url) inbound.add(l.url); for (const c of p.controls ?? []) if (c.toUrl && c.toUrl !== p.url) inbound.add(c.toUrl); }
  for (const url of sitemap) {
    const st = statusOf(url);
    if (st && st.status >= 400) add({ type: 'sitemap-broken', severity: 'medium', title: `sitemap.xml lists ${shortUrl(url)}, which answers ${st.status}`, routes: [routeTemplate(url)], pages: [shortUrl(url)], evidence: `GET ${shortUrl(url)} → ${st.status}` });
    else if (st && !inbound.has(url) && pageOf.has(url)) add({ type: 'orphan-route', severity: 'low', title: `Nothing links to ${shortUrl(url)}`, routes: [routeTemplate(url)], pages: [shortUrl(url)], evidence: `listed in sitemap.xml and reachable (${st.status}), but no crawled page links to it or opens it with a click`, screenshot: pageOf.get(url)?.screenshot });
  }

  // 4. Navigation consistency: each shared region (header, nav, footer) compared with its most common version.
  const regions = new Map();
  for (const p of ok) for (const r of p.regions ?? []) { if (!regions.has(r.key)) regions.set(r.key, []); regions.get(r.key).push({ page: p, items: r.items.map(i => ({ label: norm(i.label), to: i.url ? routeTemplate(i.url) : null, raw: i.label })) }); }
  for (const [key, list] of regions) {
    if (list.length < 3) continue;
    const sig = it => it.items.map(i => `${i.label}→${i.to}`).join('|');
    const counts = groupBy(list, sig), [baseSig, base] = [...counts].sort((a, b) => b[1].length - a[1].length)[0];
    if (base.length < 2 || base.length === list.length) continue;
    const ref = base[0].items, diffs = new Map();
    for (const it of list) {
      if (sig(it) === baseSig) continue;
      const has = (arr, i) => arr.some(j => j.label === i.label && j.to === i.to);
      let missing = ref.filter(i => !has(it.items, i) && i.to !== it.page.route), extra = it.items.filter(i => !has(ref, i));
      const moved = extra.filter(i => missing.some(j => j.label === i.label)).map(i => ({ i, was: missing.find(j => j.label === i.label) }));
      missing = missing.filter(j => !moved.some(m => m.was === j)); extra = extra.filter(i => !moved.some(m => m.i === i));
      const parts = moved.map(m => `"${m.i.raw}" points to ${m.i.to} instead of ${m.was.to}`);
      if (missing.length) parts.push(`missing ${missing.map(i => `"${i.raw}" (${i.to})`).join(', ')}`);
      if (extra.length) parts.push(`extra ${extra.map(i => `"${i.raw}" (${i.to})`).join(', ')}`);
      if (!missing.length && !extra.length && it.items.length === ref.length) parts.push(`different order: ${it.items.map(i => `"${i.raw}"`).join(', ')} instead of ${ref.map(i => `"${i.raw}"`).join(', ')}`);
      if (!parts.length) continue;
      const d = parts.join('; '); if (!diffs.has(d)) diffs.set(d, []); diffs.get(d).push(it.page);
    }
    for (const [d, ps] of diffs) add({ type: 'nav-inconsistent', severity: 'medium', title: `The ${key} differs on ${ps.length} page(s)`, routes: ps.map(p => p.route), pages: ps.map(p => p.path), selector: key, evidence: `${d}; compared with the version on ${base.length} of ${list.length} pages (e.g. ${base[0].page.path})`, screenshot: ps[0].screenshot });
  }

  // 5. Labels and destinations. Same label → different routes (any link); same route → different labels (inside <nav>).
  for (const [, edges] of groupBy(linkEdges.filter(l => comparable(l.label)), l => norm(l.label))) {
    const dests = groupBy(edges, e => routeTemplate(e.url)); if (dests.size < 2) continue;
    add({ type: 'label-multiple-destinations', severity: 'medium', title: `"${edges[0].label}" leads to ${dests.size} different places`, routes: edges.map(e => e.page.route), pages: edges.map(e => e.page.path), selector: edges[0].selector,
      evidence: [...dests].map(([to, es]) => `${to} (from ${uniq(es.map(e => e.page.path)).slice(0, 4).join(', ')})`).join(' vs ') });
  }
  for (const [to, edges] of groupBy(linkEdges.filter(l => l.inNav && comparable(l.label)), l => routeTemplate(l.url))) {
    const labels = groupBy(edges, e => norm(e.label)); if (labels.size < 2) continue;
    add({ type: 'destination-multiple-labels', severity: 'low', title: `${to} is called ${[...labels.values()].map(es => `"${es[0].label}"`).join(' and ')} in the navigation`, routes: edges.map(e => e.page.route), pages: edges.map(e => e.page.path),
      evidence: [...labels.values()].map(es => `"${es[0].label}" on ${uniq(es.map(e => e.page.path)).slice(0, 4).join(', ')}`).join('; ') });
  }

  // 6. The same action wired differently: buttons with one label whose outcome or backend calls differ between pages.
  const tested = ok.flatMap(p => (p.controls ?? []).filter(c => !c.reused && c.kind === 'button' && comparable(c.label) && OUTCOMES.includes(c.outcome)).map(c => ({ ...c, page: p })));
  for (const [, cs] of groupBy(tested, c => norm(c.label))) {
    const wiring = c => `${c.outcome}${c.calls?.length ? ` ${uniq(c.calls.map(x => x.replace(/\/\d+(?=\/|$)/g, '/:id'))).sort().join(', ')}` : ''}`;
    const ways = groupBy(cs, wiring); if (ways.size < 2) continue;
    add({ type: 'action-inconsistent', severity: 'medium', title: `"${cs[0].label}" does different things on different pages`, routes: cs.map(c => c.page.route), pages: cs.map(c => c.page.path), selector: cs[0].selector,
      evidence: [...ways].map(([w, list]) => `${w} on ${uniq(list.map(c => c.page.path)).slice(0, 4).join(', ')}`).join('; '), screenshot: (cs.find(c => c.outcome === 'dead') ?? cs[0]).screenshot ?? cs[0].page.screenshot });
  }

  // 7. Titles and headings.
  for (const p of ok) {
    if (!norm(p.title)) add({ type: 'missing-title', severity: 'medium', title: `${p.path} has no <title>`, routes: [p.route], pages: [p.path], evidence: 'document.title is empty', screenshot: p.screenshot });
    if (!(p.h1 ?? []).length) add({ type: 'missing-h1', severity: 'low', title: `${p.path} has no <h1>`, routes: [p.route], pages: [p.path], evidence: 'no visible h1 element', screenshot: p.screenshot });
  }
  for (const [title, ps] of groupBy(ok.filter(p => norm(p.title)), p => norm(p.title))) {
    const routes = uniq(ps.map(p => p.route)); if (routes.length < 2) continue;
    add({ type: 'duplicate-title', severity: 'low', title: `${routes.length} different routes share the title "${ps[0].title}"`, routes, pages: ps.map(p => p.path), evidence: `title "${title}" on ${routes.join(', ')}` });
  }

  // 8. Errors on load: the same message on several pages is one root cause; failing endpoints grouped by route.
  for (const kind of ['pageErrors', 'consoleErrors']) {
    for (const [, hits] of groupBy(pages.flatMap(p => uniq(p[kind] ?? []).map(m => ({ m, p }))), h => errorKey(h.m))) {
      const ps = uniq(hits.map(h => h.p)), many = ps.length > 1;
      add({ type: many ? 'repeated-console-error' : kind === 'pageErrors' ? 'page-error' : 'console-error', severity: many || kind === 'pageErrors' ? 'high' : 'medium',
        title: `${many ? `The same ${kind === 'pageErrors' ? 'uncaught error' : 'console error'} on ${ps.length} pages` : kind === 'pageErrors' ? 'Uncaught error' : 'Console error'}: ${hits[0].m.split('\n')[0].slice(0, 90)}`,
        routes: ps.map(p => p.route), pages: ps.map(p => p.path), evidence: hits[0].m.slice(0, 400), screenshot: ps[0].screenshot });
    }
  }
  const failed = pages.flatMap(p => (p.failed ?? []).filter(r => r.url !== p.pathname).map(r => ({ r, p })));
  for (const [key, hits] of groupBy(failed, h => `${h.r.method} ${h.r.url.replace(/\/\d+(?=\/|$)/g, '/:id')}`)) {
    const statuses = uniq(hits.map(h => h.r.status ?? h.r.error)), ps = uniq(hits.map(h => h.p));
    add({ type: 'failing-endpoint', severity: hits.some(h => h.r.status === null || h.r.status >= 500) ? 'high' : 'medium', title: `${key} fails on ${ps.length} page(s) (${statuses.join(', ')})`, routes: ps.map(p => p.route), pages: ps.map(p => p.path), evidence: `${key} → ${statuses.join(', ')} while loading ${uniq(ps.map(p => p.path)).slice(0, 5).join(', ')}` });
  }

  // 9. Loading states that never finish, and pages mixing languages.
  for (const p of ok) {
    if (p.stuckLoading) add({ type: 'stuck-loading', severity: 'medium', title: `${p.path} is still loading after ${Math.round((p.waitedMs ?? 0) / 1000)} s`, routes: [p.route], pages: [p.path], selector: p.stuckLoading, evidence: `loading indicator ${p.stuckLoading} still visible after the page's network went idle and ${p.waitedMs} ms passed`, screenshot: p.screenshot });
    const l = p.languages; if (l?.mixed) add({ type: 'mixed-language', severity: 'low', title: `${p.path} mixes ${l.mixed.join(' and ')}`, routes: [p.route], pages: [p.path], evidence: `common-word counts: ${Object.entries(l.counts).map(([k, v]) => `${k} ${v}`).join(', ')}${p.lang ? `; <html lang="${p.lang}">` : ''}`, screenshot: p.screenshot });
  }

  // 10. The page probe (contrast, overflow, names, tap targets…): one finding per element and check across pages.
  //     Rows of one list (`li:nth-of-type(1..50) > a`, "Tap target 53x18px", "…55x18px") count as one finding.
  const blur = t => String(t).replace(/\d+/g, 'N');
  for (const [, hits] of groupBy(pages.flatMap(p => (p.probe ?? []).map(f => ({ f, p }))), h => `${h.f.type}\u0000${blur(h.f.selector)}\u0000${blur(h.f.title)}`)) {
    const f = hits[0].f, ps = uniq(hits.map(h => h.p)), elements = uniq(hits.map(h => h.f.selector)).length;
    add({ type: f.type, severity: f.severity === 'blocker' ? 'high' : f.severity, title: elements > 1 ? `${f.title} (and ${elements - 1} similar)` : f.title, routes: ps.map(p => p.route), pages: ps.map(p => p.path), selector: f.selector,
      evidence: `${f.evidence}${elements > 1 ? `; ${elements} elements matching ${blur(f.selector).replace(/N/g, '*')}` : ''} (${uniq(hits.map(h => h.f.viewport)).join(', ')})`, screenshot: ps[0].screenshot });
  }

  out.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.pages.length - a.pages.length);
  return out.map((f, i) => ({ id: `C${i + 1}`, ...f }));
}

/** Common words per language for the mixed-language heuristic (en/pt/es, the languages Bugframe ships). */
const STOP = {
  en: ['the', 'and', 'with', 'your', 'you', 'this', 'that', 'for', 'are', 'from', 'have', 'will', 'our', 'about', 'what'],
  pt: ['você', 'não', 'para', 'com', 'uma', 'seu', 'sua', 'são', 'mais', 'também', 'então', 'isso', 'nós', 'pelo', 'pela'],
  es: ['usted', 'para', 'con', 'una', 'los', 'las', 'del', 'está', 'más', 'también', 'pero', 'nosotros', 'esto', 'cómo', 'qué'],
};
/** Counts of common words per language in a page's visible text; `mixed` names two languages that both hold ≥ 25 %. */
export function languageMix(text) {
  const words = String(text ?? '').toLowerCase().match(/\p{L}+/gu) ?? [], counts = {};
  for (const [lang, list] of Object.entries(STOP)) counts[lang] = words.filter(w => list.includes(w)).length;
  // "para", "con", "una" are shared by pt and es: only languages with words unique to them are counted as present.
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const present = Object.keys(counts).filter(l => counts[l] >= 4 && counts[l] / total >= 0.25 && words.some(w => STOP[l].includes(w) && !Object.entries(STOP).some(([o, ws]) => o !== l && ws.includes(w))));
  return { counts, ...(total >= 12 && present.length >= 2 ? { mixed: present } : {}) };
}
