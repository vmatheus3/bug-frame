import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBugframe, toNodeListener } from '../../src/server/index.mjs';
import { body, cleanup, tmpDir } from '../helpers.mjs';

const listen = server => new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));

test('node http listener: create, list, close over real HTTP', async () => {
  const dir = await tmpDir();
  const bf = createBugframe({ dir, adminToken: 'adm', rateLimit: false, authorize: req => req.headers.get('authorization') === 'Bearer test-session' ? { id: 'me', role: 'client' } : null });
  const server = createServer(toNodeListener(bf)); const port = await listen(server);
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) })).status, 401);
    const res = await fetch(`${base}/reports`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-session' }, body: JSON.stringify(body()) });
    assert.equal(res.status, 201); const { id } = await res.json();
    const list = await (await fetch(`${base}/reports`, { headers: { authorization: 'Bearer test-session' } })).json();
    assert.equal(list.reports[0].id, id);
    const img = await fetch(`${base}/reports/${id}/region.png`, { headers: { authorization: 'Bearer test-session' } });
    assert.equal(img.status, 200); assert.equal((await img.arrayBuffer()).byteLength > 30, true);
    const closed = await fetch(`${base}/reports/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer adm' }, body: JSON.stringify({ status: 'fixed', note: 'done' }) });
    assert.equal(closed.status, 200);
  } finally { server.close(); await cleanup(dir); }
});

test('express-style mount: next() for foreign paths, basePath for ours, parsed bodies accepted', async () => {
  const dir = await tmpDir();
  const bf = createBugframe({ dir, basePath: '/bugs', rateLimit: false, authorize: () => ({ id: 'express-fixture', role: 'client' }) });
  const listener = toNodeListener(bf);
  const server = createServer((req, res) => {
    // emulate express: req.originalUrl keeps the prefix
    req.originalUrl = req.url;
    listener(req, res, () => { res.statusCode = 200; res.end('app'); });
  });
  const port = await listen(server);
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/home`)).text(), 'app');
    const res = await fetch(`http://127.0.0.1:${port}/bugs/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    assert.equal(res.status, 201);
    const big = await fetch(`http://127.0.0.1:${port}/bugs/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body({ description: 'x'.repeat(30 * 1024 * 1024) })) });
    assert.equal(big.status, 413);
  } finally { server.close(); await cleanup(dir); }
});

test('proxy headers affect IP and protocol only when the adapter explicitly trusts the proxy', async () => {
  for (const trustProxy of [false, true]) {
    const protocols = [];
    const bf = createBugframe({ storage: (await import('../../src/server/index.mjs')).createMemoryStorage(), rateLimit: { max: 1 }, authorize: req => {
      protocols.push(new URL(req.url).protocol);
      return { id: req.headers.get('authorization'), role: 'client' };
    } });
    const server = createServer(toNodeListener(bf, { trustProxy })); const port = await listen(server);
    try {
      const send = n => fetch(`http://127.0.0.1:${port}/reports`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `account-${n}`, 'x-forwarded-for': `192.0.2.${n}, 192.0.2.9`, 'x-forwarded-proto': 'https, http' }, body: JSON.stringify(body()) });
      assert.equal((await send(1)).status, 201);
      assert.equal((await send(2)).status, trustProxy ? 201 : 429);
      assert.ok(protocols.every(value => value === (trustProxy ? 'https:' : 'http:')));
    } finally { server.close(); }
  }
});

test('every adapter carries the page-analysis upload (PUT): the Node listener over real HTTP and the route handlers', async () => {
  const { routeHandlers } = await import('../../src/server/index.mjs');
  const dir = await tmpDir();
  const bf = createBugframe({ dir, adminToken: 'adm', rateLimit: false });
  const server = createServer(toNodeListener(bf)); const port = await listen(server);
  try {
    const base = `http://127.0.0.1:${port}`, admin = { authorization: 'Bearer adm' };
    const { id } = await (await fetch(`${base}/reports`, { method: 'POST', headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify(body({ kind: 'audit', description: 'Page analysis requested' })) })).json();
    const put = await fetch(`${base}/reports/${id}/audit.md`, { method: 'PUT', headers: { 'content-type': 'text/markdown', ...admin }, body: '# Page audit: http://localhost/\n' });
    assert.equal(put.status, 200);
    assert.equal(await (await fetch(`${base}/reports/${id}/audit.md`, { headers: admin })).text(), '# Page audit: http://localhost/\n');
    assert.equal((await fetch(`${base}/reports/${id}/audit.md`, { method: 'PUT', headers: { 'content-type': 'text/markdown', ...admin }, body: 'x'.repeat(2 * 1024 * 1024 + 10) })).status, 413, 'the size limit holds for a streamed body');
    const handlers = routeHandlers(bf);
    assert.deepEqual(Object.keys(handlers).sort(), ['GET', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    const viaRoute = await handlers.PUT(new Request(`${base}/reports/${id}/audit.json`, { method: 'PUT', headers: { 'content-type': 'application/json', ...admin }, body: '{"ok":true}' }));
    assert.equal(viaRoute.status, 200);
  } finally { server.close(); server.closeAllConnections?.(); await bf.close(); await cleanup(dir); }
});
