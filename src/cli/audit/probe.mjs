// The probe: deterministic evidence from a real browser (Playwright, loaded only when an audit runs). It measures,
// it never mutates: every non-GET request, WebSocket and beacon is blocked, forms never reach the network, destructive
// controls and links are skipped.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CliError } from '../commands.mjs';

export const DEFAULT_VIEWPORTS = '390x844,768x1024,1280x800,1440x900';
const MAX_CLICKS = 40, MAX_LINKS = 30, NAV_TIMEOUT = 30_000;
/** Labels and links never clicked or fetched (en/pt/es). Matched by isDestructive against the visible name, aria-label,
 *  title and the whole href (path and query). */
export const DESTRUCTIVE = /\b(delete|remove|destroy|erase|wipe|purge|pay|payment|purchase|buy|checkout|place order|order now|subscribe|unsubscribe|log ?out|log ?off|sign ?out|sign ?off|end session|session end|deactivate|close account|cancel (subscription|account|plan|order)|transfer|withdraw|refund|send money|reset|revoke|excluir|apagar|remover|deletar|pagar|comprar|finalizar compra|assinar|sair|deslogar|desconectar|desativar|(encerrar|terminar|finalizar|fechar) sess[aã]o|cancelar (assinatura|conta|plano|pedido)|transferir|sacar|reembolsar|eliminar|borrar|quitar|suscribirse|salir|desconectarse|(cerrar|finalizar|terminar) sesi[oó]n|darse de baja|cancelar suscripci[oó]n|retirar)\b/i;
/** True when a label or URL holds a destructive word, including inside URL paths and queries and camelCase, kebab-case
 *  or snake_case names: "/items/8/deleteItem" and "/items/7?op=delete" both count. */
export function isDestructive(text) {
  let s = String(text ?? ''); try { s = decodeURIComponent(s); } catch { /* keep it encoded */ }
  return DESTRUCTIVE.test(s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' '));
}
const SECRET_PARAM = /token|key|secret|pass|auth|code|session|sig|jwt|otp|nonce|credential/i;
/** How long a click gets to show an effect, and how long the page is watched beforehand for changes of its own. */
export const DEFAULT_SETTLE_MS = 700;
/** A fragment that is a client-side route (`#/clients`, `#!/clients`) rather than an in-page anchor. */
export const HASH_ROUTE = /^#!?\//;
/** The guard's own address on the audited origin: worker stubs report here and module workers load their stub from it.
 *  Requests to it are answered by the guard and never reach the site. */
const GUARD_PATH = '/__bugframe_guard__';
const WORKER_MARK = '__bugframe_worker';
/** Requests that only fetch files to show: a click may load these from any URL. Everything else is an API call. */
const ASSET_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'manifest', 'texttrack']);
// Per page: the navigation load() is driving, the end of a redirect chain the guard followed for the page, and
// whether a click has been dispatched (from then on a GET to a destructive-looking URL is blocked too).
const loading = new WeakMap(), redirected = new WeakMap(), armed = new WeakSet();
/** Record something the guard stopped. The time is kept off the JSON so a click can tell its own blocks from the page's. */
const note = (blocked, entry) => { blocked.push(Object.defineProperty(entry, 't', { value: Date.now(), enumerable: false })); };
/** One key per distinct blocked request: a redirect hop also counts where it came from. */
export const blockKey = b => `${b.method} ${b.url}${b.from ? ` ← ${b.from}` : ''}`;
/**
 * A Playwright or network error as a short message for a report: no API prefix ("page.goto:"), no call log and no
 * address (URLs become their path, host:port is dropped). Findings never quote the raw browser error.
 */
export function cleanError(e) {
  const m = String(e?.message ?? e).split('\n')[0];
  const ms = /Timeout (\d+)ms exceeded|timed out after (\d+) ?ms/i.exec(m);
  if (ms) return `no answer within ${Math.round(Number(ms[1] ?? ms[2]) / 1000)} s`;
  const net = /net::ERR_([A-Z_]+)/.exec(m)?.[1] ?? { ECONNREFUSED: 'CONNECTION_REFUSED', ECONNRESET: 'CONNECTION_RESET', ENOTFOUND: 'NAME_NOT_RESOLVED', ETIMEDOUT: 'TIMED_OUT', EHOSTUNREACH: 'ADDRESS_UNREACHABLE' }[/\b(E[A-Z]+)\b/.exec(m)?.[1]];
  if (net) return `network error: ${net.toLowerCase().replace(/_/g, ' ')}`;
  return scrub(m.replace(/^[\w.]+: /, '').replace(/\bhttps?:\/\/[^\s'")]+/g, u => { try { return new URL(u).pathname; } catch { return '(address)'; } })
    .replace(/(?<![\w.])(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|\[[\da-f:]+\])(?::\d+)?/gi, '(address)')).slice(0, 160);
}

/**
 * Runs first inside every dedicated worker the guard lets start. A worker's sockets are invisible to Playwright's
 * WebSocket routing (which lives in the page), so the stub replaces them: nothing connects, the attempt is reported to
 * the guard's own address and the worker sees a socket that failed to open. Workers started by a worker are not started.
 */
const WORKER_PRELUDE = `(() => { if (self.__bfGuard) return; self.__bfGuard = 1;
const tell = (kind, url) => { let u = String(url); try { u = new URL(u, location.href).href; } catch (e) {} try { fetch(self.origin + '${GUARD_PATH}/blocked?kind=' + kind + '&url=' + encodeURIComponent(u)).catch(() => {}); } catch (e) {} };
self.WebSocket = class WebSocket extends EventTarget {
  constructor(url) { super(); tell('WEBSOCKET', url); this.url = String(url); this.readyState = 3; this.bufferedAmount = 0; this.protocol = ''; this.extensions = ''; this.binaryType = 'blob';
    setTimeout(() => { for (const type of ['error', 'close']) { const e = new Event(type); if (typeof this['on' + type] === 'function') this['on' + type](e); this.dispatchEvent(e); } }, 0); }
  send() {} close() {}
};
Object.assign(self.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
if (self.WebTransport) self.WebTransport = class WebTransport { constructor(url) { tell('WEBTRANSPORT', url); const fail = Promise.reject(new Error('Blocked by the Bugframe guard')); fail.catch(() => {}); this.ready = fail; this.closed = fail; } close() {} };
if (self.Worker) self.Worker = class Worker extends EventTarget { constructor(url) { super(); tell('WORKER', url); } postMessage() {} terminate() {} };
})();`;

/** "390x844,1280x800" → [{ width, height, name }]. */
export function parseViewports(value = DEFAULT_VIEWPORTS) {
  const list = String(value).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^(\d{3,4})x(\d{3,4})$/.exec(s); if (!m) throw new CliError(`Bad viewport "${s}". Use WIDTHxHEIGHT, e.g. 390x844.`);
    const width = Number(m[1]), height = Number(m[2]);
    if (width < 200 || width > 4000 || height < 200 || height > 4000) throw new CliError(`Viewport ${s} is out of range (200–4000).`);
    return { width, height, name: `${width}x${height}` };
  });
  if (!list.length || list.length > 8) throw new CliError('Give 1 to 8 viewports.');
  return list;
}

/** Keep the page URL useful but drop credentials and the value of secret-looking query parameters. */
export function redactUrl(u) {
  const url = new URL(u); url.username = ''; url.password = '';
  for (const k of [...url.searchParams.keys()]) if (SECRET_PARAM.test(k)) url.searchParams.set(k, 'REDACTED');
  return url.href;
}
/** A request URL for the record: the path for this site, origin + path for others. Never the query string. */
export const pathOf = (u, origin) => { try { const x = new URL(u); return x.origin === origin ? x.pathname : x.origin + x.pathname; } catch { return '(invalid url)'; } };
export const scrub = text => String(text ?? '').replace(/([?&][^=\s&#]*(?:token|key|secret|pass|auth|code|session|sig)[^=\s&#]*=)[^&\s#'"]+/gi, '$1REDACTED').slice(0, 500);

/** Playwright exits the whole process on Node.js below 20, so check before importing it. */
export const PLAYWRIGHT_MIN_NODE = 20;
export const playwrightNodeProblem = (node = process.versions.node) => Number(String(node).split('.')[0]) < PLAYWRIGHT_MIN_NODE ? `audit and crawl need Node.js ${PLAYWRIGHT_MIN_NODE} or newer (you have ${node}); Playwright does not run on older versions` : '';

export async function loadPlaywright(project, node = process.versions.node) {
  const problem = playwrightNodeProblem(node);
  if (problem) throw new CliError(`${problem[0].toUpperCase()}${problem.slice(1)}.`);
  const specs = [];
  if (project) {
    try { const req = createRequire(join(resolve(project), 'package.json')); for (const n of ['playwright', '@playwright/test']) { try { specs.push(pathToFileURL(req.resolve(n)).href); } catch { /* not installed there */ } } } catch { /* no package.json */ }
  }
  specs.push('playwright', '@playwright/test');
  for (const spec of specs) {
    try { const m = await import(spec); const pw = m.chromium ? m : m.default; if (pw?.chromium) return pw; } catch { /* try the next */ }
  }
  throw new CliError('Page audit needs Playwright. In your project run: npm i -D playwright && npx playwright install chromium');
}

// ---- runs inside the page (serialized by Playwright: no closures over module scope)
export function pageChecks({ phone, structural, max }) {
  const out = [], vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const add = (type, severity, el, title, evidence, measured = {}) => { if (out.filter(f => f.type === type).length < max) out.push({ type, severity, selector: el ? sel(el) : '', title, evidence, measured }); };
  const isUi = el => Boolean(el.closest?.('[data-bug-ui]'));
  function sel(el) {
    if (!(el instanceof Element)) return '';
    const unique = s => { try { return document.querySelectorAll(s).length === 1; } catch { return false; } };
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    for (const a of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
      const v = el.getAttribute(a); if (v && v.length < 60) { const s = `${tag}[${a}="${v.replace(/["\\]/g, '\\$&')}"]`; if (unique(s)) return s; }
    }
    const parts = []; let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 6) {
      if (node.id && unique('#' + CSS.escape(node.id))) { parts.unshift('#' + CSS.escape(node.id)); break; }
      const t = node.tagName.toLowerCase(), same = node.parentElement ? [...node.parentElement.children].filter(c => c.tagName === node.tagName) : [];
      parts.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(node) + 1})` : t);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  const visible = el => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : getComputedStyle(el).visibility !== 'hidden'; };
  const disabled = el => el.matches(':disabled') || el.closest('[aria-disabled="true"], fieldset:disabled, [inert]') !== null;
  const text = el => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  function accName(el) {
    const by = el.getAttribute('aria-labelledby');
    const parts = [el.getAttribute('aria-label'), by ? by.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ') : '', el.labels ? [...el.labels].map(l => l.textContent).join(' ') : '',
      ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ? '' : text(el), el.getAttribute('title'), el.getAttribute('alt'), el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '',
      el.getAttribute('placeholder'), [...el.querySelectorAll('img[alt], svg[aria-label], [aria-label]')].map(n => n.getAttribute('alt') ?? n.getAttribute('aria-label')).join(' ')];
    return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
  const INTERACTIVE = 'button, a[href], [role=button], [role=link], input:not([type=hidden]), select, textarea, summary';
  const controls = [...document.querySelectorAll(INTERACTIVE)].filter(el => !isUi(el) && visible(el)).slice(0, 400);

  // Colour maths: normalise any CSS colour through a 1x1 canvas, composite ancestor backgrounds, WCAG relative luminance.
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const rgbaCache = new Map();
  const rgba = c => { if (rgbaCache.has(c)) return rgbaCache.get(c); ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; const v = [d[0], d[1], d[2], d[3] / 255]; rgbaCache.set(c, v); return v; };
  const over = (top, under) => { const a = top[3] + under[3] * (1 - top[3]); if (!a) return [255, 255, 255, 0]; return [0, 1, 2].map(i => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a); };
  const lum = c => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const pageBase = () => { const root = rgba(getComputedStyle(document.documentElement).backgroundColor); const body = document.body ? rgba(getComputedStyle(document.body).backgroundColor) : [0, 0, 0, 0]; return over(body, over(root, [255, 255, 255, 1])); };
  function background(el) {
    const layers = []; let opacity = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n); opacity *= Number(s.opacity);
      if (s.backgroundImage !== 'none') return null; // gradient or picture behind the text: not measurable here
      const c = rgba(s.backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break;
    }
    let bg = layers.length && layers[layers.length - 1][3] >= 1 ? [255, 255, 255, 1] : pageBase();
    for (const c of layers.reverse()) bg = over(c, bg);
    return { bg, opacity };
  }
  const contrastSeen = new Set();
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && out.filter(f => f.type === 'contrast').length < max; node = walker.nextNode()) {
    const el = node.parentElement; if (!el || contrastSeen.has(el) || !node.textContent.trim() || isUi(el) || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
    contrastSeen.add(el);
    if (!visible(el) || disabled(el)) continue;
    const s = getComputedStyle(el), b = background(el); if (!b) continue;
    const fg = rgba(s.color); if (fg[3] === 0) continue;
    const color = over([fg[0], fg[1], fg[2], fg[3] * b.opacity], b.bg);
    const L1 = lum(color), L2 = lum(b.bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700, large = size >= 24 || (bold && size >= 18.66), need = large ? 3 : 4.5;
    if (ratio + 0.005 < need) add('contrast', ratio < 3 ? 'high' : 'medium', el, `Low text contrast ${ratio.toFixed(2)}:1`, `"${text(el).slice(0, 60)}" is ${hex(color)} on ${hex(b.bg)} = ${ratio.toFixed(2)}:1, needs ${need}:1 (${size}px, weight ${s.fontWeight})`, { ratio: Number(ratio.toFixed(2)), need, fg: hex(color), bg: hex(b.bg), fontSize: size });
  }

  const result = { documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0), viewportWidth: vw, findings: out, links: [], candidates: [] };
  if (!structural) return result;

  // Horizontal overflow: the outermost elements that stick out sideways (not inside a scroll/clip container).
  if (result.documentWidth > vw + 1) {
    const offenders = [];
    for (const el of [...document.body.querySelectorAll('*')].slice(0, 6000)) {
      if (isUi(el) || offenders.some(o => o.contains(el))) continue;
      const r = el.getBoundingClientRect(); if (r.width < 1 || (r.right <= vw + 1 && r.left >= -1)) continue;
      let clipped = false; for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (getComputedStyle(p).overflowX !== 'visible') { clipped = true; break; } }
      if (!clipped && visible(el)) offenders.push(el);
    }
    if (!offenders.length) add('horizontal-overflow', phone ? 'high' : 'medium', null, `Page scrolls sideways at ${vw}px`, `document is ${result.documentWidth}px wide in a ${vw}px viewport`, { documentWidth: result.documentWidth, viewport: vw });
    for (const el of offenders.slice(0, 5)) { const r = el.getBoundingClientRect(); add('horizontal-overflow', phone ? 'high' : 'medium', el, `Element sticks out of the ${vw}px viewport`, `document is ${result.documentWidth}px wide in a ${vw}px viewport; this element spans x=${Math.round(r.left)}..${Math.round(r.right)}px`, { documentWidth: result.documentWidth, viewport: vw, left: Math.round(r.left), right: Math.round(r.right) }); }
  }
  // Clipped text: content larger than a box that hides overflow, with no deliberate ellipsis or line clamp.
  for (const el of [...document.body.querySelectorAll('*')].slice(0, 6000)) {
    if (isUi(el) || !text(el) || el.children.length > 3) continue;
    const s = getComputedStyle(el);
    const hx = s.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis' && s.overflowX !== 'auto' && s.overflowX !== 'scroll';
    const hy = s.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1 && s.webkitLineClamp === 'none' && s.overflowY !== 'auto' && s.overflowY !== 'scroll';
    if ((hx || hy) && visible(el)) add('clipped-text', 'low', el, 'Text is cut off by its box', `content ${el.scrollWidth}x${el.scrollHeight}px in a ${el.clientWidth}x${el.clientHeight}px box with overflow hidden: "${text(el).slice(0, 60)}"`, { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
  }
  // Controls placed outside the viewport sideways (off-canvas menus with fixed position or transforms are deliberate).
  for (const el of controls) {
    const r = el.getBoundingClientRect(); if (r.right > 0 && r.left < vw) continue;
    let deliberate = false; for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.position === 'fixed' || s.transform !== 'none' || p.getAttribute('aria-hidden') === 'true') { deliberate = true; break; } }
    if (!deliberate && !(el.matches('a[href^="#"]') && r.right <= 0)) add('offscreen', 'low', el, 'Control is outside the viewport', `"${accName(el).slice(0, 40)}" at x=${Math.round(r.left)}..${Math.round(r.right)}px in a ${vw}px viewport`, { left: Math.round(r.left), right: Math.round(r.right), viewport: vw });
  }
  // Images.
  const src = img => { const v = img.getAttribute('src') ?? ''; return v.startsWith('data:') ? v.slice(0, v.indexOf(',') + 1) + '…' : v.split('?')[0].slice(0, 120); };
  for (const img of document.querySelectorAll('img')) {
    if (isUi(img) || img.closest('[aria-hidden="true"]')) continue;
    if ((img.currentSrc || img.getAttribute('src')) && img.complete && img.naturalWidth === 0) add('broken-image', 'medium', img, 'Image does not load', `img src "${src(img)}" has naturalWidth 0 after load`);
    if (!img.hasAttribute('alt') && !['presentation', 'none'].includes(img.getAttribute('role') ?? '')) add('missing-alt', 'medium', img, 'Image has no alt attribute', `img src "${src(img)}" has no alt (use alt="" if decorative)`);
  }
  // Controls without an accessible name.
  for (const el of controls) if (!accName(el)) add('unnamed-control', ['BUTTON', 'A'].includes(el.tagName) || el.getAttribute('role') ? 'high' : 'medium', el, `${el.tagName.toLowerCase()} has no accessible name`, `${el.outerHTML.replace(/\s+/g, ' ').slice(0, 160)}`);
  // Tap targets at phone width (WCAG 2.5.8 minimum 24x24; inline links in a sentence are exempt).
  if (phone) for (const el of controls) {
    const r = el.getBoundingClientRect(); if (r.width >= 24 && r.height >= 24) continue;
    const parent = el.parentElement, inline = getComputedStyle(el).display === 'inline' && parent && text(parent).length > text(el).length + 1;
    if (!inline) add('small-tap-target', 'low', el, `Tap target ${Math.round(r.width)}x${Math.round(r.height)}px`, `"${accName(el).slice(0, 40)}" is ${Math.round(r.width)}x${Math.round(r.height)}px; minimum 24x24`, { width: Math.round(r.width), height: Math.round(r.height) });
  }
  // Overlapping controls: one actually covers the other at the centre of their intersection.
  const boxes = controls.slice(0, 250).map(el => ({ el, r: el.getBoundingClientRect() }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]; if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w <= 0 || h <= 0 || w * h < 0.25 * Math.min(a.r.width * a.r.height, b.r.width * b.r.height)) continue;
    const cx = Math.max(a.r.left, b.r.left) + w / 2, cy = Math.max(a.r.top, b.r.top) + h / 2;
    if (cy < 0 || cy > vh) continue;
    const top = document.elementFromPoint(cx, cy), covered = a.el.contains(top) ? b : b.el.contains(top) ? a : null;
    if (covered) add('overlap', 'medium', covered.el, 'Control is covered by another control', `"${accName(covered.el).slice(0, 40)}" is covered by ${sel(covered === a ? b.el : a.el)} over ${Math.round(w)}x${Math.round(h)}px`, { overlapWidth: Math.round(w), overlapHeight: Math.round(h) });
  }
  // Misaligned icons: icon-only items in one row whose vertical centres differ by more than 2px.
  const iconOf = el => { if (el.matches('svg, img') ) return el; if (text(el)) return null; const inner = el.querySelectorAll('svg, img'); return inner.length === 1 ? inner[0] : null; };
  const seenParents = new Set();
  for (const icon of document.querySelectorAll('svg, img')) {
    const r0 = icon.getBoundingClientRect(); if (r0.width > 64 || r0.height > 64 || r0.width < 4) continue;
    let item = icon; while (item.parentElement && item.parentElement.children.length === 1 && !text(item.parentElement)) item = item.parentElement;
    const parent = item.parentElement; if (!parent || seenParents.has(parent) || isUi(parent)) continue; seenParents.add(parent);
    const icons = [...parent.children].map(iconOf).filter(n => n && visible(n)).map(n => ({ n, r: n.getBoundingClientRect() }));
    if (icons.length < 2 || Math.max(...icons.map(i => i.r.top)) >= Math.min(...icons.map(i => i.r.bottom))) continue;
    const centers = icons.map(i => i.r.top + i.r.height / 2), sorted = [...centers].sort((x, y) => x - y), ref = icons.length === 2 ? centers[0] : sorted[Math.floor(sorted.length / 2)];
    icons.forEach((i, k) => { const d = centers[k] - ref; if (Math.abs(d) > 2) add('misaligned', 'low', i.n, 'Icon is not vertically aligned with its row', `vertical centre ${centers[k].toFixed(1)}px vs row ${ref.toFixed(1)}px (off by ${d.toFixed(1)}px) in ${sel(parent)}`, { offsetPx: Number(d.toFixed(1)) }); });
  }
  // Same-origin links for the link check, and click candidates (destructive ones are filtered in Node by isDestructive).
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (isUi(a)) continue; let u; try { u = new URL(a.href); } catch { continue; }
    if (u.origin !== location.origin || !/^https?:$/.test(u.protocol)) continue;
    u.hash = ''; if (u.href === location.href.split('#')[0] || seen.has(u.href)) continue; seen.add(u.href);
    result.links.push({ href: u.href, selector: sel(a), text: `${accName(a)} ${u.pathname}${u.search}` });
  }
  for (const el of controls) {
    if (!el.matches('button, a[href], [role=button], [role=link], input[type=submit], input[type=button], input[type=reset], summary') || disabled(el)) continue;
    const label = accName(el).slice(0, 80), href = el.getAttribute('href') ?? '';
    let external = false; if (el.matches('a[href]')) { try { const u = new URL(el.href); external = u.origin !== location.origin || !/^https?:$/.test(u.protocol) && u.protocol !== 'javascript:'; } catch { external = true; } }
    result.candidates.push({ selector: sel(el), label, tag: el.tagName.toLowerCase(), text: `${label} ${href} ${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`, external });
  }
  return result;
}

/** Every browser context the probe opens: no downloads, no service workers. */
export const CONTEXT = { deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false };

/** Runs in every frame before the page's own scripts (serialized by Playwright: no closures over module scope). */
function guardInit({ mark, prelude }) {
  const tell = (kind, url) => { try { window.__bfBlock(kind, new URL(String(url), document.baseURI).href); } catch { /* bad url */ } };
  window.__bfSubmits = 0;
  // A form with an action or method="post" would reach the server: record where it would have gone (never sent).
  window.addEventListener('submit', e => {
    window.__bfSubmits++; e.preventDefault();
    const f = e.target, method = String(f?.getAttribute?.('method') || 'get').toUpperCase();
    if (f?.hasAttribute?.('action') || method === 'POST') tell(`FORM ${method}`, f.getAttribute('action') || '');
  }, true);
  HTMLFormElement.prototype.submit = function () { window.__bfSubmits++; };
  // Beacons are POSTs the page cannot observe; never send them.
  if (navigator.sendBeacon) navigator.sendBeacon = function (url) { tell('BEACON', url); return true; };
  if (window.WebTransport) window.WebTransport = class WebTransport { constructor(url) { tell('WEBTRANSPORT', url); const fail = Promise.reject(new Error('Blocked by the Bugframe guard')); fail.catch(() => {}); this.ready = fail; this.closed = fail; } close() {} };
  // A SharedWorker's requests and sockets are invisible to the guard, so it never starts: the page gets an inert one.
  if (window.SharedWorker) window.SharedWorker = class SharedWorker extends EventTarget {
    constructor(url) { super(); tell('SHAREDWORKER', url); this.port = Object.assign(new EventTarget(), { postMessage() {}, start() {}, close() {}, onmessage: null, onmessageerror: null }); }
  };
  // A dedicated worker runs, but behind a stub that blocks its sockets (see WORKER_PRELUDE). A worker from a URL gets
  // a marker the guard answers with "stub, then the real script"; a blob or data worker is wrapped here the same way.
  const Native = window.Worker;
  if (Native) {
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { setTimeout(() => revoke(url), 60_000); }; // a wrapped blob worker reads its script a moment later
    const inert = () => Object.assign(new EventTarget(), { postMessage() {}, terminate() {}, onmessage: null, onerror: null, onmessageerror: null });
    window.Worker = new Proxy(Native, { construct(target, args, newTarget) {
      const [url, options] = args, module = options?.type === 'module';
      let u; try { u = new URL(String(url), document.baseURI); } catch { return Reflect.construct(target, args, newTarget); } // the browser reports the bad URL itself
      if (typeof url !== 'string' && !(url instanceof URL)) { tell('WORKER', u.href); return inert(); } // a TrustedScriptURL cannot be rewritten: not started
      if (u.protocol === 'http:' || u.protocol === 'https:') { u.search += `${u.search ? '&' : '?'}${mark}=${module ? 'module' : 'classic'}`; return Reflect.construct(target, [u.href, options], newTarget); }
      if (u.protocol === 'blob:' || u.protocol === 'data:') {
        const blob = text => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        return Reflect.construct(target, [blob(module ? `import ${JSON.stringify(blob(prelude))};import ${JSON.stringify(u.href)};` : `${prelude};importScripts(${JSON.stringify(u.href)});`), options], newTarget);
      }
      tell('WORKER', u.href); return inert();
    } });
  }
  // Every DOM change with its time, so a click's effect can be told apart from a page that changes on its own.
  const muts = window.__bfMuts = [];
  new MutationObserver(list => { const t = performance.now(); if (muts.length > 6000) muts.splice(0, 3000); for (const m of list) muts.push({ t, n: m.target }); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

/**
 * Block and record everything that could change something: non-GET requests, WebSockets (pages, iframes and workers),
 * beacons, SharedWorkers, navigations and redirects to other sites or to destructive-looking URLs (the audited page
 * itself excepted), and, once a click has been dispatched, API calls to destructive-looking URLs; cancel form
 * submissions; close popups. Navigations are fetched one hop at a time, so a redirect is checked before it is followed.
 */
export async function guard(context, origin, blocked, target) {
  if (typeof context.routeWebSocket !== 'function') throw new CliError('Page audit needs Playwright 1.48 or newer (it must block WebSockets). In your project run: npm i -D playwright@latest');
  await context.exposeBinding('__bfBlock', (_source, method, url) => { note(blocked, { method: String(method).slice(0, 20), url: pathOf(String(url), origin) }); });
  await context.addInitScript(guardInit, { mark: WORKER_MARK, prelude: WORKER_PRELUDE });
  await context.routeWebSocket(/.*/, ws => { note(blocked, { method: 'WEBSOCKET', url: pathOf(ws.url().replace(/^ws/, 'http'), origin) }); return ws.close(); });
  const handle = async route => {
    const req = route.request(), method = req.method(), url = new URL(req.url());
    // The guard's own address: reports from worker stubs, and the stub itself for module workers. Never the site's.
    if (url.pathname.startsWith(`${GUARD_PATH}/`)) {
      if (url.pathname === `${GUARD_PATH}/worker-prelude.js`) return route.fulfill({ status: 200, contentType: 'text/javascript', body: WORKER_PRELUDE });
      const kind = url.searchParams.get('kind');
      if (['WEBSOCKET', 'WEBTRANSPORT', 'WORKER'].includes(kind)) note(blocked, { method: kind, url: pathOf(String(url.searchParams.get('url') ?? '').replace(/^ws/, 'http'), origin).slice(0, 300) });
      return route.fulfill({ status: 204, body: '' });
    }
    if (method !== 'GET' && method !== 'HEAD') { note(blocked, { method, url: pathOf(req.url(), origin) }); return route.abort('blockedbyclient'); }
    const marked = new RegExp(`[?&]${WORKER_MARK}=(classic|module)$`).exec(url.search);
    if (marked) return guardedWorker(route, req.url().replace(new RegExp(`[?&]${WORKER_MARK}=(classic|module)(?=#|$)`), ''), marked[1], origin, blocked);
    let page = null, main = false; try { const frame = req.frame(); page = frame.page(); main = frame === page.mainFrame(); } catch { /* a request without a frame */ }
    if (req.isNavigationRequest()) {
      if (url.origin !== origin || (req.url() !== target && isDestructive(url.pathname + url.search))) { note(blocked, { method: 'NAVIGATE', url: pathOf(req.url(), origin) }); return route.abort('blockedbyclient'); }
      return guardedNavigation(route, req, { context, origin, blocked, target, page, main });
    }
    // After a click, a GET to /api/logout or /items/7/delete is as destructive as the button that would send it.
    if (page && armed.has(page) && !ASSET_TYPES.has(req.resourceType()) && isDestructive(url.pathname + url.search)) { note(blocked, { method: 'BLOCKED GET', url: pathOf(req.url(), origin) }); return route.abort('blockedbyclient'); }
    // Files to show load from anywhere. shortcut: an EventSource stream never ends, so it cannot be fetched whole here and
    // the browser follows its redirects; upgrade when Playwright can fulfil a route with a streamed body.
    if (ASSET_TYPES.has(req.resourceType()) || req.resourceType() === 'eventsource') return route.continue();
    // Any other request (fetch, XHR, while loading or after a click) is fetched here one hop at a time, because the
    // browser would follow a redirect without asking the route: each hop is checked before it is requested.
    const res = await fetchHops(route, req.url(), origin, blocked);
    return res ? route.fulfill({ response: res }) : route.abort('blockedbyclient');
  };
  // Fail closed: if the guard itself trips (a page closing mid-request, say), the request is aborted, never passed on.
  await context.route('**/*', route => handle(route).catch(() => route.abort('failed').catch(() => {})));
  context.on('page', async p => { if (await p.opener().catch(() => null)) p.close().catch(() => {}); });
}

/**
 * Fetch a request one redirect hop at a time (Playwright shows a route only its first URL). A hop to another site, to a
 * destructive-looking URL or past the fifth is recorded and refused (null), so nothing is requested there; otherwise
 * the final response. A request that starts on another site may stay on that site.
 */
async function fetchHops(route, url, origin, blocked) {
  const method = route.request().method(), sites = new Set([origin, new URL(url).origin]);
  let at = new URL(url), res = await route.fetch({ url, maxRedirects: 0, timeout: NAV_TIMEOUT });
  for (let hop = 0; ; hop++) {
    const status = res.status(), location = res.headers().location;
    if (status < 300 || status >= 400 || !location) return res;
    let next; try { next = new URL(location, at); } catch { return res; }
    const reason = !sites.has(next.origin) ? 'another site' : isDestructive(next.pathname + next.search) ? 'a destructive-looking URL' : hop >= 5 ? 'too many redirects' : null;
    await res.dispose();
    if (reason) { note(blocked, { method: `BLOCKED ${method}`, url: pathOf(next.href, origin), from: pathOf(at.href, origin), status, reason }); return null; }
    res = await route.fetch({ url: next.href, maxRedirects: 0, timeout: NAV_TIMEOUT }); at = next;
  }
}

/** Answer a marked worker script with "the socket stub first, then the real script" (same response headers). */
async function guardedWorker(route, original, kind, origin, blocked) {
  let res; try { res = await fetchHops(route, original, origin, blocked); } catch { return route.abort('failed'); }
  if (!res) return route.abort('blockedbyclient');
  if (!res.ok()) return route.fulfill({ response: res });
  const body = kind === 'module' ? `import ${JSON.stringify(`${origin}${GUARD_PATH}/worker-prelude.js`)};import ${JSON.stringify(original)};` : `${WORKER_PRELUDE};importScripts(${JSON.stringify(original)});`;
  return route.fulfill({ response: res, body, contentType: 'text/javascript' });
}

/**
 * Fetch one navigation without following redirects. A redirect to another site, to a destructive-looking URL or one
 * hop too many is recorded and aborted. A safe one is handed back to load() when load() started the navigation (it
 * opens the next hop itself, so the page's address is right); otherwise the guard walks the chain here, hop by hop,
 * answers with the final page and remembers where it ended.
 */
async function guardedNavigation(route, req, { context, origin, blocked, target, page, main }) {
  let driven = main ? loading.get(page) : null;
  if (driven?.seen) driven = null; else if (driven) driven.seen = true;
  let res, at = new URL(req.url());
  try {
    res = await route.fetch({ maxRedirects: 0, timeout: NAV_TIMEOUT });
    for (let hop = 0; ; hop++) {
      const status = res.status(), location = res.headers().location;
      if (status < 300 || status >= 400 || !location) break;
      let next; try { next = new URL(location, at); } catch { break; }
      // load() opens each hop as its own navigation, so it keeps the count of hops across them.
      const offsite = next.origin !== origin, reason = offsite ? 'another site' : next.href.split('#')[0] !== target && isDestructive(next.pathname + next.search) ? 'a destructive-looking URL' : (driven ? driven.hops : hop) >= 5 ? 'too many redirects' : null;
      if (reason) {
        const entry = { method: 'REDIRECT', url: pathOf(req.url(), origin), to: pathOf(next.href, origin), status, reason };
        note(blocked, entry); if (driven) driven.blocked = entry;
        await res.dispose(); return route.abort('blockedbyclient');
      }
      await res.dispose();
      if (driven) { driven.hops++; driven.next = next.href; return route.abort('aborted'); }
      res = await context.request.get(next.href, { maxRedirects: 0, timeout: NAV_TIMEOUT, failOnStatusCode: false });
      at = next; if (main) redirected.set(page, next.href);
    }
  } catch { return route.abort('failed'); }
  return route.fulfill({ response: res });
}

/**
 * GET one same-origin link through the same rules as the browser guard: never a destructive URL, never another site,
 * redirects followed here hop by hop (at most 5) so each hop is checked. Returns { status } or { status: null, skipped|error }.
 */
export async function checkLink(request, href, origin, hops = 5) {
  let url = new URL(href);
  for (let i = 0; i <= hops; i++) {
    if (url.origin !== origin) return { status: null, skipped: 'redirect to another site' };
    if (isDestructive(url.pathname + url.search)) return { status: null, skipped: 'destructive' };
    const r = await request.get(url.href, { maxRedirects: 0, timeout: 10_000, failOnStatusCode: false });
    const status = r.status(), location = r.headers().location; await r.dispose();
    if (status < 300 || status >= 400 || !location) return { status };
    url = new URL(location, url);
  }
  return { status: null, error: 'too many redirects' };
}

export function watch(page, origin) {
  // `events` holds the same things with their time and a key, so a click can subtract what the page does on its own.
  const log = { console: [], pageErrors: [], failed: [], requests: 0, dialogs: 0, calls: [], events: [] };
  const at = (kind, key, extra) => log.events.push({ t: Date.now(), kind, key, ...extra });
  // Chrome's "Failed to load resource" line duplicates the failed request (recorded with its URL); blocked ones are ours.
  page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(m.text())) { const text = scrub(m.text()); log.console.push(text); at('console', text); } });
  page.on('pageerror', e => { const text = scrub(e?.message ?? e); log.pageErrors.push(text); at('pageerror', text); });
  page.on('request', r => {
    if (new URL(r.url()).pathname.startsWith(`${GUARD_PATH}/`)) return; // the guard talking to itself
    const key = `${r.method()} ${pathOf(r.url(), origin)}`, call = ['fetch', 'xhr', 'eventsource'].includes(r.resourceType()) && ['GET', 'HEAD'].includes(r.method());
    log.requests++; if (call) log.calls.push(key); at('request', key, { call });
  });
  page.on('requestfailed', r => { const t = r.failure()?.errorText ?? ''; if (!/BLOCKED_BY_CLIENT|aborted/i.test(t)) { const f = { method: r.method(), url: pathOf(r.url(), origin), status: null, error: t.slice(0, 80) }; log.failed.push(f); at('failed', `${f.method} ${f.url}`, { item: f }); } });
  page.on('response', r => { if (r.status() >= 400) { const f = { method: r.request().method(), url: pathOf(r.url(), origin), status: r.status() }; log.failed.push(f); at('failed', `${f.method} ${f.url}`, { item: f }); } });
  page.on('dialog', d => { log.dialogs++; d.dismiss().catch(() => {}); });
  return log;
}

/**
 * Open `url` and wait for it to settle. Under the guard a redirect comes back one hop at a time: a safe one is opened
 * as the next navigation; one that leaves the site, looks destructive or is the sixth in a row throws with
 * `blockedRedirect` set.
 */
export async function load(page, url, timeout = NAV_TIMEOUT) {
  let response, next = url;
  const state = { hops: 0 };
  for (;;) {
    Object.assign(state, { seen: false, next: null }); loading.set(page, state);
    try { response = await page.goto(next, { waitUntil: 'load', timeout }); break; }
    catch (e) {
      const b = state.blocked;
      if (b) throw Object.assign(new Error(b.reason === 'too many redirects' ? `redirects more than 5 times (${b.to}); not followed` : `redirects to ${b.reason} (${b.to}); not followed`), { blockedRedirect: b });
      if (!state.next) throw e;
      next = state.next;
    } finally { loading.delete(page); }
  }
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(250);
  return response;
}

/**
 * Measure `url` at every viewport in light and dark mode, check same-origin links, and click-probe the controls.
 * Writes probe.json, screens/ and clicks/ into `outDir` (the blind workspace's _bugframe_audit) and returns the probe.
 */
export async function probePage({ url, viewports = parseViewports(), click = true, outDir, evidencePrefix = '_bugframe_audit', project, playwright, signal, settleMs = DEFAULT_SETTLE_MS, log = () => {} }) {
  let target; try { target = new URL(url); } catch { throw new CliError('Give the page URL to audit, e.g. http://localhost:3000/settings'); }
  if (!/^https?:$/.test(target.protocol)) throw new CliError('Only http and https pages can be audited.');
  const pw = playwright ?? await loadPlaywright(project), origin = target.origin;
  await mkdir(join(outDir, 'screens'), { recursive: true }); await mkdir(join(outDir, 'clicks'), { recursive: true });
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); } catch (e) { throw new CliError(`Could not start Chromium (${String(e?.message ?? e).split('\n')[0]}). Run: npx playwright install chromium`); }
  const probe = { tool: 'bugframe page audit', url: redactUrl(url), startedAt: new Date().toISOString(), viewports: [], findings: [], links: [], clicks: [], blockedRequests: [], notes: [] };
  const raw = [], blocked = [], logs = [], candidatesBy = new Map();
  const stopped = () => signal?.throwIfAborted();
  const marked = candidates => candidates.map(({ text: t, ...c }) => ({ ...c, destructive: isDestructive(t) }));
  try {
    for (const vp of viewports) for (const scheme of ['light', 'dark']) {
      const name = `${vp.name}-${scheme}`, phone = vp.width < 600;
      stopped(); log(`probe ${name}`);
      const context = await browser.newContext({ ...CONTEXT, viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, isMobile: phone, hasTouch: phone });
      try {
        await guard(context, origin, blocked, target.href.split('#')[0]);
        const page = await context.newPage(), pageLog = watch(page, origin); logs.push({ name: `${vp.name} ${scheme}`, log: pageLog });
        await load(page, url);
        const shot = `screens/${name}.png`;
        await page.screenshot({ path: join(outDir, shot), fullPage: true, timeout: 20_000 }).catch(() => page.screenshot({ path: join(outDir, shot) }));
        const res = await page.evaluate(pageChecks, { phone, structural: scheme === 'light', max: 15 });
        probe.viewports.push({ name, width: vp.width, height: vp.height, scheme, screenshot: `${evidencePrefix}/${shot}`, documentWidth: res.documentWidth });
        for (const f of res.findings) raw.push({ ...f, viewport: `${vp.name} ${scheme}`, screenshot: `${evidencePrefix}/${shot}` });
        if (scheme === 'light' && !probe.links.length && res.links.length) {
          const safe = res.links.filter(l => !isDestructive(l.text)), skipped = res.links.length - safe.length;
          probe.links = safe.slice(0, MAX_LINKS).map(({ text: _t, ...l }) => l);
          if (skipped) probe.notes.push(`${skipped} link(s) were not checked because their text or URL looks destructive.`);
        }
        if (scheme === 'light') candidatesBy.set(vp.name, marked(res.candidates));
      } catch (e) { if (signal?.aborted) throw e; probe.notes.push(`${name}: the page could not be measured (${cleanError(e)}).`); }
      finally { await context.close(); }
    }
    if (!probe.viewports.length) throw new CliError(`The page did not load at any viewport: ${probe.notes[0] ?? url}`);

    // Link check and click probe share one context at the viewport closest to a laptop (1280 wide).
    const vp = [...viewports].sort((a, b) => Math.abs(a.width - 1280) - Math.abs(b.width - 1280))[0];
    const context = await browser.newContext({ ...CONTEXT, viewport: { width: vp.width, height: vp.height } });
    try {
      await guard(context, origin, blocked, target.href.split('#')[0]);
      for (const link of probe.links) {
        stopped();
        try { Object.assign(link, await checkLink(context.request, link.href, origin)); } catch (e) { link.status = null; link.error = cleanError(e); }
        link.url = pathOf(link.href, origin); delete link.href;
        if (link.skipped) { blocked.push({ method: 'GET', url: link.url }); continue; }
        if (link.status === null || link.status >= 400) raw.push({ type: 'broken-link', severity: 'medium', selector: link.selector, title: `Link to ${link.url} is broken`, evidence: `GET ${link.url} → ${link.status ?? link.error}`, measured: { status: link.status }, viewport: `${vp.name} light` });
      }
      if (click) {
        const candidates = candidatesBy.get(vp.name) ?? (await (async () => { const p = await context.newPage(); try { await load(p, url); return marked((await p.evaluate(pageChecks, { phone: false, structural: true, max: 15 })).candidates); } finally { await p.close(); } })());
        let n = 0;
        for (const c of candidates) {
          stopped();
          if (c.destructive) { probe.clicks.push({ selector: c.selector, label: c.label, outcome: 'skipped: destructive' }); continue; }
          if (c.external) { probe.clicks.push({ selector: c.selector, label: c.label, outcome: 'skipped: external link' }); continue; }
          if (n >= MAX_CLICKS) { probe.clicks.push({ selector: c.selector, label: c.label, outcome: 'skipped: click limit' }); continue; }
          n++;
          probe.clicks.push(await clickOne({ context, url, c, n, outDir, evidencePrefix, origin, blocked, vp, raw, settleMs }));
        }
      }
    } finally { await context.close(); }
  } finally { await browser.close(); }

  // Errors and failed requests: one finding per distinct message, listing every viewport that saw it.
  const merge = (type, severity, key, title, evidence, items) => {
    const m = new Map();
    for (const { name, item } of items) { const k = key(item); if (!m.has(k)) m.set(k, { item, where: [] }); m.get(k).where.push(name); }
    for (const { item, where } of [...m.values()].slice(0, 10)) raw.push({ type, severity: typeof severity === 'function' ? severity(item) : severity, selector: '', title: title(item), evidence: evidence(item), viewport: where.join(', ') });
  };
  const all = kind => logs.flatMap(({ name, log }) => log[kind].map(item => ({ name, item })));
  merge('page-error', 'high', m => m, m => `Uncaught error: ${m.split('\n')[0].slice(0, 80)}`, m => m, all('pageErrors'));
  merge('console-error', 'medium', m => m, m => `Console error: ${m.split('\n')[0].slice(0, 80)}`, m => m, all('console'));
  merge('failed-request', r => (r.status === null || r.status >= 500 ? 'high' : 'medium'), r => `${r.method} ${r.url} ${r.status}`, r => `${r.method} ${r.url} fails${r.status ? ` with ${r.status}` : ''}`, r => `${r.method} ${r.url} → ${r.status ?? r.error}`, all('failed'));

  const seenBlocked = new Set();
  for (const b of blocked) { const k = blockKey(b); if (!seenBlocked.has(k) && seenBlocked.size < 50) { seenBlocked.add(k); probe.blockedRequests.push(b); } }
  const unclear = probe.clicks.filter(c => c.outcome?.startsWith('unclear')).length;
  if (unclear) probe.notes.push(`${unclear} control(s) could not be judged: the page keeps changing on its own (polling, timers), so a click with no effect of its own cannot be told apart from a dead one.`);
  if (probe.blockedRequests.length) probe.notes.push(`The audit blocks every non-GET request: ${probe.blockedRequests.length} distinct request(s) were not sent (see blockedRequests). Content that depends on them may look empty or show an error state.`);
  const AREA = { 'horizontal-overflow': 'responsive', offscreen: 'responsive', 'clipped-text': 'visual', overlap: 'visual', misaligned: 'visual', contrast: 'accessibility', 'missing-alt': 'accessibility', 'unnamed-control': 'accessibility', 'small-tap-target': 'accessibility', 'broken-image': 'content' };
  // The same element failing the same check at several widths is one finding with every viewport listed.
  const unique = new Map();
  for (const f of raw) { const k = `${f.type}\u0000${f.selector}\u0000${f.title}`; const have = unique.get(k); if (!have) unique.set(k, { ...f }); else if (!have.viewport.split(', ').includes(f.viewport)) have.viewport += `, ${f.viewport}`; }
  probe.findings = [...unique.values()].map((f, i) => ({ id: `P${i + 1}`, area: AREA[f.type] ?? 'behaviour', ...f }));
  probe.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, 'probe.json'), JSON.stringify(probe, null, 2));
  return probe;
}

/** Visible dialogs, menus and popovers; the target's aria-expanded; where focus is. Runs in the page. */
function OVERLAY_STATE(selector) {
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const overlays = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true], [role=menu], [role=listbox], [popover]')].filter(shown).length;
  let target = null; try { target = document.querySelector(selector); } catch { /* bad selector */ }
  const a = document.activeElement, focus = a && a !== document.body ? `${a.tagName}#${a.id}.${a.className}:${(a.textContent ?? '').slice(0, 30)}` : '';
  return { overlays, expanded: target?.getAttribute('aria-expanded') ?? null, focus, focusOnTarget: Boolean(target && a && (a === target || target.contains(a))) };
}

/** Runs in the page right before the click: everything that changed in the last `ms` is the page's own doing. */
function MARK_BASELINE(ms) {
  const now = performance.now(), noisy = new Set();
  for (const m of window.__bfMuts ?? []) if (m.t >= now - ms) noisy.add(m.n);
  window.__bfClick = { at: now, noisy };
  return noisy.size;
}
/** Runs in the page after the click settled: changes outside the nodes that were already changing are the click's. */
function COUNT_CHANGES() {
  const c = window.__bfClick; if (!c) return null;
  const whole = n => n === document || n === document.documentElement || n === document.body;
  const ambient = n => { for (const x of c.noisy) if (x === n || (x.nodeType === 1 && !whole(x) && x.contains(n))) return true; return false; };
  let own = 0, background = 0;
  for (const m of window.__bfMuts ?? []) if (m.t > c.at) { if (ambient(m.n)) background++; else own++; }
  return { own, background };
}
/** Where an in-page link landed: true when the fragment names something on the page (or is #top). */
function ANCHOR_EXISTS(hash) {
  let id = hash.slice(1); try { id = decodeURIComponent(id); } catch { /* keep it encoded */ }
  return id.toLowerCase() === 'top' || Boolean(document.getElementById(id) || document.getElementsByName(id)[0]);
}
/** A URL without its fragment, unless the fragment is a client-side route. */
const withoutAnchor = href => { try { const u = new URL(href); if (!HASH_ROUTE.test(u.hash)) u.hash = ''; return u.href; } catch { return href; } };

/**
 * Click one control in a fresh copy of the page and record what the click itself caused. Also used by `bugframe crawl`.
 * The page is watched for one settle window before the click: requests, console lines and DOM changes it produces on
 * its own (polling, clocks, tickers) are subtracted afterwards. A click with no effect of its own on such a page is
 * "unclear", never "dead" and never "calls-backend".
 */
export async function clickOne({ context, url, c, n, outDir, evidencePrefix, origin, blocked, vp, raw, timeout, settleMs = DEFAULT_SETTLE_MS }) {
  const page = await context.newPage(), pageLog = watch(page, origin), popups = [];
  const onPage = p => { if (p !== page) { popups.push(pathOf(p.url(), origin)); p.close().catch(() => {}); } };
  context.on('page', onPage);
  const record = { selector: c.selector, label: c.label };
  try {
    await load(page, url, timeout);
    const el = page.locator(c.selector).first();
    if (!(await el.count()) || !(await el.isVisible())) return { ...record, outcome: 'not found in a fresh page' };
    // Baseline. A page that has been quiet for a whole window needs no extra wait; a busy one is watched for one.
    // A page still finishing its load gets up to three windows to go quiet, so one late request does not count as noise.
    for (let tries = 0; tries < 3; tries++) {
      const sinceChange = await page.evaluate(() => { const a = window.__bfMuts ?? []; return a.length ? performance.now() - a[a.length - 1].t : 1e9; }).catch(() => 1e9);
      const lastEvent = pageLog.events.length ? pageLog.events[pageLog.events.length - 1].t : 0, lastBlock = blocked.length ? blocked[blocked.length - 1].t ?? 0 : 0;
      if (Math.min(sinceChange, Date.now() - lastEvent, Date.now() - lastBlock) >= settleMs) break;
      await page.waitForTimeout(settleMs);
    }
    const was = await page.evaluate(OVERLAY_STATE, c.selector).catch(() => null);
    const t0 = Date.now();
    const base = { keys: new Set(pageLog.events.filter(e => e.t >= t0 - settleMs).map(e => `${e.kind} ${e.key}`)), blocks: new Set(blocked.filter(b => (b.t ?? 0) >= t0 - settleMs).map(blockKey)) };
    const noisyNodes = await page.evaluate(MARK_BASELINE, settleMs).catch(() => 0);
    const before = { url: page.url(), blocked: blocked.length, dialogs: pageLog.dialogs };
    armed.add(page);
    let clickError = '';
    try { await el.click({ timeout: 3000 }); } catch (e) { clickError = `the control could not be clicked (${cleanError(e)})`; }
    await page.waitForTimeout(settleMs);
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
    const changes = await page.evaluate(COUNT_CHANGES).catch(() => null);
    const submits = await page.evaluate(() => window.__bfSubmits ?? 0).catch(() => 0);
    // Where the click led: the end of a redirect chain the guard walked, else the page's address. A fragment that is
    // not a client-side route is not a navigation: href="#" goes nowhere, href="#notes" scrolls when #notes exists.
    // A navigation the guard aborted leaves Chrome on its error page: that is not somewhere the click led.
    const landed = redirected.get(page) ?? page.url(), moved = !/^chrome-error:/.test(landed) && withoutAnchor(landed) !== withoutAnchor(before.url), hash = moved ? '' : new URL(page.url()).hash;
    const anchor = !moved && page.url() !== before.url && hash.length > 1 ? await page.evaluate(ANCHOR_EXISTS, hash).catch(() => false) : false;
    const after = moved ? null : await page.evaluate(OVERLAY_STATE, c.selector).catch(() => null);
    const mine = pageLog.events.filter(e => e.t >= t0 && !base.keys.has(`${e.kind} ${e.key}`)), of = kind => mine.filter(e => e.kind === kind);
    const blockedNow = blocked.slice(before.blocked).filter(b => !base.blocks.has(blockKey(b)));
    // A request the guard blocked fails in the page: "Failed to fetch" that follows is the guard's doing, not a bug.
    const guardNoise = blockedNow.length ? /failed to fetch|networkerror|network error|load failed|blocked_by_client/i : null, real = e => !guardNoise?.test(e.key);
    const background = base.keys.size > 0 || base.blocks.size > 0 || noisyNodes > 0 || (changes?.background ?? 0) > 0;
    const effects = { domChanged: changes === null ? null : changes.own > 0, navigated: moved ? pathOf(landed, origin) : false, anchor: anchor ? hash : false, dialog: pageLog.dialogs > before.dialogs,
      requestsAttempted: of('request').length, formSubmitIntercepted: submits > 0, popup: popups[0] ?? false,
      blockedRequests: blockedNow.map(b => `would have sent ${b.method} ${b.url}${b.method === 'REDIRECT' ? ` → ${b.to} (${b.reason})` : b.from ? ` (redirect from ${b.from}: ${b.reason})` : ''}`),
      consoleErrors: of('console').filter(real).map(e => e.key), pageErrors: of('pageerror').filter(real).map(e => e.key),
      // A dialog, menu or popover appeared, or the control reports itself expanded; focus moved somewhere else.
      opened: Boolean(after && was && (after.overlays > was.overlays || (after.expanded === 'true' && was.expanded !== 'true'))),
      focusMoved: Boolean(after && was && after.focus && after.focus !== was.focus && !after.focusOnTarget),
      navigatedUrl: moved ? redactUrl(landed) : false, calls: of('request').filter(e => e.call).map(e => e.key), background };
    effects.failedRequests = of('failed').filter(e => e.item.url !== effects.navigated).map(e => `${e.item.method} ${e.item.url} → ${e.item.status ?? e.item.error}`);
    const errored = effects.consoleErrors.length > 0 || effects.pageErrors.length > 0 || effects.failedRequests.length > 0;
    const nothing = !clickError && !effects.domChanged && !effects.navigated && !effects.anchor && !effects.dialog && !effects.opened && !effects.focusMoved && !effects.requestsAttempted && !effects.blockedRequests.length && !effects.formSubmitIntercepted && !effects.popup && !errored && changes !== null;
    const dead = nothing && !background;
    const outcome = clickError ? 'could not click' : dead ? 'appears dead' : nothing ? 'unclear: the page keeps changing on its own' : errored ? 'error after click' : 'responded';
    let screenshot;
    if (dead || errored || clickError) { await mkdir(join(outDir, 'clicks'), { recursive: true }); screenshot = `${evidencePrefix}/clicks/c${n}.png`; await page.screenshot({ path: join(outDir, 'clicks', `c${n}.png`) }).catch(() => { screenshot = undefined; }); }
    const where = `${vp.name} light`;
    if (dead) raw.push({ type: 'dead-control', severity: 'high', selector: c.selector, title: `"${c.label || c.tag}" does nothing when clicked`, evidence: `click caused no DOM change, navigation, dialog, request, popup or console output within ${settleMs} ms`, viewport: where, screenshot });
    if (errored) raw.push({ type: 'click-error', severity: 'high', selector: c.selector, title: `Clicking "${c.label || c.tag}" raises an error`, evidence: [...effects.pageErrors, ...effects.consoleErrors, ...effects.failedRequests][0], viewport: where, screenshot });
    if (clickError) raw.push({ type: 'dead-control', severity: 'medium', selector: c.selector, title: `"${c.label || c.tag}" cannot be clicked`, evidence: clickError, viewport: where, screenshot });
    return { ...record, outcome, effects, ...(screenshot ? { screenshot } : {}) };
  } catch (e) { return { ...record, outcome: 'probe error', error: cleanError(e) }; }
  finally { context.off('page', onPage); await page.close().catch(() => {}); }
}
