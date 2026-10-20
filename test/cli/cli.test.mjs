import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBugframe } from '../../src/server/index.mjs';
import { PNG_B64, body, cleanup, post, tmpDir } from '../helpers.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../src/cli/bin.mjs');
const run = (dir, ...args) => promisify(execFile)('node', [BIN, '--dir', dir, ...args]).then(r => r.stdout.trim(), e => { e.message = `${e.stderr}`; throw e; });
const seed = async dir => {
  const bf = createBugframe({ dir, rateLimit: false, authorize: () => ({ id: 'cli-fixture', role: 'client' }) });
  const mk = async (description, url, extra = {}) => (await (await bf.handle(post('https://x.test/reports', body({ description, context: { ...body().context, url, ...extra } })))).json()).id;
  const a = await mk('Footer overlaps the button', 'https://app.test/settings#/billing');
  const b = await mk('Wrong total on invoice', 'https://app.test/invoices?id=4');
  const c = await mk('Another settings issue', 'https://app.test/settings#/billing');
  return { a, b, c };
};

test('list, show, export, close, reopen end to end', async () => {
  const dir = await tmpDir(); const { a, b, c } = await seed(dir);
  const listing = await run(dir, 'list');
  assert.match(listing, new RegExp(a)); assert.match(listing, /Wrong total on invoice/);
  assert.equal(JSON.parse(await run(dir, 'list', '--json')).length, 3);

  const shown = await run(dir, 'show', b);
  assert.match(shown, /Region picture:/); assert.match(shown, /Console errors/); assert.match(shown, /"version":"1.2.3"/);

  const out = await run(dir, 'export'); assert.match(out, /3 reports/);
  const md = await readFile(join(dir, 'WORKLIST.md'), 'utf8');
  assert.match(md, /3 open across 2 pages/); assert.match(md, /## \/settings#\/billing/); assert.match(md, /## \/invoices/);
  assert.match(md, new RegExp(`${a}/region\\.png`)); assert.doesNotMatch(md, /token=SECRET/);
  // picture paths in the worklist are relative to the worklist and must exist
  await access(join(dir, md.match(/`([^`]+region\.png)`/)[1]));

  assert.match(await run(dir, 'close', a, '--note', 'Moved the footer'), /fixed/);
  assert.match(await run(dir, 'close', b, '--note', 'Not reproducible', '--status', 'wontfix'), /wontfix/);
  assert.equal((await run(dir, 'list', '--open')).split('\n').length, 1);
  assert.match(await run(dir, 'show', a), /Note: Moved the footer/);
  await run(dir, 'export', '--out', join(dir, 'out/W.md'));
  assert.match(await readFile(join(dir, 'out/W.md'), 'utf8'), /1 open across 1 page/);
  assert.match(await run(dir, 'export', '--all', '--out', join(dir, 'ALL.md')), /3 reports/);
  assert.match(await run(dir, 'reopen', a), /reopened/);
  assert.equal((await run(dir, 'list', '--open')).split('\n').length, 2);
  void c; await cleanup(dir);
});

test('errors are plain and exit non-zero', async () => {
  const dir = await tmpDir();
  await assert.rejects(() => run(dir, 'close', 'bug-20260101-000000-aaaa', '--note', 'x'), /No report with id/);
  await assert.rejects(() => run(dir, 'close', 'bug-20260101-000000-aaaa'), /needs --note/);
  await assert.rejects(() => run(dir, 'show'), /needs an id/);
  await assert.rejects(() => run(dir, 'show', '../../etc/passwd'), /No report/);
  await assert.rejects(() => run(dir, 'bogus'), /Unknown command/);
  assert.equal(await run(dir, 'list'), 'No bug reports.');
  assert.match(await run(dir, 'export'), /No open bug reports/);
  assert.match(await run(dir, '--help'), /Usage: bugframe/);
  await cleanup(dir);
});

test('serve refuses unconfigured authorization, public-token access and invalid auth modules', async () => {
  const dir = await tmpDir();
  try {
    await assert.rejects(() => run(dir, 'serve'), /requires BUGFRAME_ADMIN_TOKEN or --auth-module/);
    await assert.rejects(() => run(dir, 'serve', '--client-token', 'public'), /Public client tokens no longer authorize reporters/);
    const module = join(dir, 'invalid-auth.mjs');
    await writeFile(module, 'export const authorize = true;');
    await assert.rejects(() => run(dir, 'serve', '--auth-module', module), /must export an authorize/);
  } finally { await cleanup(dir); }
});

/** A stored (uncompressed) .zip, enough for `import`. */
const zip = files => {
  const parts = [], dir = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name), d = Buffer.from(data), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(d.length, 20); central.writeUInt32LE(d.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(off, 42);
    parts.push(local, n, d); dir.push(central, n); off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(dir), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
};

test('report text cannot send control characters to the terminal', async () => {
  const dir = await tmpDir();
  try {
    // color, window title, carriage return, an 8-bit CSI and DEL
    const evil = '\x1b[31mred\x1b]0;pwned\x07\r\u009b2J\x7f', description = `Broken ${evil}\nNote: fake field`;
    const bf = createBugframe({ dir, rateLimit: false, authorize: () => ({ id: 'cli-fixture', role: 'client' }) });
    const ctx = body().context;
    const { id } = await (await bf.handle(post('https://x.test/reports', body({ description, types: [`Layout${evil}`], context: { ...ctx,
      url: `https://app.test/a${evil}#/b${evil}`, title: `Title${evil}`, userAgent: `UA${evil}`, metadata: { v: evil },
      elements: [{ path: `div${evil}`, component: `c${evil}`, text: `Save${evil}` }], consoleErrors: [{ at: 'x', message: `boom${evil}` }] } })))).json();
    const png = Buffer.from(PNG_B64, 'base64'), imp = 'bug-20260101-000000-abcd', bad = 'bug-20260101-000000-dcba';
    await writeFile(join(dir, 'reports.zip'), zip({ [`${imp}/report.json`]: JSON.stringify({ createdAt: `2026${evil}`, description: `Imported${evil}` }),
      [`${imp}/region.png`]: png, [`${imp}/full.png`]: png, [`${bad}/report.json`]: evil, [`${bad}/region.png`]: png, [`${bad}/full.png`]: png }));

    const out = { import: await run(dir, 'import', join(dir, 'reports.zip')), list: await run(dir, 'list'), show: await run(dir, 'show', id),
      showImported: await run(dir, 'show', imp), export: await run(dir, 'export'), worklist: await readFile(join(dir, 'WORKLIST.md'), 'utf8'),
      listJson: await run(dir, 'list', '--json'), showJson: await run(dir, 'show', id, '--json') };
    await run(dir, 'close', id, '--note', `Fixed${evil}\nsecond line`);
    out.showClosed = await run(dir, 'show', id);
    assert.deepEqual(Object.keys(out).filter(k => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out[k])), []);

    assert.match(out.import, /Imported 1 report; skipped 1/); assert.match(out.show, /pwned/);
    assert.doesNotMatch(out.show, /^Note: fake field/m); // a line of the description cannot pose as a field
    assert.match(out.showClosed, /^Note: Fixed.*\n {2}second line/m);
    assert.equal(JSON.parse(out.showJson).description, description); // --json keeps the exact text, escaped
  } finally { await cleanup(dir); }
});
