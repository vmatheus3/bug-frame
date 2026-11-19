import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const STATUSES = ['open', 'reviewed', 'in_progress', 'ready_for_review', 'changes_requested', 'approved', 'fixed', 'wontfix'];
export const FEEDBACK_KINDS = ['bug', 'content', 'design', 'idea'];
export const isOpen = status => !['approved', 'fixed', 'wontfix'].includes(status);
export const isActionable = status => isOpen(status) && status !== 'ready_for_review';
export const ID_RE = /^bug-\d{8}-\d{6}-[a-f0-9]{4}$/;
export const FILE_NAMES = ['region.png', 'full.png'];
/** Kinds only a verified administrator may create (a page analysis runs the developer's own tools). */
export const ADMIN_KINDS = ['audit'];
/** The only extra files a storage adapter may hold for a report, written by `bugframe audit`. */
export const ATTACHMENT_NAMES = ['audit.md', 'audit.json'];
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
/** The page-analysis bookkeeping a watcher may store with an audit request: a fixed shape, bounded, nothing else kept. */
export function cleanAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > 10) return null;
  const out = { attempts: value.attempts };
  for (const key of ['startedAt', 'finishedAt']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 40 || Number.isNaN(Date.parse(value[key])) || !/^\d{4}-\d{2}-\d{2}T/.test(value[key])) return null;
    out[key] = value[key];
  }
  for (const key of ['degraded', 'noteOnly']) { if (value[key] === undefined) continue; if (typeof value[key] !== 'boolean') return null; out[key] = value[key]; }
  if (value.counts !== undefined) {
    if (!value.counts || typeof value.counts !== 'object' || Array.isArray(value.counts)) return null;
    out.counts = {};
    for (const key of ['blocker', 'high', 'medium', 'low']) { const n = value.counts[key] ?? 0; if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return null; out.counts[key] = n; }
  }
  if (value.lastError !== undefined) { if (typeof value.lastError !== 'string') return null; out.lastError = value.lastError.slice(0, 300); }
  return out;
}
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pad = n => String(n).padStart(2, '0');

export const text = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);

export function newReportId(now = new Date()) {
  return `bug-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${randomBytes(2).toString('hex')}`;
}

/** Constant-time string compare (hash first so lengths never leak). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest(), hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Decode `data:image/png;base64,...` and check it really is a PNG of a sane size.
 * Returns the Buffer or null. Never trusts the declared type: the bytes must start with the PNG signature and a valid IHDR.
 */
export function decodePng(value, maxBytes) {
  const prefix = 'data:image/png;base64,';
  if (typeof value !== 'string' || !value.startsWith(prefix)) return null;
  if (value.length > Math.ceil(maxBytes * 4 / 3) + prefix.length + 8) return null;
  const buf = Buffer.from(value.slice(prefix.length), 'base64');
  return isPng(buf, maxBytes) ? buf : null;
}

/** True when the bytes are a PNG (signature + IHDR) of sane size. */
export function isPng(buf, maxBytes = 10 * 1024 * 1024) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.length > maxBytes) return false;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (buf.readUInt32BE(8) !== 13 || buf.subarray(12, 16).toString('latin1') !== 'IHDR') return false;
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return w >= 1 && h >= 1 && w <= 16384 && h <= 16384;
}

/** Keep the context a plain, bounded object: the fixer reads it, so nothing executable or huge goes in. */
export function cleanContext(c) {
  const obj = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  const num = v => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const rect = r => (r && typeof r === 'object' ? { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) } : null);
  let metadata = {};
  if (obj.metadata && typeof obj.metadata === 'object' && !Array.isArray(obj.metadata)) {
    try { const json = JSON.stringify(obj.metadata); if (json.length <= 8192) metadata = JSON.parse(json); else metadata = { _dropped: 'metadata larger than 8 KB' }; } catch { metadata = {}; }
  }
  return {
    url: text(obj.url, 1000), title: text(obj.title, 200),
    viewport: obj.viewport && typeof obj.viewport === 'object' ? { w: num(obj.viewport.w), h: num(obj.viewport.h), dpr: num(obj.viewport.dpr) } : null,
    scroll: obj.scroll && typeof obj.scroll === 'object' ? { x: num(obj.scroll.x), y: num(obj.scroll.y) } : null,
    region: rect(obj.region), userAgent: text(obj.userAgent, 400), language: text(obj.language, 40), capturedAt: text(obj.capturedAt, 40),
    elements: (Array.isArray(obj.elements) ? obj.elements : []).slice(0, 12).map(e => ({ path: text(e?.path, 300), component: text(e?.component, 120), text: text(e?.text, 160) })),
    consoleErrors: (Array.isArray(obj.consoleErrors) ? obj.consoleErrors : []).slice(0, 20).map(e => ({ at: text(e?.at, 40), message: text(e?.message, 500) })),
    metadata,
  };
}

/** The short form shown in "My reports". */
export function summarize(r) {
  let page = '';
  try { const u = new URL(r.context?.url ?? ''); page = u.pathname + u.hash; } catch { page = ''; }
  return { id: r.id, status: r.status, note: r.note ?? '', createdAt: r.createdAt, description: r.description, types: r.types ?? [], kind: r.kind ?? 'bug', currentText: r.currentText ?? '', suggestedText: r.suggestedText ?? '', reviewVersion: r.reviewVersion ?? 0, reviewNote: r.reviewNote ?? '', activity: r.activity ?? [], page: page.slice(0, 120) };
}
