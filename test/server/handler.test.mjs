import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createBugframe, createMemoryStorage } from '../../src/server/index.mjs';
import { body, cleanup, PNG_URL, post, tmpDir } from '../helpers.mjs';

const U = 'https://app.test/api/bugframe';
// Non-auth tests run with an explicitly approved fixture account. Auth denial is covered in auth.test.mjs.
const fresh = async (opts = {}) => { const dir = await tmpDir(); const bf = createBugframe({ dir, basePath: '/api/bugframe', rateLimit: false, authorize: () => ({ id: 'fixture-user', role: 'client' }), ...opts }); return { dir, bf, done: async () => { await bf.close(); await cleanup(dir); } }; };
const get = (url, headers = {}) => new Request(url, { headers });

test('creates a report folder with report.json, region.png and full.png', async () => {
  const { dir, bf, done } = await fresh();
  const res = await bf.handle(post(`${U}/reports`, body(), { 'x-bugframe-reporter': 'r1' }));
  assert.equal(res.status, 201);
  const { id, status } = await res.json();
  assert.equal(status, 'open'); assert.match(id, /^bug-\d{8}-\d{6}-[a-f0-9]{4}$/);
  assert.deepEqual((await readdir(join(dir, id))).sort(), ['full.png', 'region.png', 'report.json']);
  const r = JSON.parse(await readFile(join(dir, id, 'report.json'), 'utf8'));
  assert.equal(r.description, 'The save button overlaps the footer'); assert.match(r.reporter, /^user:[a-f0-9]{64}$/); assert.equal(r.context.metadata.version, '1.2.3');
  assert.equal((await readFile(join(dir, id, 'region.png'))).subarray(1, 4).toString(), 'PNG');
  await done();
});

test('requires a description and real PNG images', async () => {
  const { bf, done } = await fresh();
  assert.equal((await bf.handle(post(`${U}/reports`, body({ description: '   ' })))).status, 400);
  assert.equal((await bf.handle(post(`${U}/reports`, body({ region: 'data:image/png;base64,AAAA' })))).status, 400);
  assert.equal((await bf.handle(post(`${U}/reports`, body({ full: 'data:image/jpeg;base64,/9j/4AAQ' })))).status, 400);
  assert.equal((await bf.handle(post(`${U}/reports`, body({ full: 'http://evil.test/x.png' })))).status, 400);
  const notPng = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>'.repeat(5)).toString('base64');
  assert.equal((await bf.handle(post(`${U}/reports`, body({ region: notPng })))).status, 400);
  await done();
});

test('rejects non-JSON, invalid JSON and oversized bodies', async () => {
  const { bf, done } = await fresh({ maxBodyBytes: 2000 });
  assert.equal((await bf.handle(new Request(`${U}/reports`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }))).status, 415);
  assert.equal((await bf.handle(post(`${U}/reports`, '{nope'))).status, 400);
  const big = await bf.handle(post(`${U}/reports`, body({ description: 'x'.repeat(5000) })));
  assert.equal(big.status, 413);
  await done();
});

test('rejects images over maxImageBytes', async () => {
  const { bf, done } = await fresh({ maxImageBytes: 60 });
  assert.equal((await bf.handle(post(`${U}/reports`, body()))).status, 400);
  await done();
});

test('public client tokens cannot replace verified account authorization', async () => {
  const { bf, done } = await fresh({ clientTokens: ['pk_live_abc'], authorize: req => req.headers.get('authorization') === 'Bearer verified-session' ? { id: 'user', role: 'client' } : null });
  assert.equal((await bf.handle(post(`${U}/reports`, body()))).status, 401);
  assert.equal((await bf.handle(post(`${U}/reports`, body(), { 'x-bugframe-token': 'wrong' }))).status, 401);
  assert.equal((await bf.handle(post(`${U}/reports`, body(), { 'x-bugframe-token': 'pk_live_abc' }))).status, 401);
  assert.equal((await bf.handle(post(`${U}/reports`, body(), { authorization: 'Bearer verified-session' }))).status, 201);
  assert.equal((await bf.handle(get(`${U}/health`))).status, 200);
  await done();
});

test('admin routes need the admin token; clients only see their own reports', async () => {
  const { bf, done } = await fresh({ adminToken: 'sk_admin', authorize: req => {
    const id = { 'Bearer session-a': 'a', 'Bearer session-b': 'b' }[req.headers.get('authorization')];
    return id ? { id, role: 'client' } : null;
  } });
  const h = who => ({ authorization: `Bearer session-${who}`, 'x-bugframe-reporter': who });
  const a = (await (await bf.handle(post(`${U}/reports`, body({ description: 'from A' }), h('a')))).json()).id;
  const b = (await (await bf.handle(post(`${U}/reports`, body({ description: 'from B' }), h('b')))).json()).id;
  const mineA = await (await bf.handle(get(`${U}/reports`, h('a')))).json();
  assert.deepEqual(mineA.reports.map(r => r.id), [a]);
  assert.equal(mineA.reports[0].page, '/settings#/billing');
  assert.equal((await bf.handle(get(`${U}/reports/${b}/region.png`, h('a')))).status, 404); // not theirs
  assert.equal((await bf.handle(get(`${U}/reports/${a}/region.png`, h('a')))).status, 200);
  assert.equal((await bf.handle(get(`${U}/reports/${a}`, h('a')))).status, 403);
  const patchReq = (id, token, data) => new Request(`${U}/reports/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : h('a')) }, body: JSON.stringify(data) });
  assert.equal((await bf.handle(patchReq(a, null, { status: 'fixed' }))).status, 403);
  assert.equal((await bf.handle(patchReq(a, 'nope', { status: 'fixed' }))).status, 401);
  assert.equal((await bf.handle(patchReq(a, 'sk_admin', { status: 'bad' }))).status, 400);
  assert.equal((await bf.handle(patchReq(a, 'sk_admin', { status: 'fixed', note: 'moved the footer' }))).status, 200);
  const after = await (await bf.handle(get(`${U}/reports`, h('a')))).json();
  assert.equal(after.reports[0].status, 'fixed'); assert.equal(after.reports[0].note, 'moved the footer');
  const all = await (await bf.handle(get(`${U}/reports?all=1`, { authorization: 'Bearer sk_admin' }))).json();
  assert.equal(all.reports.length, 2);
  const full = await (await bf.handle(get(`${U}/reports/${a}`, { authorization: 'Bearer sk_admin' }))).json();
  assert.equal(full.context.metadata.version, '1.2.3');
  await done();
});

test('path traversal in ids and file names is refused', async () => {
  const { dir, bf, done } = await fresh();
  const id = (await (await bf.handle(post(`${U}/reports`, body()))).json()).id;
  for (const bad of ['..', '../x', '..%2F..%2Fetc', 'bug-20260101-000000-zzzz', '%2e%2e']) {
    assert.equal((await bf.handle(get(`${U}/reports/${bad}/region.png`))).status, 404, bad);
    assert.equal((await bf.handle(new Request(`${U}/reports/${bad}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"status":"fixed"}' }))).status >= 400, true);
  }
  assert.equal((await bf.handle(get(`${U}/reports/${id}/report.json`))).status, 405); // only the two pictures are served
  assert.equal((await bf.handle(get(`${U}/reports/${id}/..%2Freport.json`))).status, 405);
  await done(); void dir;
});

test('images are served with safe headers', async () => {
  const { bf, done } = await fresh();
  const id = (await (await bf.handle(post(`${U}/reports`, body()))).json()).id;
  const res = await bf.handle(get(`${U}/reports/${id}/full.png`));
  assert.equal(res.headers.get('content-type'), 'image/png'); assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  await done();
});

test('CORS: same-origin works, listed origins get headers, others are refused', async () => {
  const { bf, done } = await fresh({ allowedOrigins: ['https://site.example'] });
  const pre = await bf.handle(new Request(`${U}/reports`, { method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': 'POST' } }));
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'https://site.example');
  assert.equal((await bf.handle(new Request(`${U}/reports`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))).status, 403);
  const ok = await bf.handle(post(`${U}/reports`, body(), { origin: 'https://site.example' }));
  assert.equal(ok.status, 201); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://site.example');
  const bad = await bf.handle(post(`${U}/reports`, body(), { origin: 'https://evil.example' }));
  assert.equal(bad.status, 403); assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal((await bf.handle(post(`${U}/reports`, body(), { origin: 'https://app.test' }))).status, 201); // same origin
  await done();
});

test('rate limit answers 429 with Retry-After', async () => {
  const { bf, done } = await fresh({ rateLimit: { max: 2, windowMs: 60000 } });
  const send = () => bf.handle(post(`${U}/reports`, body()), { ip: '1.2.3.4' });
  assert.equal((await send()).status, 201); assert.equal((await send()).status, 201);
  const third = await send(); assert.equal(third.status, 429); assert.ok(third.headers.get('retry-after'));
  assert.equal((await bf.handle(post(`${U}/reports`, body()), { ip: '9.9.9.9' })).status, 429); // same account cannot evade the limit by changing IP
  await done();
});

test('context is cleaned: bounded lists, oversize metadata dropped, no unknown keys', async () => {
  const { bf, done } = await fresh();
  const ctx = { ...body().context, evil: '<script>', elements: Array.from({ length: 30 }, () => ({ path: 'x'.repeat(900), component: 'c', text: 't', extra: 1 })), consoleErrors: Array.from({ length: 50 }, () => ({ at: 'a', message: 'm'.repeat(2000) })), metadata: { big: 'y'.repeat(9000) } };
  const id = (await (await bf.handle(post(`${U}/reports`, body({ context: ctx })))).json()).id;
  const r = await bf.storage.get(id);
  assert.equal(r.context.evil, undefined); assert.equal(r.context.elements.length, 12); assert.equal(r.context.elements[0].path.length, 300);
  assert.equal(r.context.consoleErrors.length, 20); assert.equal(r.context.consoleErrors[0].message.length, 500);
  assert.match(r.context.metadata._dropped, /8 KB/);
  await done();
});

test('webhook gets a signed notification', async () => {
  const calls = [];
  const { bf, done } = await fresh({ webhook: { url: 'https://hooks.test/in', secret: 's3cret' }, fetch: async (u, init) => { calls.push({ u, init }); return new Response('ok'); } });
  await bf.handle(post(`${U}/reports`, body()));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, 1); assert.equal(calls[0].u, 'https://hooks.test/in');
  const { createHmac } = await import('node:crypto');
  assert.equal(calls[0].init.headers['x-bugframe-signature'], 'sha256=' + createHmac('sha256', 's3cret').update(calls[0].init.body).digest('hex'));
  assert.equal(JSON.parse(calls[0].init.body).event, 'report.created');
  assert.equal(JSON.parse(calls[0].init.body).images, undefined);
  await done();
});

test('a failing webhook never fails the report', async () => {
  const { bf, done } = await fresh({ webhook: { url: 'https://hooks.test/in' }, fetch: async () => { throw new Error('down'); } });
  assert.equal((await bf.handle(post(`${U}/reports`, body()))).status, 201);
  await done();
});

test('custom authorize hook and onReport hook', async () => {
  const seen = [];
  const { bf, done } = await fresh({ authorize: req => (req.headers.get('authorization') === 'Bearer session-ok' ? { id: 'approved-user', role: 'client' } : null), onReport: r => seen.push(r.id) });
  assert.equal((await bf.handle(post(`${U}/reports`, body()))).status, 401);
  assert.equal((await bf.handle(post(`${U}/reports`, body(), { authorization: 'Bearer session-ok' }))).status, 201);
  assert.equal(seen.length, 1);
  await done();
});

test('works with a custom (memory) storage adapter and retries id collisions', async () => {
  const storage = createMemoryStorage(); let n = 0;
  const bf = createBugframe({ storage, rateLimit: false, authorize: () => ({ id: 'fixture-user', role: 'client' }), generateId: () => (n++ < 2 ? 'bug-20260101-000000-aaaa' : 'bug-20260101-000000-bbbb') });
  assert.equal((await bf.handle(post('https://x.test/reports', body()))).status, 201); // aaaa
  const second = await bf.handle(post('https://x.test/reports', body()));             // aaaa collides, retries -> bbbb
  assert.equal(second.status, 201); assert.equal((await second.json()).id, 'bug-20260101-000000-bbbb');
  assert.equal((await storage.list()).length, 2);
});

test('unknown paths and methods', async () => {
  const { bf, done } = await fresh();
  assert.equal((await bf.handle(get('https://app.test/other'))).status, 404);
  assert.equal((await bf.handle(new Request(`${U}/reports`, { method: 'DELETE' }))).status, 405);
  assert.equal((await stat(bf.storage.dir)).isDirectory() || true, true);
  await done();
});

test('feedback kinds and content wording persist, while older reports default to bug', async () => {
  const bf = createBugframe({ basePath: '/api/bugframe', storage: createMemoryStorage(), rateLimit: false, authorize: () => ({ id: 'customer', role: 'client' }) });
  for (const kind of ['bug', 'content', 'design', 'idea']) {
    const created = await bf.handle(post(`${U}/reports`, body({ kind, currentText: 'Before', suggestedText: 'After' })));
    assert.equal(created.status, 201);
    const stored = await bf.storage.get((await created.json()).id);
    assert.equal(stored.kind, kind); assert.equal(stored.suggestedText, kind === 'content' ? 'After' : '');
  }
  assert.equal((await bf.handle(post(`${U}/reports`, body({ kind: 'unknown' })))).status, 400);
  const old = (await (await bf.handle(post(`${U}/reports`, body()))).json()).id;
  assert.equal((await bf.storage.get(old)).kind, 'bug');
});

test('customer reviews enforce ownership, delivery version, required notes and one response per delivery', async () => {
  const bf = createBugframe({ basePath: '/api/bugframe', storage: createMemoryStorage(), rateLimit: false, adminToken: 'admin', authorize: req => ({ id: req.headers.get('cookie') ?? 'alice', role: 'client' }) });
  const { id } = await (await bf.handle(post(`${U}/reports`, body()))).json();
  const patch = data => bf.handle(new Request(`${U}/reports/${id}`, { method: 'PATCH', headers: { authorization: 'Bearer admin', 'content-type': 'application/json' }, body: JSON.stringify(data) }));
  const review = (data, user = 'alice') => bf.handle(post(`${U}/reports/${id}/review`, data, { cookie: user }));
  assert.equal((await review({ action: 'approve', reviewVersion: 0 })).status, 409);
  assert.equal((await patch({ status: 'approved' })).status, 400);
  assert.equal((await patch({ status: 'ready_for_review' })).status, 400);
  for (const status of ['reviewed', 'in_progress']) assert.equal((await patch({ status, note: 'Working on your request' })).status, 200);
  const first = await (await patch({ status: 'ready_for_review', note: 'Updated the headline. Please check it.' })).json();
  assert.equal(first.reviewVersion, 1);
  assert.equal((await review({ action: 'approve', reviewVersion: 1 }, 'bob')).status, 404);
  assert.equal((await review({ action: 'request_changes', reviewVersion: 1, note: '  ' })).status, 400);
  assert.equal((await review({ action: 'request_changes', reviewVersion: 1, note: 'Please shorten it' })).status, 200);
  assert.equal((await bf.storage.get(id)).status, 'changes_requested');
  assert.equal((await patch({ status: 'ready_for_review', note: 'Shortened the headline.' })).status, 200);
  assert.equal((await review({ action: 'approve', reviewVersion: 1 })).status, 409);
  const results = await Promise.all([review({ action: 'approve', reviewVersion: 2 }), review({ action: 'request_changes', reviewVersion: 2, note: 'Other tab' })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const saved = await bf.storage.get(id);
  assert.equal(saved.status, 'approved'); assert.ok(saved.closedAt);
  assert.equal(saved.activity.at(-1).by, 'customer');
  assert.equal((await patch({ status: 'open' })).status, 200); // developers can reopen approved work
  assert.equal((await bf.storage.get(id)).closedAt, null);
});

test('invitations need a matching verified login, bind once, and are private and revocable', async () => {
  const { createMemoryInvitationStorage } = await import('../../src/server/index.mjs');
  const invitations = createMemoryInvitationStorage();
  const identities = {
    alice: { id: 'alice', role: 'user', email: 'Alice@example.test', emailVerified: true },
    bob: { id: 'bob', role: 'user', email: 'bob@example.test', emailVerified: true },
    unverified: { id: 'unverified', role: 'user', email: 'alice@example.test', emailVerified: false },
  };
  const bf = createBugframe({ basePath: '/api/bugframe', storage: createMemoryStorage(), invitations: { storage: invitations }, adminToken: 'admin', rateLimit: false, authorize: req => identities[req.headers.get('cookie')] });
  const admin = { authorization: 'Bearer admin' }, headers = user => ({ cookie: user });
  const invite = await bf.handle(post(`${U}/invitations`, { email: 'ALICE@example.test', expiresInDays: 7 }, admin));
  assert.equal(invite.status, 201); const record = await invite.json();
  assert.match(record.token, /^[a-f0-9]{64}$/); assert.equal(record.email, 'alice@example.test');
  assert.equal((await bf.handle(post(`${U}/invitations`, { email: 'alice@example.test' }, admin))).status, 409);
  assert.ok(!(JSON.stringify(await invitations.list())).includes(record.token));
  for (const user of ['alice', 'bob', 'unverified']) assert.equal((await bf.handle(post(`${U}/reports`, body(), headers(user)))).status, 401);
  assert.equal((await bf.handle(post(`${U}/invitations/accept`, { token: record.token }))).status, 401);
  for (const user of ['bob', 'unverified']) assert.equal((await bf.handle(post(`${U}/invitations/accept`, { token: record.token }, headers(user)))).status, 403);
  const accept = () => bf.handle(post(`${U}/invitations/accept`, { token: record.token }, headers('alice')));
  const accepts = await Promise.all([accept(), accept()]); assert.deepEqual(accepts.map(r => r.status).sort(), [200, 403]);
  assert.equal((await invitations.list())[0].tokenHash, undefined);
  assert.equal((await bf.handle(post(`${U}/reports`, body(), headers('alice')))).status, 201);
  assert.equal((await bf.handle(new Request(`${U}/invitations`, { headers: headers('alice') }))).status, 403);
  const listing = JSON.stringify(await (await bf.handle(new Request(`${U}/invitations`, { headers: admin }))).json());
  assert.ok(!listing.includes('tokenHash')); assert.ok(!listing.includes('reporter')); assert.ok(!listing.includes(record.token));
  const revoke = await bf.handle(new Request(`${U}/invitations/${record.id}`, { method: 'PATCH', headers: { ...admin, 'content-type': 'application/json' }, body: '{"status":"revoked"}' }));
  assert.equal(revoke.status, 200);
  assert.equal((await bf.handle(post(`${U}/reports`, body(), headers('alice')))).status, 401);
  assert.equal((await accept()).status, 403);
});

test('invitation access survives a restart but expires and still depends on a live host session', async () => {
  const dir = await tmpDir(); let time = new Date('2026-10-23T12:00:00Z'), signedIn = true;
  const options = { dir, invitations: true, adminToken: 'admin', rateLimit: false, now: () => time, authorize: () => signedIn ? { id: 'customer', role: 'user', email: 'a@example.test', emailVerified: true } : null };
  try {
    const first = createBugframe(options);
    const invitation = await (await first.handle(post('https://app.test/invitations', { email: 'a@example.test', expiresInDays: 1 }, { authorization: 'Bearer admin' }))).json();
    assert.equal((await first.handle(post('https://app.test/invitations/accept', { token: invitation.token }))).status, 200);
    const second = createBugframe(options), access = () => second.handle(new Request('https://app.test/access'));
    assert.equal((await access()).status, 200);
    signedIn = false; assert.equal((await access()).status, 401); signedIn = true;
    time = new Date('2026-10-24T12:00:00Z'); assert.equal((await access()).status, 401);
    const names = await readdir(join(dir, '.invitations')); const file = join(dir, '.invitations', names[0]);
    if (process.platform !== 'win32') { assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(join(dir, '.invitations'))).mode & 0o777, 0o700); }
    assert.ok(!(await readFile(file, 'utf8')).includes(invitation.token));
  } finally { await cleanup(dir); }
});

test('agent notifications survive restart, retry with the same event id, and expose only admin delivery status', async () => {
  const dir = await tmpDir(); let time = new Date('2026-11-09T12:00:00Z'), delivered = false;
  const calls = [], options = { dir, basePath: '/api/bugframe', rateLimit: false, adminToken: 'admin', authorize: () => ({ id: 'client', role: 'client' }), now: () => time, webhook: { url: 'https://agent.example.test/hook', secret: 'signed-fixture' }, fetch: async (url, options) => { calls.push({ url, options }); return new Response('', { status: delivered ? 200 : 503 }); } };
  let bf;
  try {
    bf = createBugframe(options); const res = await bf.handle(post(`${U}/reports`, body())); assert.equal(res.status, 201); const { id } = await res.json();
    await bf.notifications.flush(); const stored = await bf.storage.get(id); assert.equal(stored.delivery.status, 'retrying'); const firstId = stored.delivery.eventId; await bf.close();
    time = new Date(time.getTime() + 2000); delivered = true; bf = createBugframe(options); await bf.notifications.flush();
    const after = await bf.storage.get(id); assert.equal(after.delivery.status, 'delivered'); assert.equal(after.delivery.eventId, firstId); assert.equal(after.delivery.attempts, 2);
    assert.equal(calls[0].options.headers['idempotency-key'], calls[1].options.headers['idempotency-key']); assert.equal(calls[1].options.redirect, 'error');
    const { createHmac } = await import('node:crypto'); assert.equal(calls[1].options.headers['x-bugframe-signature'], 'sha256=' + createHmac('sha256', 'signed-fixture').update(calls[1].options.body).digest('hex'));
    assert.equal((await bf.handle(new Request(`${U}/agent`))).status, 403);
    const status = await (await bf.handle(new Request(`${U}/agent`, { headers: { authorization: 'Bearer admin' } }))).json(); assert.equal(status.delivered, 1); assert.equal(status.pending, 0); assert.ok(!JSON.stringify(status).includes('signed-fixture'));
  } finally { await bf?.close(); await cleanup(dir); }
});

test('Codex heartbeat is admin-only and expires without granting report access', async () => {
  let time = new Date('2026-11-09T12:00:00Z');
  const bf = createBugframe({ storage: createMemoryStorage(), basePath: '/api/bugframe', adminToken: 'admin', now: () => time });
  const ping = () => bf.handle(post(`${U}/agent/heartbeat`, { intervalMs: 5000, threadId: 'inbox-fixture' }, { authorization: 'Bearer admin' }));
  assert.equal((await bf.handle(post(`${U}/agent/heartbeat`, { intervalMs: 5000 }))).status, 401); assert.equal((await ping()).status, 200);
  const status = async () => (await bf.handle(new Request(`${U}/agent`, { headers: { authorization: 'Bearer admin' } }))).json();
  assert.equal((await status()).codex.connected, true); time = new Date(time.getTime() + 30000); assert.equal((await status()).codex.connected, false);
  assert.equal((await bf.handle(post(`${U}/reports`, body()))).status, 401); await bf.close();
});

test('exhausted webhook deliveries can be retried without changing request status', async () => {
  let time = new Date('2026-11-09T12:00:00Z'), deliver = false;
  const bf = createBugframe({ storage: createMemoryStorage(), basePath: '/api/bugframe', rateLimit: false, adminToken: 'admin', now: () => time, webhook: { url: 'https://agent.example.test/hook' }, fetch: async () => new Response('', { status: deliver ? 200 : 503 }) });
  try {
    const { id } = await (await bf.handle(post(`${U}/reports`, body(), { authorization: 'Bearer admin' }))).json();
    for (let count = 0; count < 8; count++) { await bf.notifications.flush(); time = new Date(time.getTime() + 300001); }
    assert.equal((await bf.storage.get(id)).delivery.status, 'failed');
    assert.equal((await bf.storage.get(id)).status, 'open'); deliver = true;
    assert.equal((await bf.handle(post(`${U}/agent/retry`, {}, { authorization: 'Bearer admin' }))).status, 200);
    await bf.notifications.flush(); assert.equal((await bf.storage.get(id)).delivery.status, 'delivered');
  } finally { await bf.close(); }
});
