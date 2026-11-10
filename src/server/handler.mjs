// The report API as a plain fetch handler: (Request) => Promise<Response>. Works in Node 18+, Bun, Deno, Cloudflare Workers
// (with a custom storage adapter) and behind any framework through the adapters in node.mjs.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createFileInvitationStorage, invitationEmail, invitationService } from './invitations.mjs';
import { createNotifications } from './notifications.mjs';
import { createFileStorage } from './storage-fs.mjs';
import { FEEDBACK_KINDS, ID_RE, STATUSES, isOpen, cleanContext, decodePng, newReportId, safeEqual, summarize, text } from './util.mjs';

const MB = 1024 * 1024;
const DEFAULTS = { maxBodyBytes: 24 * MB, maxImageBytes: 10 * MB, maxDescription: 4000, rateLimit: { max: 10, windowMs: 60_000 } };

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const err = (status, error, message, extra) => json(status, { error, message }, extra);

/**
 * @param {import('../../types/server.js').BugframeOptions} options
 * @returns {import('../../types/server.js').Bugframe}
 */
export function createBugframe(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const storage = o.storage ?? (o.dir ? createFileStorage({ dir: o.dir }) : null);
  if (!storage) throw new Error('createBugframe needs `dir` (filesystem) or a `storage` adapter');
  const basePath = (o.basePath ?? '').replace(/\/+$/, '');
  const log = o.logger ?? (() => {});
  const rate = o.rateLimit === false ? null : { ...DEFAULTS.rateLimit, ...(o.rateLimit ?? {}) };
  const hits = new Map();
  const now = o.now ?? (() => new Date());
  const invitationStore = o.invitations ? (o.invitations.storage ?? (o.dir ? createFileInvitationStorage({ dir: join(o.dir, '.invitations') }) : null)) : null;
  if (o.invitations && !invitationStore) throw new Error('Invitations require dir or a dedicated invitation storage adapter.');
  const invites = invitationStore ? invitationService(invitationStore, now) : null;
  const mutations = new Map();
  let codexConnection = null;
  const serial = (id, operation) => {
    const next = (mutations.get(id) ?? Promise.resolve()).then(operation);
    const tail = next.catch(() => {}); mutations.set(id, tail);
    void tail.then(() => { if (mutations.get(id) === tail) mutations.delete(id); }); return next;
  };

  // ---- helpers
  const limited = key => {
    if (!rate) return false;
    const now = Date.now(), cutoff = now - rate.windowMs;
    const list = (hits.get(key) ?? []).filter(t => t > cutoff);
    if (list.length >= rate.max) { hits.set(key, list); return true; }
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => t > cutoff)) hits.delete(k);
    return false;
  };
  const allowedOrigin = (origin, url) => {
    if (!origin) return true; // not a browser cross-site request (curl, CLI, server to server)
    try { if (new URL(origin).origin === url.origin) return true; } catch { return false; }
    const a = o.allowedOrigins;
    if (a === '*') return true;
    if (typeof a === 'function') return Boolean(a(origin));
    return Array.isArray(a) && a.includes(origin);
  };
  const cors = (origin, url) => {
    if (!origin || !allowedOrigin(origin, url)) return {};
    return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'access-control-allow-headers': 'content-type,x-bugframe-token,x-bugframe-reporter,authorization', 'access-control-max-age': '600' };
  };
  // Only a server-verified principal grants access. Public widget tokens and reporter headers never do.
  const identity = async req => {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (o.adminToken && bearer && safeEqual(bearer, o.adminToken)) return { role: 'admin', reporter: 'admin:token' };
    if (o.authorize) {
      try {
        const p = await o.authorize(req);
        if (p && typeof p === 'object' && ['admin', 'client', 'user'].includes(p.role) && typeof p.id === 'string' && p.id.trim() && p.id.length <= 256) {
          return { role: p.role, reporter: `user:${createHash('sha256').update(p.id).digest('hex')}`, email: invitationEmail(p.email), emailVerified: p.emailVerified === true };
        }
      } catch { /* unavailable or expired session verification means no access */ }
    }
    return null;
  };
  const clientIp = (req, ctx) => ctx?.ip || (o.trustProxy ? (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() : '') || 'unknown';

  async function readJsonBody(req) {
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return { error: err(415, 'unsupported_media_type', 'Send application/json.') };
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > o.maxBodyBytes) return { error: err(413, 'too_large', 'The report is too large.') };
    if (!req.body) return { error: err(400, 'bad_json', 'Empty body.') };
    const reader = req.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > o.maxBodyBytes) { try { await reader.cancel(); } catch { /* already closed */ } return { error: err(413, 'too_large', 'The report is too large.') }; }
      chunks.push(value);
    }
    try { return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { return { error: err(400, 'bad_json', 'The body is not valid JSON.') }; }
  }

  const notifications = createNotifications({ webhook: o.webhook, storage, serial, request: o.fetch ?? fetch, now, logger: log });

  // ---- routes
  async function create(req, ctx, who) {
    if (limited(`account:${who.reporter}`) || limited(`ip:${clientIp(req, ctx)}`)) return err(429, 'rate_limited', 'Too many reports. Try again in a minute.', { 'retry-after': String(Math.ceil((rate?.windowMs ?? 60000) / 1000)) });
    const { body, error } = await readJsonBody(req); if (error) return error;
    const b = body && typeof body === 'object' ? body : {};
    const description = text(b.description, o.maxDescription).trim();
    if (!description) return err(400, 'description_required', 'Describe what you would like to improve.');
    const region = decodePng(b.region, o.maxImageBytes), full = decodePng(b.full, o.maxImageBytes);
    if (!region || !full) return err(400, 'images_required', 'The screenshots are missing, too large, or not PNG files.');
    const kind = b.kind ?? 'bug';
    if (!FEEDBACK_KINDS.includes(kind)) return err(400, 'bad_kind', 'Choose bug, content, design or idea.');
    let report;
    for (let attempt = 0; attempt < 5; attempt++) {
      const d = (o.now ?? (() => new Date()))(), id = (o.generateId ?? newReportId)(d);
      report = { id, status: 'open', note: '', createdAt: d.toISOString(), reporter: who.reporter, description, kind, currentText: kind === 'content' ? text(b.currentText, 2000) : '', suggestedText: kind === 'content' ? text(b.suggestedText, 2000) : '', reviewVersion: 0, reviewNote: '', activity: [], types: (Array.isArray(b.types) ? b.types : []).slice(0, 8).map(t => text(t, 40)).filter(Boolean), context: cleanContext(b.context), files: { region: 'region.png', full: 'full.png' } };
      const delivery = notifications.initial(report); if (delivery) report.delivery = delivery;
      try { await storage.create(report, { region, full }); break; } catch (e) { if (e?.code === 'EXISTS' && attempt < 4) continue; log('store', String(e?.message ?? e)); return err(500, 'store_failed', 'The report could not be saved.'); }
    }
    try { await o.onReport?.(report); } catch (e) { log('onReport', String(e?.message ?? e)); }
    void notifications.wake();
    return json(201, { id: report.id, status: 'open' });
  }

  async function list(req, who, url) {
    const all = who.role === 'admin' && url.searchParams.get('all') === '1';
    if (o.publicList === false && who.role !== 'admin') return json(200, { reports: [] });
    const reporter = who.reporter;
    const rows = (await storage.list()).filter(r => all || r.reporter === reporter);
    return json(200, { reports: rows.map(summarize) });
  }

  async function image(req, who, id, file) {
    if (!ID_RE.test(id)) return err(404, 'not_found', 'Not found.');
    const r = await storage.get(id);
    if (!r || (who.role !== 'admin' && r.reporter !== who.reporter)) return err(404, 'not_found', 'Not found.');
    const buf = await storage.readFile(id, file);
    if (!buf) return err(404, 'not_found', 'Not found.');
    return new Response(buf, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'content-length': String(buf.length) } });
  }

  async function patch(req, id) {
    if (!ID_RE.test(id)) return err(404, 'not_found', 'Not found.');
    const { body, error } = await readJsonBody(req); if (error) return error;
    const status = body?.status;
    if (!STATUSES.includes(status) || status === 'approved') return err(400, 'bad_status', 'Choose a developer status. Only the reporter can approve a review.');
    const note = text(body?.note, 2000).trim();
    if (status === 'ready_for_review' && !note) return err(400, 'note_required', 'Explain what changed before asking for review.');
    return serial(id, async () => {
      const current = await storage.get(id); if (!current) return err(404, 'not_found', 'Not found.');
      const at = now().toISOString();
      const next = await storage.update(id, { status, note, closedAt: isOpen(status) ? null : at,
        reviewVersion: (current.reviewVersion ?? 0) + (status === 'ready_for_review' ? 1 : 0),
        activity: [...(current.activity ?? []), { status, note, at, by: 'developer' }].slice(-100),
      });
      return json(200, { id: next.id, status: next.status, note: next.note, reviewVersion: next.reviewVersion });
    });
  }

  async function review(req, id, who, ctx) {
    if (!ID_RE.test(id)) return err(404, 'not_found', 'Not found.');
    if (limited(`review:${who.reporter}`) || limited(`review-ip:${clientIp(req, ctx)}`)) return err(429, 'rate_limited', 'Please wait before sending another review.');
    const { body, error } = await readJsonBody(req); if (error) return error;
    const action = body?.action, note = text(body?.note, 2000).trim();
    if (!['approve', 'request_changes'].includes(action) || !Number.isInteger(body?.reviewVersion)) return err(400, 'bad_review', 'Choose an action and the version you reviewed.');
    if (action === 'request_changes' && !note) return err(400, 'note_required', 'Explain what still needs adjustment.');
    return serial(id, async () => {
      const current = await storage.get(id);
      if (!current || current.reporter !== who.reporter) return err(404, 'not_found', 'Not found.');
      if (current.status !== 'ready_for_review' || current.reviewVersion !== body.reviewVersion) return err(409, 'review_changed', 'This review has changed. Refresh your requests before responding.');
      const status = action === 'approve' ? 'approved' : 'changes_requested', at = now().toISOString();
      const next = await storage.update(id, { status, reviewNote: note, closedAt: status === 'approved' ? at : null,
        activity: [...(current.activity ?? []), { status, note, at, by: 'customer' }].slice(-100),
      });
      return json(200, summarize(next));
    });
  }

  async function invitations(req, path, who, ctx) {
    if (!invites) return err(404, 'not_found', 'Invitations are not enabled.');
    if (path === '/invitations/accept' && req.method === 'POST') {
      if (!who || who.role !== 'user') return err(401, 'sign_in_required', 'Sign in with the verified email address this invitation was sent to.');
      if (limited(`invite:${who.reporter}`) || limited(`invite-ip:${clientIp(req, ctx)}`)) return err(429, 'rate_limited', 'Too many invitation attempts. Try again later.');
      const { body, error } = await readJsonBody(req); if (error) return error;
      return await invites.accept(body?.token, who) ? json(200, { accepted: true }) : err(403, 'invitation_unavailable', 'This invitation is unavailable or does not match your verified account. Ask the developer for a new invitation.');
    }
    if (who?.role !== 'admin') return err(who ? 403 : 401, 'forbidden', 'An authorized administrator is required.');
    if (path === '/invitations' && req.method === 'GET') return json(200, { invitations: await invites.list() });
    if (path === '/invitations' && req.method === 'POST') {
      const { body, error } = await readJsonBody(req); if (error) return error;
      const email = invitationEmail(body?.email), days = body?.expiresInDays ?? 7;
      if (!email || !Number.isInteger(days) || days < 1 || days > 30) return err(400, 'bad_invitation', 'Enter an email and an access duration from 1 to 30 days.');
      const invitation = await invites.create(email, days);
      if (invitation?.error) return err(409, 'already_invited', 'This customer already has active access or an invitation. Revoke it before creating a new invitation.');
      return invitation ? json(201, invitation) : err(429, 'invitation_limit', 'Revoke unused invitations before creating more.');
    }
    const match = /^\/invitations\/(invite-[a-f0-9]{32})$/.exec(path);
    if (match && req.method === 'PATCH') {
      const { body, error } = await readJsonBody(req); if (error) return error;
      if (body?.status !== 'revoked') return err(400, 'bad_status', 'Only revocation is supported.');
      const record = await invites.revoke(match[1]); return record ? json(200, record) : err(404, 'not_found', 'Not found.');
    }
    return err(405, 'method_not_allowed', 'Not supported.');
  }

  /** True when the URL belongs to this API (so a framework can fall through to its own routes otherwise). */
  const matches = url => { const u = typeof url === 'string' ? new URL(url, 'http://x') : url; return u.pathname === basePath + '/agent' || u.pathname === basePath + '/agent/retry' || u.pathname === basePath + '/agent/heartbeat' || u.pathname === basePath + '/health' || u.pathname === basePath + '/access' || u.pathname === basePath + '/invitations' || u.pathname.startsWith(basePath + '/invitations/') || u.pathname === basePath + '/reports' || u.pathname.startsWith(basePath + '/reports/'); };

  async function handle(req, ctx = {}) {
    const url = new URL(req.url), origin = req.headers.get('origin');
    const c = cors(origin, url);
    const withCors = res => { for (const [k, v] of Object.entries(c)) res.headers.set(k, v); return res; };
    try {
      if (!matches(url)) return withCors(err(404, 'not_found', 'Not found.'));
      if (req.method === 'OPTIONS') return origin && allowedOrigin(origin, url) ? new Response(null, { status: 204, headers: c }) : new Response(null, { status: 403 });
      if (origin && !allowedOrigin(origin, url)) return err(403, 'origin_not_allowed', 'This origin is not allowed.');
      const path = url.pathname.slice(basePath.length);
      if (path === '/health') return withCors(json(200, { ok: true }));
      const account = await identity(req);
      if (path === '/invitations' || path.startsWith('/invitations/')) return withCors(await invitations(req, path, account, ctx));
      const who = account?.role === 'user' ? (await invites?.allows(account) ? { ...account, role: 'client' } : null) : account;
      if (!who) return withCors(err(401, 'unauthorized', 'Sign in with an account authorized to leave feedback.'));
      if (path === '/access') return withCors(req.method === 'GET' ? json(200, { role: who.role, ...(invites && who.role === 'admin' ? { invitations: true } : {}) }) : err(405, 'method_not_allowed', 'Not supported.'));
      if (['/agent', '/agent/retry', '/agent/heartbeat'].includes(path)) {
        if (who.role !== 'admin') return withCors(err(403, 'forbidden', 'Admin only.'));
        if (path === '/agent' && req.method === 'GET') return withCors(json(200, { ...await notifications.status(), codex: codexConnection ? { ...codexConnection, connected: now().getTime() - Date.parse(codexConnection.lastSeenAt) < codexConnection.intervalMs * 3 + 10000 } : { connected: false } }));
        if (path === '/agent/heartbeat' && req.method === 'POST') {
          const { body, error } = await readJsonBody(req); if (error) return withCors(error);
          if (body?.disconnect === true) { codexConnection = null; return withCors(json(200, { ok: true })); }
          const intervalMs = body?.intervalMs;
          if (!Number.isInteger(intervalMs) || intervalMs < 3000 || intervalMs > 300000 || body?.threadId != null && (typeof body.threadId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.threadId))) return withCors(err(400, 'bad_connection', 'Invalid connection metadata.'));
          codexConnection = { lastSeenAt: now().toISOString(), intervalMs, threadId: body.threadId ?? null }; return withCors(json(200, { ok: true }));
        }
        if (path === '/agent/retry' && req.method === 'POST') { const { error } = await readJsonBody(req); if (error) return withCors(error); return withCors(json(200, await notifications.retry())); }
        return withCors(err(405, 'method_not_allowed', 'Not supported.'));
      }
      const parts = path.split('/').filter(Boolean); // ['reports', id?, file?]
      if (parts[0] === 'reports') {
        if (parts.length === 1 && req.method === 'POST') return withCors(await create(req, ctx, who));
        if (parts.length === 1 && req.method === 'GET') return withCors(await list(req, who, url));
        if (parts.length === 3 && req.method === 'GET' && (parts[2] === 'region.png' || parts[2] === 'full.png')) return withCors(await image(req, who, parts[1], parts[2]));
        if (parts.length === 2 && req.method === 'GET') {
          if (who.role !== 'admin') return withCors(err(403, 'forbidden', 'Admin only.'));
          if (!ID_RE.test(parts[1])) return withCors(err(404, 'not_found', 'Not found.'));
          const r = await storage.get(parts[1]); return withCors(r ? json(200, r) : err(404, 'not_found', 'Not found.'));
        }
        if (parts.length === 3 && parts[2] === 'review' && req.method === 'POST') return withCors(await review(req, parts[1], who, ctx));
        if (parts.length === 2 && req.method === 'PATCH') { if (who.role !== 'admin') return withCors(err(403, 'forbidden', 'Admin only.')); return withCors(await patch(req, parts[1])); }
      }
      return withCors(err(405, 'method_not_allowed', 'Not supported.'));
    } catch (e) { log('handler', String(e?.stack ?? e)); return withCors(err(500, 'server_error', 'Something went wrong.')); }
  }

  return { handle, matches, storage, basePath, invitationsEnabled: Boolean(invites), notifications, close: () => notifications.close() };
}
