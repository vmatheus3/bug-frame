import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBugframe, toNodeListener } from '../../src/server/index.mjs';
import { PNG_B64, body, cleanup, post, tmpDir } from '../helpers.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../src/cli/bin.mjs');
const ENV = { ...process.env, BUGFRAME_REMOTE_TOKEN: 'adm' }; delete ENV.BUGFRAME_REMOTE; delete ENV.BUGFRAME_DIR; delete ENV.BUGFRAME_ADMIN_TOKEN;
const run = (args, env = {}) => promisify(execFile)('node', [BIN, ...args], { env: { ...ENV, ...env } }).then(r => r.stdout.trim(), e => { e.message = `${e.stderr}`; throw e; });
const listen = server => new Promise(res => server.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${server.address().port}`)));
const seed = async dir => {
  const bf = createBugframe({ dir, rateLimit: false, authorize: () => ({ id: 'remote-fixture', role: 'client' }) });
  const mk = async (description, url) => (await (await bf.handle(post('https://x.test/reports', body({ description, context: { ...body().context, url } })))).json()).id;
  return { a: await mk('Footer overlaps the button', 'https://app.test/settings#/billing'), b: await mk('Wrong total on invoice', 'https://app.test/invoices?id=4'), c: await mk('Another settings issue', 'https://app.test/settings#/billing') };
};

test('remote mode: list, show, export, close, reopen against a hosted server', async () => {
  const serverDir = await tmpDir(), local = await tmpDir(); const { a, b, c } = await seed(serverDir);
  const bf = createBugframe({ dir: serverDir, basePath: '/api/bugframe', adminToken: 'adm' });
  const server = createServer(toNodeListener(bf)); const api = `${await listen(server)}/api/bugframe`;
  const remote = (...args) => run(['--dir', local, '--remote', `${api}/`, ...args]);
  try {
    const listing = await remote('list');
    assert.match(listing, new RegExp(a)); assert.match(listing, /\/settings#\/billing/); assert.match(listing, /Wrong total on invoice/);
    assert.equal(JSON.parse(await remote('list', '--json')).length, 3);
    assert.deepEqual(await readdir(local), []); // listing downloads nothing

    const shown = await remote('show', b);
    assert.match(shown, /Console errors/); assert.match(shown, /"version":"1.2.3"/);
    await access(shown.match(/Region picture: (.+)/)[1]); // show downloads the report it prints

    assert.match(await remote('export'), /3 reports \(downloaded from http:\/\/127\.0\.0\.1:\d+\/api\/bugframe\)/);
    const md = await readFile(join(local, 'WORKLIST.md'), 'utf8');
    assert.match(md, /3 open across 2 pages/); assert.match(md, new RegExp(`\`bugframe --remote ${api} close <id>`));
    await access(join(local, md.match(/`([^`]+region\.png)`/)[1]));
    assert.equal(JSON.parse(await readFile(join(local, a, 'report.json'), 'utf8')).downloadedFrom, api);

    const copyOf = async id => JSON.parse(await readFile(join(local, id, 'report.json'), 'utf8'));
    assert.match(await remote('close', a, '--note', 'Moved the footer'), /fixed/);
    assert.match(await remote('close', b, '--note', 'Not reproducible', '--status', 'wontfix'), /wontfix/);
    assert.equal((await bf.storage.get(a)).note, 'Moved the footer'); assert.equal((await bf.storage.get(b)).status, 'wontfix');
    assert.equal((await copyOf(a)).status, 'fixed'); assert.equal((await copyOf(a)).note, 'Moved the footer'); // the downloaded copy follows
    assert.equal((await remote('list', '--open')).split('\n').length, 1);
    assert.match(await remote('reopen', a), /reopened/);
    const reopened = await bf.storage.get(a);
    assert.equal(reopened.status, 'open'); assert.equal(reopened.note, 'Moved the footer'); assert.equal(reopened.closedAt, null);
    assert.equal((await copyOf(a)).status, 'open');
    assert.match(await remote('export'), /2 reports/);
    // pointing --dir at the server's own folder must not turn its reports into copies
    await assert.rejects(() => run(['--dir', serverDir, '--remote', api, 'export']), /holds a report that was not downloaded/);
    assert.equal((await bf.storage.get(c)).downloadedFrom, undefined);

    // a downloaded copy only changes on the server, where the reporter reads the note
    await assert.rejects(() => run(['--dir', local, 'close', c, '--note', 'x']), new RegExp(`copy downloaded from ${api}\\. Change it on the server: bugframe --remote`));
    await assert.rejects(() => run(['--dir', local, 'reopen', b]), /copy downloaded from/);
    assert.equal((await bf.storage.get(c)).status, 'open');
    assert.match(await run(['--dir', local, 'list', '--open'], { BUGFRAME_REMOTE: api }), new RegExp(c)); // the env var works like --remote
  } finally { server.close(); await cleanup(serverDir); await cleanup(local); }
});

test('remote mode refuses unsafe or wrong settings with plain errors', async () => {
  const dir = await tmpDir();
  const server = createServer(toNodeListener(createBugframe({ dir, adminToken: 'adm' }))); const api = await listen(server);
  const redirect = createServer((req, res) => { res.writeHead(302, { location: 'https://elsewhere.example/' }); res.end(); }); const moved = await listen(redirect);
  const remote = (url, ...args) => run(['--dir', dir, '--remote', url, ...args]);
  try {
    await assert.rejects(() => remote('http://bugs.example.com/api/bugframe', 'list'), /must use https:\/\//);
    await assert.rejects(() => remote('not a url', 'list'), /needs the API address/);
    await assert.rejects(() => run(['--dir', dir, '--remote', api, 'list'], { BUGFRAME_REMOTE_TOKEN: '' }), /needs the server's admin token/);
    // this machine's own server secret is never sent to a remote server
    await assert.rejects(() => run(['--dir', dir, '--remote', api, 'list'], { BUGFRAME_REMOTE_TOKEN: undefined, BUGFRAME_ADMIN_TOKEN: 'adm' }), /needs the server's admin token/);
    await assert.rejects(() => run(['--dir', dir, '--remote', api, 'lsit'], { BUGFRAME_REMOTE_TOKEN: '' }), /Unknown command "lsit"/);
    await assert.rejects(() => run(['--dir', dir, '--remote', api, 'show'], { BUGFRAME_REMOTE_TOKEN: '' }), /show needs an id/);
    await assert.rejects(() => remote(api, '--token', 'wrong', 'list'), /refused the admin token \(HTTP 401\)/);
    await assert.rejects(() => remote(`${api}/not-the-api`, 'list'), /did not answer like a Bugframe server/);
    await assert.rejects(() => remote(moved, 'list'), /answered with a redirect/);
    await assert.rejects(() => remote(api, 'close', 'bug-20260101-000000-aaaa', '--note', 'x'), /No report with id bug-20260101-000000-aaaa on http:/);
    await assert.rejects(() => remote(api, 'reopen', 'bug-20260101-000000-aaaa'), /No report with id/);
    await assert.rejects(() => remote(api, 'show', '../../etc/passwd'), /No report/);
    await assert.rejects(() => remote(api, 'import', 'report.zip'), /works on a local folder only/);
    await assert.rejects(() => remote(api, 'serve'), /works on a local folder only/);
    assert.equal(await remote(api, 'list'), 'No bug reports.');
    assert.match(await remote(api, 'export'), /No open bug reports on http:/);
  } finally { server.close(); redirect.close(); await cleanup(dir); }
  await assert.rejects(() => run(['--dir', dir, '--remote', api, 'list']), /Could not reach/);
});

test('remote mode checks what it downloads: report ids, fields and pictures', async () => {
  const id = 'bug-20260101-000000-abcd', closedMeanwhile = 'bug-20260101-000000-cdef', swapped = 'bug-20260101-000000-eeee', local = await tmpDir();
  let picture = Buffer.from('<html>not a picture</html>');
  const server = createServer((req, res) => {
    const send = (status, data, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer adm') return send(401, { error: 'unauthorized' });
    if (req.url === '/reports?all=1') return send(200, { reports: [{ id: '../../escaped', status: 'open', description: 'Path trick' }, { id, status: 'open', description: 'Real one', page: '/' }, { id: closedMeanwhile, status: 'open', description: 'Closed meanwhile' }] });
    if (req.url === `/reports/${id}`) return send(200, { id, status: 'open', description: 'Real one', types: 'not a list', context: { url: 'https://app.test/', elements: [{ path: 1, text: { not: 'text' } }] } });
    if (req.url === `/reports/${closedMeanwhile}`) return send(200, { id: closedMeanwhile, status: 'fixed', description: 'Closed meanwhile', context: { url: 'https://app.test/other' } });
    if (req.url === `/reports/${swapped}`) return send(200, { id, status: 'open', description: 'Someone else' });
    if (/^\/reports\/bug-[^/]+\/(region|full)\.png$/.test(req.url)) return send(200, picture, 'image/png');
    send(404, { error: 'not_found' });
  });
  const api = await listen(server);
  try {
    const listing = await run(['--dir', local, '--remote', api, 'list']);
    assert.doesNotMatch(listing, /escaped|Path trick/); assert.match(listing, /Real one/);
    // a broken picture skips that report instead of stopping the whole export
    assert.match(await run(['--dir', local, '--remote', api, 'export']), /No open bug reports on .*; skipped 2 \(.*sent a region\.png for bug-20260101-000000-abcd that is not a PNG/);
    assert.deepEqual(await readdir(local), ['WORKLIST.md']);
    await assert.rejects(() => run(['--dir', local, '--remote', api, 'show', id]), /not a PNG picture/);
    await assert.rejects(() => run(['--dir', local, '--remote', api, 'show', swapped]), /did not answer like a Bugframe server/);

    picture = Buffer.from(PNG_B64, 'base64');
    assert.match(await run(['--dir', local, '--remote', api, 'export']), /1 report \(/); // the one closed between list and download is left out
    assert.doesNotMatch(await readFile(join(local, 'WORKLIST.md'), 'utf8'), new RegExp(closedMeanwhile));
    const saved = JSON.parse(await readFile(join(local, id, 'report.json'), 'utf8'));
    assert.deepEqual(saved.types, []); assert.deepEqual(saved.context.elements, [{ path: '', component: '', text: '' }]);
  } finally { server.close(); await cleanup(local); }
});
