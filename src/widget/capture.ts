/* Renders the visible viewport to a PNG in the browser (html-to-image, MIT) and crops it to the chosen rectangle.
   Inputs and anything marked for masking are painted over *in the picture*, so nothing flashes on the page. */
import type { Rect } from './types';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** html-to-image clones the DOM, which loses the scroll position of inner scrollers: shift their children by hand while it runs. */
function freezeScrolled(): () => void {
  const undo: (() => void)[] = [];
  document.querySelectorAll<HTMLElement>('*').forEach(el => {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight && el !== document.documentElement && el !== document.body) {
      const shift = el.scrollTop;
      Array.from(el.children).forEach(child => { const c = child as HTMLElement, before = c.style.translate; c.style.translate = `0 ${-shift}px`; undo.push(() => { c.style.translate = before; }); });
    }
  });
  return () => undo.forEach(fn => fn());
}

/**
 * html-to-image copies each element's computed style onto its clone. When the computed style has a `cssText` it writes it in
 * one assignment; Chrome and Safari give an empty one, so it falls back to ~575 `setProperty` calls per element. On Safari each
 * call is rechecked against the page's selectors that read inline styles (`:has(> .dot[style*="--red"])`), so a real app page
 * took ~8.5 s per pass, twice, with the page locked (2026-11-18). While the capture runs, computed styles carry a `cssText`
 * built from the same properties and the same value rules html-to-image applies on its fallback path.
 */
let patching = 0; // nested or overlapping captures share one patch: only the outermost restores the browser's function
let browserGetComputedStyle: typeof window.getComputedStyle | null = null;
export function withComputedCssText(): () => void {
  // whichever capture finishes last puts the browser's function back
  const release = () => { if (--patching === 0 && browserGetComputedStyle) { window.getComputedStyle = browserGetComputedStyle; browserGetComputedStyle = null; } };
  if (patching++) return release;
  const real = browserGetComputedStyle = window.getComputedStyle;
  const names = Array.from(real.call(window, document.documentElement));
  const textOf = (el: Element, cs: CSSStyleDeclaration) => {
    let out = '';
    for (const name of names) {
      let value = cs.getPropertyValue(name);
      if (name === 'font-size' && value.endsWith('px')) value = `${Math.floor(parseFloat(value)) - 0.1}px`; // html-to-image: avoids text re-wrapping
      if (el instanceof HTMLIFrameElement && name === 'display' && value === 'inline') value = 'block';
      if (name === 'd' && el.getAttribute('d')) value = `path(${el.getAttribute('d')})`;
      if (value) out += `${name}: ${value}${cs.getPropertyPriority(name) ? ' !important' : ''}; `;
    }
    return out;
  };
  const patched = function (this: unknown, el: Element, pseudo?: string | null) {
    const cs = real.call(window, el, pseudo);
    // ::before/::after cost no style writes, and html-to-image quotes their `content` differently when a cssText exists
    // (an image `content: url(...)` would turn into text): they keep the browser's own path.
    if (pseudo || cs.cssText) return cs;
    let text: string | null = null; // built only when html-to-image asks for it
    return new Proxy(cs, { get(target, key) {
      if (key === 'cssText') return text ??= textOf(el, target);
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    } });
  };
  window.getComputedStyle = patched as typeof window.getComputedStyle;
  return release;
}

export type CaptureOptions = { maxPixelRatio?: number; exclude?: string[] };

export async function captureViewport(opts: CaptureOptions = {}): Promise<string> {
  const { toPng } = await import('html-to-image');
  const w = window.innerWidth, h = window.innerHeight, pixelRatio = Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? 2);
  const exclude = (opts.exclude ?? []).filter(Boolean).join(',');
  const options = {
    width: w, height: h, pixelRatio, cacheBust: false, backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`, transformOrigin: 'top left', width: `${document.documentElement.scrollWidth}px`, height: `${document.documentElement.scrollHeight}px` },
    filter: (node: Node) => {
      if (!(node instanceof Element)) return true;
      if (node.hasAttribute('data-bug-ui')) return false;
      if (exclude) { try { if (node.matches(exclude)) return false; } catch { /* a bad selector is ignored */ } }
      return true;
    },
  };
  let restoreScroll = () => {}, restoreStyles = () => {};
  const restore = () => { restoreStyles(); restoreScroll(); };
  try {
    restoreScroll = freezeScrolled(); restoreStyles = withComputedCssText();
    // Safari draws images late on the first render; a short first pass warms its cache, the second one is kept.
    try { await toPng(document.body, options); } catch { /* the second pass reports the real error */ }
    await sleep(60);
    return await toPng(document.body, options);
  } finally { restore(); }
}

/** Viewport rectangles to paint over: inputs, password fields, [data-bug-mask] and the host's own selectors. */
export function maskRects(opts: { maskInputs: boolean; selectors: string[] }): Rect[] {
  const selectors = ['[data-bug-mask]', 'input[type="password"]', ...opts.selectors];
  if (opts.maskInputs) selectors.push('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"])', 'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]');
  const rects: Rect[] = [], seen = new Set<Element>();
  for (const sel of selectors.filter(Boolean)) {
    let list: Element[] = [];
    try { list = Array.from(document.querySelectorAll(sel)); } catch { continue; }
    for (const el of list) {
      if (seen.has(el) || el.closest('[data-bug-ui]')) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      rects.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    }
  }
  return rects;
}
export const selectorList = (selectors: string[]) => ['[data-bug-mask]', 'input[type="password"]', ...selectors].join(',');

const load = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('The screenshot could not be read.')); img.src = src; });

/** Paint opaque boxes over viewport rectangles (any capture scale). */
export async function maskImage(full: string, rects: Rect[], viewport: { w: number; h: number }): Promise<string> {
  if (!rects.length) return full;
  const img = await load(full), sx = img.naturalWidth / viewport.w, sy = img.naturalHeight / viewport.h;
  const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('This browser cannot mask the screenshot.');
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = '#3a3f4b';
  for (const r of rects) ctx.fillRect(Math.floor(r.x * sx), Math.floor(r.y * sy), Math.ceil(r.w * sx), Math.ceil(r.h * sy));
  return canvas.toDataURL('image/png');
}

/** Crop a full-viewport PNG to a viewport-pixel rectangle (works for any scale the capture used). */
export async function cropImage(full: string, rect: Rect, viewport: { w: number; h: number }): Promise<string> {
  const img = await load(full), sx = img.naturalWidth / viewport.w, sy = img.naturalHeight / viewport.h;
  const x = Math.max(0, Math.round(rect.x * sx)), y = Math.max(0, Math.round(rect.y * sy));
  const w = Math.max(1, Math.min(img.naturalWidth - x, Math.round(rect.w * sx))), h = Math.max(1, Math.min(img.naturalHeight - y, Math.round(rect.h * sy)));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('This browser cannot crop the screenshot.');
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}
