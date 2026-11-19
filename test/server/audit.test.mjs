import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createBugframe, createFileStorage, createMemoryStorage } from '../../src/server/index.mjs';
import { body, cleanup, post, tmpDir } from '../helpers.mjs';

const U = 'https://app.test/api/bugframe';
const users = { admin: { id: 'dev', role: 'admin' }, client: { id: 'customer', role: 'client' } };
const make = (opts = {}) => createBugframe({ basePath: '/api/bugframe', storage: createMemoryStorage(), rateLimit: false, adminToken: 'sk_admin', authorize: req => users[req.headers.get('cookie')] ?? null, ...opts });
const as = who => ({ cookie: who });
const audit = (over = {}) => body({ kind: 'audit', description: 'Page analysis requested', ...over });

test('page analysis (kind audit) is accepted only from administrators', async () => {
  const bf = make();
  const client = await bf.handle(post(`${U}/reports`, audit(), as('client')));
  assert.equal(client.status, 403);
  assert.equal((await bf.storage.list()).length, 0, 'a refused audit request stores nothing');
  const admin = await bf.handle(post(`${U}/reports`, audit(), as('admin')));
  assert.equal(admin.status, 201);
  const { id } = await admin.json();
  assert.equal((await bf.storage.get(id)).kind, 'audit');
  const token = await bf.handle(post(`${U}/reports`, audit(), { authorization: 'Bearer sk_admin' }));
  assert.equal(token.status, 201);
  // Ordinary kinds are unchanged for clients, and unknown kinds are still a 400.
  assert.equal((await bf.handle(post(`${U}/reports`, body({ kind: 'design' }), as('client')))).status, 201);
  assert.equal((await bf.handle(post(`${U}/reports`, body({ kind: 'nonsense' }), as('admin')))).status, 400);
  await bf.close();
});

test('file storage writes only allow-listed attachments and refuses traversal', async () => {
  const dir = await tmpDir();
  try {
    const s = createFileStorage({ dir }), id = 'bug-20260101-000001-aaaa';
    await s.create({ id, status: 'open', createdAt: '2026-01-01T00:00:00Z', description: 'd' }, { region: Buffer.from('a'), full: Buffer.from('b') });
    await s.writeAttachment(id, 'audit.md', Buffer.from('# Page audit'));
    await s.writeAttachment(id, 'audit.json', Buffer.from('{}'));
    assert.equal((await s.readFile(id, 'audit.md')).toString(), '# Page audit');
    for (const bad of ['../audit.md', 'audit.md/../../x', 'report.json', 'region.png', 'AUDIT.MD', 'audit.html', '', '/etc/passwd', 'audit.md\0.png']) {
      await assert.rejects(() => s.writeAttachment(id, bad, Buffer.from('x')), bad);
      if (bad !== 'region.png') assert.equal(await s.readFile(id, bad), null, bad);
    }
    assert.equal((await s.readFile(id, 'region.png')).toString(), 'a', 'the screenshot was not overwritten');
    for (const badId of ['../bug-20260101-000001-aaaa', 'bug-1', '/tmp']) await assert.rejects(() => s.writeAttachment(badId, 'audit.md', Buffer.from('x')), badId);
    await assert.rejects(() => s.writeAttachment('bug-20260101-000009-ffff', 'audit.md', Buffer.from('x')), 'no report, no attachment');
    await assert.rejects(() => s.writeAttachment(id, 'audit.md', Buffer.alloc(3 * 1024 * 1024)), 'size cap');
    assert.deepEqual((await readdir(join(dir, id))).sort(), ['audit.json', 'audit.md', 'full.png', 'region.png', 'report.json']);
    assert.deepEqual(await readdir(dir), [id]);
    const m = createMemoryStorage();
    await m.create({ id, status: 'open' }, { region: Buffer.from('a'), full: Buffer.from('b') });
    await m.writeAttachment(id, 'audit.md', Buffer.from('m'));
    assert.equal((await m.readFile(id, 'audit.md')).toString(), 'm');
    await assert.rejects(() => m.writeAttachment(id, 'report.json', Buffer.from('x')));
    assert.equal(await m.readFile(id, 'report.json'), null);
  } finally { await cleanup(dir); }
});

test('GET /reports/:id/audit.md is admin-only, markdown, nosniff, no-store and sandboxed', async () => {
  const bf = make();
  const { id } = await (await bf.handle(post(`${U}/reports`, audit(), as('admin')))).json();
  assert.equal((await bf.handle(new Request(`${U}/reports/${id}/audit.md`, { headers: as('admin') }))).status, 404, 'not written yet');
  await bf.storage.writeAttachment(id, 'audit.md', Buffer.from('# Page audit: <script>alert(1)</script>'));
  const res = await bf.handle(new Request(`${U}/reports/${id}/audit.md`, { headers: as('admin') }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.match(await res.text(), /^# Page audit/);
  assert.equal((await bf.handle(new Request(`${U}/reports/${id}/audit.md`, { headers: as('client') }))).status, 403);
  assert.equal((await bf.handle(new Request(`${U}/reports/${id}/audit.md`))).status, 401);
  assert.equal((await bf.handle(new Request(`${U}/reports/${id}/audit.json`, { headers: as('admin') }))).status, 405, 'audit.json is not served');
  assert.equal((await bf.handle(new Request(`${U}/reports/..%2F..%2Fx/audit.md`, { headers: as('admin') }))).status, 404);
  await bf.close();
});

test('custom storage without writeAttachment keeps working and audit.md is simply absent', async () => {
  const memory = createMemoryStorage();
  const legacy = { create: memory.create, get: memory.get, list: memory.list, update: memory.update, readFile: async (id, name) => { if (!['region.png', 'full.png'].includes(name)) throw new Error('legacy adapter got ' + name); return memory.readFile(id, name); } };
  const bf = make({ storage: legacy });
  const { id } = await (await bf.handle(post(`${U}/reports`, audit(), as('admin')))).json();
  const res = await bf.handle(new Request(`${U}/reports/${id}/audit.md`, { headers: as('admin') }));
  assert.equal(res.status, 404);
  assert.equal((await bf.handle(new Request(`${U}/reports/${id}/full.png`, { headers: as('admin') }))).status, 200);
  await bf.close();
});

const put = (url, data, headers = {}) => new Request(url, { method: 'PUT', headers: { 'content-type': 'text/markdown', ...headers }, body: data });
const patchJson = (url, data, headers = {}) => new Request(url, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });

test('an administrator can upload a page-analysis result for an audit request, and nobody and nothing else', async () => {
  const bf = make({ maxAttachmentBytes: undefined });
  const { id } = await (await bf.handle(post(`${U}/reports`, audit(), as('admin')))).json();
  const bug = (await (await bf.handle(post(`${U}/reports`, body(), as('client')))).json()).id;
  const admin = { authorization: 'Bearer sk_admin' };
  // Refused: no login, a customer, another kind of request, another file name, a body that is not text or JSON, too big.
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.md`, '# x'))).status, 401);
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.md`, '# x', as('client')))).status, 403);
  assert.equal((await bf.handle(put(`${U}/reports/${bug}/audit.md`, '# x', admin))).status, 409, 'only page-analysis requests take a result');
  for (const name of ['report.json', 'region.png', 'audit.html', 'evil.md', 'audit.md.png']) assert.ok([404, 405].includes((await bf.handle(put(`${U}/reports/${id}/${name}`, 'x', admin))).status), name);
  assert.equal((await bf.handle(put(`${U}/reports/bug-20990101-000000-ffff/audit.md`, '# x', admin))).status, 404);
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.md`, 'bad\0bytes', admin))).status, 400);
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.json`, 'not json', { ...admin, 'content-type': 'application/json' }))).status, 400);
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.md`, 'x', { ...admin, 'content-type': 'text/html' }))).status, 415);
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.md`, 'x'.repeat(2 * 1024 * 1024 + 1), admin))).status, 413);
  assert.equal((await bf.storage.get(id)).files.audit, undefined, 'a refused upload changes nothing');
  assert.equal(await bf.storage.readFile(id, 'audit.md'), null);
  // Accepted: stored through the adapter's allow-list, linked from the request, served back as text only.
  const md = '# Page audit: https://app.test/\n\nVerdict: fine.\n';
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.md`, md, admin))).status, 200);
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.json`, '{"url":"https://app.test/"}', { ...admin, 'content-type': 'application/json' }))).status, 200);
  assert.equal((await bf.storage.get(id)).files.audit, 'audit.md');
  const served = await bf.handle(new Request(`${U}/reports/${id}/audit.md`, { headers: admin }));
  assert.equal(await served.text(), md); assert.match(served.headers.get('content-type'), /^text\/markdown/); assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  // A browser on another site can never upload: PUT is not offered to cross-origin callers.
  const cross = await bf.handle(new Request(`${U}/reports/${id}/audit.md`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } }));
  assert.equal(cross.status, 403);
  assert.equal((await bf.handle(put(`${U}/reports/${id}/audit.md`, '# x', { ...as('admin'), origin: 'https://evil.example' }))).status, 403);
  // A storage adapter that never opted in to attachments is not written to.
  const plain = createMemoryStorage(); delete plain.writeAttachment;
  const bf2 = make({ storage: plain }), second = (await (await bf2.handle(post(`${U}/reports`, audit(), as('admin')))).json()).id;
  assert.equal((await bf2.handle(put(`${U}/reports/${second}/audit.md`, '# x', admin))).status, 404);
  await bf.close(); await bf2.close();
});

test('the watcher\'s bookkeeping (attempts, counts) is accepted only for audit requests and only in a fixed shape', async () => {
  const bf = make(), admin = { authorization: 'Bearer sk_admin' };
  const { id } = await (await bf.handle(post(`${U}/reports`, audit(), as('admin')))).json();
  const bug = (await (await bf.handle(post(`${U}/reports`, body(), as('client')))).json()).id;
  const ok = await bf.handle(patchJson(`${U}/reports/${id}`, { status: 'in_progress', note: 'Page analysis running (attempt 1 of 3).', audit: { attempts: 1, startedAt: '2026-01-01T00:00:00.000Z', degraded: false, counts: { blocker: 0, high: 2, medium: 1, low: 0 }, lastError: 'x'.repeat(900), extra: '<script>', noteOnly: true } }, admin));
  assert.equal(ok.status, 200);
  const stored = (await bf.storage.get(id)).audit;
  assert.deepEqual(Object.keys(stored).sort(), ['attempts', 'counts', 'degraded', 'lastError', 'noteOnly', 'startedAt']);
  assert.equal(stored.lastError.length, 300); assert.equal(stored.attempts, 1); assert.deepEqual(stored.counts, { blocker: 0, high: 2, medium: 1, low: 0 });
  for (const bad of [{ attempts: -1 }, { attempts: 1.5 }, { attempts: 99 }, { attempts: '1' }, 'x', [1], { attempts: 1, counts: { high: -2 } }, { attempts: 1, startedAt: 'yesterday' }])
    assert.equal((await bf.handle(patchJson(`${U}/reports/${id}`, { status: 'open', note: 'n', audit: bad }, admin))).status, 400, JSON.stringify(bad));
  assert.equal((await bf.handle(patchJson(`${U}/reports/${bug}`, { status: 'reviewed', note: 'n', audit: { attempts: 1 } }, admin))).status, 400, 'not on ordinary feedback');
  assert.equal((await bf.handle(patchJson(`${U}/reports/${id}`, { status: 'open', note: 'n', audit: { attempts: 0 } }, as('client')))).status, 403);
  // A status change without the field leaves the bookkeeping alone.
  await bf.handle(patchJson(`${U}/reports/${id}`, { status: 'reviewed', note: 'seen' }, admin));
  assert.equal((await bf.storage.get(id)).audit.attempts, 1);
  await bf.close();
});
