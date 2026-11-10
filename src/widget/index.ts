import { ApiError, fetchThumb, listReports, reviewReport, sendReport, type ApiConfig } from './api';
import { captureViewport, cropImage, maskImage, maskRects, selectorList } from './capture';
import { buildContext, installConsoleCapture } from './context';
import { resolveEnabled, setStored } from './enabled';
import { resolveLocale, resolveStrings } from './i18n';
import { CSS_TEXT } from './styles';
import { dataUrlToBytes, makeZip } from './zip';
import type { BugframeInstance, FeedbackKind, InitOptions, Rect, ReportStatus, ReportSummary, Strings } from './types';

export type { BugframeInstance, FeedbackKind, InitOptions, Rect, ReportStatus, ReportSummary, Strings, EnableMode, Position, ReportContext } from './types';
export { resolveStrings, LOCALES } from './i18n';

type Phase = 'idle' | 'capturing' | 'select' | 'sheet' | 'sending' | 'sent';
const MIN_SIDE = 24;
const ICON_BUG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M8 12h8M12 8v8"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_SPIN = '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>';
const FOCUSABLE = 'button:not([disabled]), textarea, input, summary, select, [href], [tabindex]:not([tabindex="-1"])';

type Attrs = Record<string, string | boolean | number | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v === undefined || v === false) continue; if (k === 'class') node.className = String(v); else node.setAttribute(k, v === true ? '' : String(v)); }
  for (const kid of kids) if (kid) node.append(kid);
  return node;
}
const icon = (svg: string) => { const s = document.createElement('span'); s.style.display = 'contents'; s.innerHTML = svg; return s; };
const norm = (a: { x: number; y: number }, b: { x: number; y: number }): Rect => ({ x: Math.round(Math.min(a.x, b.x)), y: Math.round(Math.min(a.y, b.y)), w: Math.round(Math.abs(a.x - b.x)), h: Math.round(Math.abs(a.y - b.y)) });
const pad = (n: number) => String(n).padStart(2, '0');
function newId(now = new Date()): string {
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(2)), b => b.toString(16).padStart(2, '0')).join('');
  return `bug-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${rnd}`;
}
function reporterId(opt: InitOptions['reporterId']): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  if (typeof opt === 'string' && opt) return clean(opt);
  if (typeof opt === 'function') { try { const v = clean(opt()); if (v) return v; } catch { /* fall through to the stored id */ } }
  const key = 'bugframe:reporter';
  try { const have = localStorage.getItem(key); if (have) return have; const id = 'r' + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem(key, id); return id; }
  catch { return 'anon'; }
}

class Bugframe implements BugframeInstance {
  private o: InitOptions;
  private t: Strings;
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private wrap: HTMLElement | null = null;
  private phase: Phase = 'idle';
  private menu = false;
  private reports: ReportSummary[] | null = null;
  private thumbs = new Map<string, string>();
  private rect: Rect | null = null;
  private hint = '';
  private error = '';
  private accessDenied = false;
  private capturedViewport: { w: number; h: number; dpr: number } | null = null;
  private capturedScroll: { x: number; y: number } | null = null;
  private full = '';
  private region = '';
  private text = '';
  private chosen: string[] = [];
  private kind: FeedbackKind = 'bug';
  private currentText = '';
  private suggestedText = '';
  private reviewMessage = '';
  private reviewing = false;
  private dataGeneration = 0;
  private listRequest = 0;
  private extrasOpen = false;
  private modalOverflow: string | null = null;
  private startPt: { x: number; y: number } | null = null;
  private opener: Element | null = null;
  private cleanups: (() => void)[] = [];
  private avoidTimer: number | null = null;
  private api: ApiConfig | null = null;
  private serverMode: boolean;
  private uninstallConsole: (() => void) | null = null;
  private maskSelectors: string[];
  private rid: string;

  constructor(options: InitOptions) {
    if (options.mode !== 'download' && (options.mode === 'server' || options.allowDownloadFallback === false) && !options.endpoint?.trim()) {
      throw new Error('Bugframe server reporting requires an endpoint. Use mode: "download" explicitly for local ZIP files.');
    }
    if (options.loginUrl) { const login = new URL(options.loginUrl, location.origin); if (!options.loginUrl.startsWith('/') || login.origin !== location.origin) throw new Error('Bugframe loginUrl must be a same-origin path.'); }
    this.o = options;
    this.t = resolveStrings(options.locale, options.strings);
    this.serverMode = options.mode ? options.mode === 'server' && Boolean(options.endpoint) : Boolean(options.endpoint);
    this.maskSelectors = options.mask ?? [];
    this.rid = reporterId(options.reporterId);
    if (this.serverMode && options.endpoint) this.api = { endpoint: options.endpoint, token: options.token, reporterId: this.rid, fetch: options.fetch ?? ((...a) => fetch(...a)) };
    const hide = () => { this.clearReports(); this.reset(); this.menu = false; this.render(); };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) void this.loadReports(); };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', restore);
    this.cleanups.push(() => { window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', restore); });
    const refresh = () => this.sync();
    for (const ev of ['hashchange', 'popstate', 'storage']) { window.addEventListener(ev, refresh); this.cleanups.push(() => window.removeEventListener(ev, refresh)); }
    this.sync();
  }

  // ---- public API
  isEnabled(): boolean { return resolveEnabled({ enable: this.o.enable ?? 'query', param: this.o.enableParam ?? 'bugs', storageKey: this.o.storageKey ?? 'bugframe:enabled' }); }
  enable() { setStored(this.o.storageKey ?? 'bugframe:enabled', true); this.mount(); }
  disable() { setStored(this.o.storageKey ?? 'bugframe:enabled', false); this.unmount(); }
  open() { if (!this.host) this.mount(); if (this.phase === 'idle') void this.begin(); }
  close() { this.reset(); this.menu = false; this.render(); }
  destroy() { this.unmount(); this.cleanups.forEach(fn => fn()); this.cleanups = []; this.uninstallConsole?.(); this.uninstallConsole = null; for (const u of this.thumbs.values()) URL.revokeObjectURL(u); this.thumbs.clear(); }

  // ---- mounting
  private sync() { if (this.isEnabled()) this.mount(); else this.unmount(); }
  private mount() {
    if (this.host) return;
    if (this.o.captureConsole) this.uninstallConsole = installConsoleCapture();
    const host = h('div', { 'data-bug-ui': 'true', 'data-bugframe': '' });
    host.style.cssText = 'all:initial;position:static;';
    this.root = host.attachShadow({ mode: 'open' });
    (this.o.container ?? document.body).append(host);
    this.host = host;
    const vv = window.visualViewport;
    if (vv) {
      const update = () => this.updateViewport();
      vv.addEventListener('resize', update); vv.addEventListener('scroll', update);
      this.cleanups.push(() => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); });
    }
    const outside = (e: PointerEvent) => { if (this.menu && !e.composedPath().includes(this.wrap as EventTarget)) { this.menu = false; this.render(); } };
    document.addEventListener('pointerdown', outside, true);
    this.cleanups.push(() => document.removeEventListener('pointerdown', outside, true));
    if (this.o.avoid?.length) { const run = () => this.avoid(); window.addEventListener('resize', run); this.avoidTimer = window.setInterval(run, 1500); this.cleanups.push(() => { window.removeEventListener('resize', run); if (this.avoidTimer) clearInterval(this.avoidTimer); }); }
    this.render();
    void this.loadReports();
  }
  private unmount() { this.unlockPage(); this.host?.remove(); this.host = null; this.root = null; this.wrap = null; this.phase = 'idle'; this.menu = false; this.clearReports(); if (this.avoidTimer) { clearInterval(this.avoidTimer); this.avoidTimer = null; } }

  /** Slide the button along the screen edge until it clears the other floating buttons named in `avoid`. */
  private avoid() {
    if (!this.wrap || !this.o.avoid?.length) return;
    const position = this.o.position ?? 'bottom-right', bottom = position.startsWith('bottom'), right = position.endsWith('right');
    const bounds = this.wrap.getBoundingClientRect();
    const width = bounds.width || 230, height = bounds.height || 48, gap = 12, baseY = 16 + (this.o.offset?.y ?? 0), baseX = 16 + (this.o.offset?.x ?? 0);
    const vw = window.innerWidth, vh = window.innerHeight;
    const slot = { l: right ? vw - baseX - width : baseX, t: bottom ? vh - baseY - height : baseY, r: right ? vw - baseX : baseX + width, b: bottom ? vh - baseY : baseY + height };
    let extra = 0;
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      for (const sel of this.o.avoid) {
        let list: Element[] = []; try { list = Array.from(document.querySelectorAll(sel)); } catch { continue; }
        for (const el of list) {
          const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
          const top = slot.t + (bottom ? -extra : extra), bot = slot.b + (bottom ? -extra : extra);
          if (r.left < slot.r + gap && r.right > slot.l - gap && r.top < bot + gap && r.bottom > top - gap) { extra = bottom ? Math.max(extra, slot.b - r.top + gap) : Math.max(extra, r.bottom - slot.t + gap); moved = true; }
        }
      }
      if (!moved) break;
    }
    this.wrap.style.setProperty('--bf-ey', `${Math.round(extra)}px`);
  }

  // ---- data
  private clearReports() {
    this.dataGeneration++; this.reports = null; this.reviewMessage = '';
    for (const url of this.thumbs.values()) URL.revokeObjectURL(url); this.thumbs.clear();
  }
  private async loadReports() {
    if (!this.api) return;
    const generation = this.dataGeneration, request = ++this.listRequest;
    try {
      const reports = await listReports(this.api);
      if (generation !== this.dataGeneration || request !== this.listRequest) return;
      this.reports = reports;
      // Preserve the button and menu actions: a late response must not remove a target mid-tap.
      const fab = this.root?.querySelector('.fab');
      fab?.querySelector('.count')?.remove();
      const open = this.reports.filter(r => !['fixed', 'wontfix', 'approved'].includes(r.status)).length;
      if (fab && open > 0 && this.phase === 'idle') fab.append(h('b', { class: 'count', 'aria-label': this.t.openCount.replace('{n}', String(open)) }, String(open)));
      const list = this.root?.querySelector('.menu .list');
      const updated = list ? this.renderMenu().querySelector('.list') : null;
      if (updated) list?.replaceWith(updated);
      void this.loadThumbs();
    } catch (error) {
      if (generation !== this.dataGeneration || request !== this.listRequest) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) { this.clearReports(); this.root?.querySelector('.menu .list')?.replaceChildren(h('p', { role: 'alert' }, this.t.accessDenied)); }
      else this.root?.querySelector('.menu .list')?.append(h('p', { role: 'alert' }, this.t.reviewFailed));
    }
  }
  private async loadThumbs() {
    if (!this.api) return;
    for (const r of (this.reports ?? []).slice(0, 12)) {
      if (this.thumbs.has(r.id)) continue;
      const generation = this.dataGeneration;
      const url = await fetchThumb(this.api, r.id);
      if (generation !== this.dataGeneration) { if (url) URL.revokeObjectURL(url); return; }
      if (url) {
        this.thumbs.set(r.id, url);
        const image = Array.from(this.root?.querySelectorAll<HTMLImageElement>('.thumb') ?? []).find(img => img.dataset.reportId === r.id);
        if (image) image.src = url;
      }
    }
  }

  // ---- flow
  private reset() { this.phase = 'idle'; this.rect = null; this.hint = ''; this.error = ''; this.text = ''; this.chosen = []; this.extrasOpen = false; this.kind = 'bug'; this.currentText = ''; this.suggestedText = ''; this.full = ''; this.region = ''; this.startPt = null; }
  private go(phase: Phase) { this.phase = phase; this.render(); }
  private fail(e: unknown) { try { this.o.onError?.(e instanceof Error ? e : new Error(String(e))); } catch { /* host callback errors never break the tool */ } }

  private async begin() {
    this.opener = (this.root?.activeElement as Element | null) ?? null;
    this.menu = false; this.error = ''; this.hint = ''; this.capturedViewport = { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }; this.capturedScroll = { x: window.scrollX, y: window.scrollY }; this.go('capturing');
    try {
      const raw = await (this.o.captureFn ? this.o.captureFn() : captureViewport({ maxPixelRatio: this.o.maxPixelRatio, exclude: this.o.exclude }));
      const rects = maskRects({ maskInputs: this.o.maskInputs !== false, selectors: this.maskSelectors });
      this.full = await maskImage(raw, rects, { w: window.innerWidth, h: window.innerHeight });
      if (this.o.selection === 'area') this.go('select');
      else await this.choose({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
    } catch (e) { this.fail(e); this.reset(); this.error = this.t.captureFailed; this.render(); }
  }
  private async choose(r: Rect) {
    this.rect = r;
    try {
      const vp = this.capturedViewport ?? { w: window.innerWidth, h: window.innerHeight };
      const whole = r.x === 0 && r.y === 0 && r.w >= vp.w && r.h >= vp.h;
      this.region = whole ? this.full : await cropImage(this.full, r, vp);
      this.go('sheet');
    } catch (e) { this.fail(e); this.hint = this.t.selectCutFailed; this.go('select'); }
  }
  private wholeScreen() { const vp = this.capturedViewport ?? { w: window.innerWidth, h: window.innerHeight }; void this.choose({ x: 0, y: 0, w: vp.w, h: vp.h }); }

  private async buildReport() {
    let metadata: Record<string, unknown> = {};
    try { metadata = (await this.o.metadata?.()) ?? {}; } catch (e) { this.fail(e); }
    const context = buildContext({ region: this.rect, metadata, includeConsole: Boolean(this.o.captureConsole), maskSelector: selectorList(this.maskSelectors), redactParams: this.o.redactParams });
    if (this.capturedViewport) context.viewport = this.capturedViewport;
    if (this.capturedScroll) context.scroll = this.capturedScroll;
    return { kind: this.kind, currentText: this.kind === 'content' ? this.currentText : '', suggestedText: this.kind === 'content' ? this.suggestedText : '', description: this.text.trim(), types: this.chosen, context, region: this.region, full: this.full };
  }
  private async send() {
    if (!this.text.trim() || !this.rect) return;
    this.error = ''; this.accessDenied = false; this.go('sending');
    try {
      const payload = await this.buildReport();
      if (this.api) {
        const res = await sendReport(this.api, payload);
        this.finishSent(res.id, false); void this.loadReports();
      } else { this.download(payload); }
    } catch (e) {
      this.fail(e);
      this.accessDenied = e instanceof ApiError && (e.status === 401 || e.status === 403);
      this.error = this.accessDenied ? this.t.accessDenied : this.t.sendFailed;
      this.go('sheet');
    }
  }
  private download(payload: Awaited<ReturnType<Bugframe['buildReport']>>) {
    const id = newId(), enc = new TextEncoder();
    const report = { id, status: 'open', note: '', createdAt: new Date().toISOString(), description: payload.description, kind: payload.kind, currentText: payload.currentText, suggestedText: payload.suggestedText, types: payload.types, context: payload.context, files: { region: 'region.png', full: 'full.png' } };
    const zip = makeZip([
      { name: `${id}/report.json`, data: enc.encode(JSON.stringify(report, null, 2)) },
      { name: `${id}/region.png`, data: dataUrlToBytes(payload.region) },
      { name: `${id}/full.png`, data: dataUrlToBytes(payload.full) },
    ]);
    const url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
    const a = h('a', { href: url, download: `${id}.zip` }); a.style.display = 'none'; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.finishSent(id, true);
  }
  private finishSent(id: string, downloaded: boolean) {
    this.downloaded = downloaded;
    this.go('sent');
    try { this.o.onSent?.({ id, downloaded }); } catch (e) { this.fail(e); }
    window.setTimeout(() => { if (this.phase === 'sent') { this.reset(); this.render(); this.restoreFocus(); } }, 2200);
  }
  private downloaded = false;
  private restoreFocus() { const fab = this.root?.querySelector<HTMLElement>('.feedback-start'); fab?.focus(); }

  private updateViewport() {
    const shell = this.root?.querySelector<HTMLElement>('.bf');
    shell?.style.setProperty('--bf-vh', `${window.visualViewport?.height ?? window.innerHeight}px`);
    shell?.style.setProperty('--bf-vtop', `${window.visualViewport?.offsetTop ?? 0}px`);
  }
  private unlockPage() { if (this.modalOverflow !== null) { document.body.style.overflow = this.modalOverflow; this.modalOverflow = null; } }

  // ---- rendering
  private render() {
    if (!this.root) return;
    const root = this.root;
    this.t = resolveStrings(this.o.locale, this.o.strings);
    root.replaceChildren(h('style', {}, CSS_TEXT));
    const scheme = this.o.colorScheme ?? 'auto';
    const shell = h('div', { class: 'bf', lang: resolveLocale(this.o.locale), 'data-scheme': scheme });
    if (this.o.accent) shell.style.setProperty('--bf-accent', this.o.accent);
    if (this.o.zIndex !== undefined) shell.style.setProperty('--bf-z', String(this.o.zIndex));
    root.append(shell);
    this.updateViewport();
    if (['capturing', 'select', 'sheet', 'sending', 'sent'].includes(this.phase)) {
      if (this.modalOverflow === null) { this.modalOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    } else this.unlockPage();
    this.wrap = null;
    if (this.phase === 'idle' || this.phase === 'capturing') shell.append(this.renderFab());
    if (this.phase === 'select') shell.append(this.renderSelect());
    if (this.phase === 'sheet' || this.phase === 'sending' || this.phase === 'sent') shell.append(this.renderSheet());
    const live = h('div', { class: 'sr', role: 'status', 'aria-live': 'polite' }, this.phase === 'capturing' ? this.t.loading : this.phase === 'sent' ? this.t.sentTitle : this.error || '');
    shell.append(live);
    if (this.o.avoid?.length) this.avoid();
  }

  private renderFab(): HTMLElement {
    const t = this.t, busy = this.phase === 'capturing';
    const position = this.o.position ?? 'bottom-right';
    const wrap = h('div', { class: `fab-wrap ${position}` });
    wrap.style.setProperty('--bf-x', `${this.o.offset?.x ?? 0}px`); wrap.style.setProperty('--bf-y', `${this.o.offset?.y ?? 0}px`);
    this.wrap = wrap;
    const open = (this.reports ?? []).filter(r => !['fixed', 'wontfix', 'approved'].includes(r.status)).length;
    const fab = h('button', { type: 'button', class: 'fab', 'aria-label': t.menuMine, 'aria-haspopup': 'menu', 'aria-expanded': String(this.menu), disabled: busy });
    fab.append(icon(busy ? ICON_SPIN : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 6h15M5 12h15M5 18h15"/></svg>'));
    if (open > 0 && !busy) fab.append(h('b', { class: 'count', 'aria-label': t.openCount.replace('{n}', String(open)) }, String(open)));
    fab.addEventListener('click', () => { this.menu = !this.menu; this.render(); if (this.menu) { void this.loadReports(); this.root?.querySelector<HTMLElement>('.menu .main')?.focus(); } else this.restoreFocus(); });
    const start = h('button', { type: 'button', class: 'feedback-start', disabled: busy }, icon(busy ? ICON_SPIN : ICON_BUG), t.button);
    start.addEventListener('click', () => void this.begin());
    wrap.append(start, fab);
    if (this.error && this.phase === 'idle') wrap.append(h('p', { class: 'toast', role: 'alert' }, this.error));
    if (this.menu) wrap.append(this.renderMenu());
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape' && this.menu) { this.menu = false; this.render(); this.restoreFocus(); } });
    return wrap;
  }

  private renderMenu(): HTMLElement {
    const t = this.t, menu = h('div', { class: 'menu', role: 'menu', 'aria-label': t.menuMine });
    const main = h('button', { type: 'button', role: 'menuitem', class: 'item main' }, icon(ICON_BUG), t.menuReport);
    main.addEventListener('click', () => void this.begin());
    menu.append(main);
    if (this.api) {
      const list = h('div', { class: 'list' }, h('p', { class: 'list-title' }, `${t.menuMine}${this.reports ? ` (${this.reports.length})` : ''}`));
      if (this.reports === null) list.append(h('p', { class: 'empty' }, t.loading));
      else if (this.reports.length === 0) list.append(h('p', { class: 'empty' }, t.nothingSent));
      else {
        const ul = h('ul');
        const label: Record<ReportStatus, string> = { open: t.statusOpen, reviewed: t.statusReviewed, in_progress: t.statusInProgress, ready_for_review: t.statusReady, changes_requested: t.statusChangesRequested, approved: t.statusApproved, fixed: t.statusFixed, wontfix: t.statusWontfix };
        for (const r of this.reports.slice(0, 12)) {
          const thumb = this.thumbs.get(r.id);
          const li = h('li', {}, h('img', { class: 'thumb', alt: '', src: thumb, loading: 'lazy', 'data-report-id': r.id }),
            h('span', {}, h('strong', {}, r.description), h('small', {}, h('i', { class: `status is-${r.status}` }, label[r.status] ?? r.status), r.page ? ` · ${r.page}` : ''), r.note ? h('small', {}, r.note) : null));
          const body = li.querySelector('span')!;
          if (r.reviewNote) body.append(h('small', {}, r.reviewNote));
          if (r.status === 'ready_for_review') {
            const actions = h('div', { class: 'review-actions' });
            try {
              const page = new URL(r.page, location.origin);
              if (r.page.startsWith('/') && page.origin === location.origin) actions.append(h('a', { href: page.href, target: '_blank', rel: 'noopener noreferrer' }, t.viewPage));
            } catch { /* invalid links stay hidden */ }
            const approve = h('button', { type: 'button', disabled: this.reviewing }, t.approve);
            const adjust = h('button', { type: 'button', disabled: this.reviewing }, t.requestChanges);
            const form = h('div', { class: 'adjustment', hidden: true });
            const note = h('textarea', { rows: 2, maxlength: 2000, 'aria-label': t.adjustmentLabel });
            const submit = h('button', { type: 'button', disabled: true }, t.sendAdjustment);
            note.addEventListener('input', () => { submit.disabled = !note.value.trim(); });
            adjust.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) note.focus(); });
            const respond = async (action: 'approve' | 'request_changes') => {
              if (!this.api || this.reviewing) return;
              this.reviewing = true; approve.disabled = adjust.disabled = submit.disabled = true;
              const generation = this.dataGeneration;
              try {
                await reviewReport(this.api, r.id, action, r.reviewVersion ?? 0, note.value);
                this.reviewMessage = t.reviewSaved;
              } catch (error) {
                this.reviewMessage = error instanceof ApiError && [401, 403].includes(error.status) ? t.accessDenied : t.reviewFailed;
              } finally {
                this.reviewing = false;
                if (generation === this.dataGeneration) { await this.loadReports(); if (this.menu) this.render(); }
              }
            };
            approve.addEventListener('click', () => void respond('approve'));
            submit.addEventListener('click', () => void respond('request_changes'));
            form.append(note, submit); actions.append(approve, adjust, form); body.append(actions);
          }
          ul.append(li);
        }
        list.append(ul);
      }
      const refresh = h('button', { type: 'button', class: 'item' }, t.refresh);
      refresh.addEventListener('click', () => void this.loadReports()); list.append(refresh);
      if (this.reviewMessage) list.append(h('p', { class: 'review-message', role: 'status' }, this.reviewMessage));
      menu.append(list);
    }
    if ((this.o.enable ?? 'query') === 'query' || this.o.enable === 'storage') {
      const off = h('button', { type: 'button', role: 'menuitem', class: 'item off' }, t.menuTurnOff);
      off.addEventListener('click', () => this.disable());
      menu.append(off);
    }
    return menu;
  }

  private renderSelect(): HTMLElement {
    const t = this.t;
    const layer = h('div', { class: 'layer', tabindex: '0', role: 'application', 'aria-label': t.selectHint, 'data-testid': 'bf-select-layer' });
    const rectEl = h('div', { class: 'rect' }); rectEl.style.display = 'none';
    const paintRect = () => { const r = this.rect; layer.style.background = r && r.w > 0 ? 'transparent' : ''; if (r && r.w > 0) { rectEl.style.cssText = `display:block;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`; } else rectEl.style.display = 'none'; };
    paintRect();
    const bar = h('div', { class: 'bar' }, h('span', {}, this.hint || t.selectHint));
    const whole = h('button', { type: 'button', class: 'primary' }, t.wholeScreen);
    const cancel = h('button', { type: 'button', 'aria-label': t.cancel }, icon(ICON_X), t.cancel);
    whole.addEventListener('click', () => this.wholeScreen());
    cancel.addEventListener('click', () => { this.reset(); this.render(); this.restoreFocus(); });
    bar.append(whole, cancel);
    for (const ev of ['pointerdown', 'pointerup']) bar.addEventListener(ev, e => e.stopPropagation());
    layer.append(rectEl, bar);

    layer.addEventListener('pointerdown', e => { if (e.button > 0) return; e.preventDefault(); try { layer.setPointerCapture(e.pointerId); } catch { /* unsupported */ } this.startPt = { x: e.clientX, y: e.clientY }; this.hint = ''; bar.firstElementChild!.textContent = t.selectHint; this.rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 }; paintRect(); });
    layer.addEventListener('pointermove', e => { if (this.startPt) { this.rect = norm(this.startPt, { x: e.clientX, y: e.clientY }); paintRect(); } });
    layer.addEventListener('pointerup', e => {
      if (!this.startPt) return;
      e.preventDefault();
      const r = norm(this.startPt, { x: e.clientX, y: e.clientY }); this.startPt = null;
      try { layer.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (r.w < MIN_SIDE || r.h < MIN_SIDE) {
        // Hit-test the page synchronously underneath the selection overlay, without activating its links/buttons.
        const visibility = this.host?.style.visibility;
        if (this.host) this.host.style.visibility = 'hidden';
        let box: DOMRect | undefined;
        try { const element = document.elementFromPoint?.(e.clientX, e.clientY); if (element && element !== document.body && element !== document.documentElement) box = element.getBoundingClientRect(); }
        finally { if (this.host) this.host.style.visibility = visibility ?? ''; }
        const w = Math.min(window.innerWidth, Math.max(120, (box?.width ?? 160) + 16)), height = Math.min(window.innerHeight, Math.max(72, (box?.height ?? 96) + 16));
        void this.choose({ x: Math.max(0, Math.min(window.innerWidth - w, (box?.left ?? e.clientX - w / 2) - 8)), y: Math.max(0, Math.min(window.innerHeight - height, (box?.top ?? e.clientY - height / 2) - 8)), w, h: height }); return;
      }
      void this.choose(r);
    });
    layer.addEventListener('pointercancel', () => { this.startPt = null; this.rect = null; paintRect(); });
    // Keyboard path: arrows move a box, Shift+arrows resize it, Enter confirms, Escape cancels.
    layer.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.reset(); this.render(); this.restoreFocus(); return; }
      if (e.target !== layer) return;
      const step = 24, vw = window.innerWidth, vh = window.innerHeight;
      if (e.key === 'Enter') { e.preventDefault(); if (this.rect && this.rect.w >= MIN_SIDE) void this.choose(this.rect); else this.wholeScreen(); return; }
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      const r = this.rect && this.rect.w > 0 ? { ...this.rect } : { x: Math.round(vw * .25), y: Math.round(vh * .25), w: Math.round(vw * .5), h: Math.round(vh * .5) };
      if (e.shiftKey) { r.w = Math.max(MIN_SIDE, Math.min(vw - r.x, r.w + dx)); r.h = Math.max(MIN_SIDE, Math.min(vh - r.y, r.h + dy)); }
      else { r.x = Math.max(0, Math.min(vw - r.w, r.x + dx)); r.y = Math.max(0, Math.min(vh - r.h, r.y + dy)); }
      this.rect = r; paintRect();
    });
    queueMicrotask(() => layer.focus());
    return layer;
  }

  private renderSheet(): HTMLElement {
    const t = this.t;
    const backdrop = h('div', { class: 'backdrop' });
    const sheet = h('section', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bf-title', tabindex: '-1' });
    backdrop.append(sheet);
    if (this.phase === 'sent') {
      sheet.append(h('div', { class: 'sent' }, icon(ICON_CHECK), h('strong', {}, t.sentTitle), h('span', {}, this.downloaded ? t.sentDownloaded : t.sentBody)));
      const done = h('button', { type: 'button', class: 'send' }, t.done);
      done.addEventListener('click', () => { this.reset(); this.render(); this.restoreFocus(); }); sheet.append(done);
      queueMicrotask(() => sheet.focus());
      return backdrop;
    }
    const sending = this.phase === 'sending';
    const x = h('button', { type: 'button', disabled: sending, class: 'x', 'aria-label': t.cancel }, icon(ICON_X));
    x.addEventListener('click', () => { this.reset(); this.render(); this.restoreFocus(); });
    sheet.append(h('header', {}, h('h2', { id: 'bf-title' }, t.title), x));
    const content = h('div', { class: 'sheet-content' });
    const preview = h('div', { class: 'preview-row' }, h('img', { class: 'preview', src: this.region, alt: t.previewAlt }), h('span', {}, t.screenshotAdded));
    const again = h('button', { type: 'button', disabled: sending, class: 'link' }, t.anotherArea);
    again.addEventListener('click', () => { this.rect = null; this.go('select'); });
    preview.append(again); content.append(preview, h('label', { for: 'bf-text' }, t.descriptionLabel));
    const ta = h('textarea', { id: 'bf-text', rows: 3, maxlength: 4000, disabled: sending, placeholder: ({ bug: t.hintBug, content: t.hintContent, design: t.hintDesign, idea: t.hintIdea })[this.kind], 'aria-required': 'true' });
    ta.value = this.text; content.append(ta);
    const sendBtn = h('button', { type: 'button', class: 'send' }, sending ? t.sending : t.send);
    const sync = () => { sendBtn.disabled = sending || !this.text.trim(); };
    ta.addEventListener('input', () => { this.text = ta.value; sync(); });
    const extras = h('details', { class: 'extras', open: this.extrasOpen });
    extras.addEventListener('toggle', () => { this.extrasOpen = extras.open; });
    extras.append(h('summary', {}, t.moreOptions));
    const kinds: [FeedbackKind, string][] = [['bug', t.kindBug], ['content', t.kindContent], ['design', t.kindDesign], ['idea', t.kindIdea]];
    const choices = h('fieldset', { class: 'chips kinds' }, h('legend', {}, t.kindLabel));
    for (const [kind, name] of kinds) {
      const button = h('button', { type: 'button', disabled: sending, 'aria-pressed': String(this.kind === kind), class: this.kind === kind ? 'is-on' : '' }, name);
      button.addEventListener('click', () => { this.kind = kind; this.extrasOpen = true; this.render(); }); choices.append(button);
    }
    extras.append(choices);
    if (this.kind === 'content') {
      for (const [key, label] of [['currentText', t.currentText], ['suggestedText', t.suggestedText]] as const) {
        const field = h('textarea', { id: `bf-${key}`, rows: 2, maxlength: 2000, disabled: sending }); field.value = this[key];
        field.addEventListener('input', () => { this[key] = field.value; });
        extras.append(h('label', { for: `bf-${key}` }, label), field);
      }
    }
    const types = this.o.types ?? [];
    if (types.length) {
      const chips = h('fieldset', { class: 'chips' }, h('legend', {}, t.typesLabel));
      for (const name of types) {
        const b = h('button', { type: 'button', 'aria-pressed': String(this.chosen.includes(name)), class: this.chosen.includes(name) ? 'is-on' : '' }, name);
        b.addEventListener('click', () => { this.chosen = this.chosen.includes(name) ? this.chosen.filter(v => v !== name) : [...this.chosen, name]; const on = this.chosen.includes(name); b.className = on ? 'is-on' : ''; b.setAttribute('aria-pressed', String(on)); });
        chips.append(b);
      }
      extras.append(chips);
    }
    content.append(extras); sheet.append(content);
    if (this.error) {
      content.append(h('p', { class: 'error', role: 'alert' }, this.error));
      if (this.accessDenied && this.o.loginUrl) content.append(h('a', { class: 'link', href: this.o.loginUrl, target: '_blank', rel: 'noopener noreferrer' }, t.signIn));
      if (this.api && !this.accessDenied && this.o.allowDownloadFallback !== false) { const dl = h('button', { type: 'button', class: 'link' }, t.downloadInstead); dl.addEventListener('click', () => void this.buildReport().then(p => this.download(p))); content.append(dl); }
    }
    sendBtn.addEventListener('click', () => void this.send()); sync();
    sheet.append(h('footer', { class: 'sheet-actions' }, sendBtn));
    sheet.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); if (!sending) { this.reset(); this.render(); this.restoreFocus(); } return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(n => !(n as HTMLButtonElement).disabled && (n.tagName === 'SUMMARY' || !n.closest('details:not([open])')));
      if (!items.length) return;
      const active = this.root?.activeElement, first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (active === first || active === sheet)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    });
    queueMicrotask(() => { if (!sending) sheet.focus(); });
    return backdrop;
  }
}

/** Create the reporter. Safe to call on every page load: it only shows itself when `enable` says so. */
export function init(options: InitOptions = {}): BugframeInstance {
  if (typeof window === 'undefined') return { open() {}, close() {}, enable() {}, disable() {}, isEnabled: () => false, destroy() {} };
  return new Bugframe(options);
}

// Script-tag use: <script src="bugframe.min.js" data-endpoint="/api/bugframe" data-token="..." data-position="bottom-left" data-enable="query">
if (typeof document !== 'undefined') {
  const s = document.currentScript as HTMLScriptElement | null;
  if (s && s.dataset && ('endpoint' in s.dataset || 'download' in s.dataset || 'autoinit' in s.dataset)) {
    const d = s.dataset, list = (v?: string) => (v ? v.split(',').map(x => x.trim()).filter(Boolean) : undefined);
    const start = () => init({
      endpoint: d.endpoint, loginUrl: d.loginUrl, selection: d.selection as InitOptions['selection'], token: d.token, mode: 'download' in d ? 'download' : d.mode as InitOptions['mode'], allowDownloadFallback: d.allowDownloadFallback === 'false' ? false : undefined, enable: (d.enable as InitOptions['enable']) ?? 'query', enableParam: d.enableParam,
      position: d.position as InitOptions['position'], locale: d.locale, accent: d.accent, captureConsole: d.captureConsole === 'true', types: list(d.types), mask: list(d.mask), exclude: list(d.exclude), avoid: list(d.avoid),
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }
}
