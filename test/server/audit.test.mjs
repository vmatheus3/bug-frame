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
