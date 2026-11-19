import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBugframe } from '../../src/server/index.mjs';
import { body, cleanup, post, tmpDir } from '../helpers.mjs';

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
  assert.match(await run(dir, 'ready', a, '--note', 'Updated and deployed. Please review.'), /ready for customer review/);
  assert.equal(JSON.parse(await run(dir, 'show', a, '--json')).reviewVersion, 1);
  assert.match(await run(dir, 'ready', a, '--note', 'Second delivery'), /ready for customer review/);
  assert.equal(JSON.parse(await run(dir, 'show', a, '--json')).reviewVersion, 2);
  assert.match(await run(dir, 'export'), /1 report/); // waiting reviews are excluded from the coding worklist
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

test('setup uses website accounts with no customer password and preserves existing files', async () => {
  const { setupProject } = await import('../../src/cli/setup.mjs');
  const { stat } = await import('node:fs/promises');
  const dir = await tmpDir();
  try {
    const result = await setupProject({ project: dir, site: 'https://example.test' });
    assert.match(result, /no extra Bugframe password/); assert.match(result, /connect codex/);
    const credentials = JSON.parse(await readFile(join(dir, '.bugframe/credentials.json'), 'utf8')); assert.match(credentials.adminToken, /^[a-f0-9]{64}$/);
    assert.ok(!result.includes(credentials.adminToken)); assert.match(await readFile(join(dir, '.bugframe/auth.mjs'), 'utf8'), /return null/);
    assert.match(await readFile(join(dir, '.gitignore'), 'utf8'), /\.bugframe\//);
    assert.ok(!(await readFile(join(dir, '.bugframe/AGENT_SETUP.md'), 'utf8')).includes(credentials.adminToken));
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, '.bugframe/credentials.json'))).mode & 0o777, 0o600);
    await assert.rejects(() => setupProject({ project: dir, site: 'https://example.test' }), /already exists/);
  } finally { await cleanup(dir); }
});

test('the command line helps: one command\'s help, a suggestion for a typo, aligned lists, a missing folder is named', async () => {
  const dir = await tmpDir();
  try {
    await assert.rejects(() => run(dir, 'lst'), /Unknown command "lst"\. Did you mean "list"\?/);
    await assert.rejects(() => run(dir, 'craw', 'http://localhost:3000/'), /Did you mean "crawl"\?/);
    await assert.rejects(() => run(dir, 'frobnicate'), /Unknown command "frobnicate"\. Run bugframe --help/);
    // `bugframe help crawl` and `bugframe crawl --help` print that command only, not the whole manual.
    const crawl = await run(dir, 'help', 'crawl');
    assert.match(crawl, /^Usage: bugframe crawl <start-url>/); assert.match(crawl, /--baseline FILE/); assert.match(crawl, /crawl login <url>/);
    assert.doesNotMatch(crawl, /connect codex|audit --watch/);
    assert.equal(await run(dir, 'crawl', '--help'), crawl);
    assert.match(await run(dir, 'help', 'audit'), /audit --check-blind/);
    assert.match(await run(dir, 'help'), /Commands:/);
    await assert.rejects(() => run(dir, 'help', 'nonsense'), /No command "nonsense"/);
    assert.match(await run(join(dir, 'not-there'), 'list'), /No bug reports\. \(The folder .*not-there does not exist yet\.\)/);
    const { a } = await seed(dir);
    await run(dir, 'ready', a, '--note', 'Deployed');
    const rows = (await run(dir, 'list')).split('\n');
    assert.equal(new Set(rows.map(r => r.indexOf(' /'))).size, 1, 'the page column lines up whatever the status');
  } finally { await cleanup(dir); }
});

test('audit and crawl refuse Node.js below 20 with a clear message instead of loading Playwright', async () => {
  const { loadPlaywright } = await import('../../src/cli/audit/probe.mjs');
  await assert.rejects(loadPlaywright(undefined, '18.20.8'), /Audit and crawl need Node\.js 20 or newer \(you have 18\.20\.8\)/);
});

test('doctor says what works on this machine and how to get the rest, without failing', async () => {
  const { doctor } = await import('../../src/cli/doctor.mjs');
  const dir = await tmpDir();
  try {
    await seed(dir);
    const all = await doctor({ dir, node: '22.3.0', onPath: () => true, playwright: async () => ({ version: '1.64.1', chromium: true }) });
    assert.match(all, /ok +Node\.js 22\.3\.0/); assert.match(all, /ok +Reports folder .*3 reports/);
    assert.match(all, /ok +Playwright 1\.64\.1 with Chromium/); assert.match(all, /ok +Claude Code/); assert.doesNotMatch(all, /missing|problem/);
    const bare = await doctor({ dir: join(dir, 'nope'), node: '18.0.0', onPath: () => false, playwright: async () => null });
    assert.match(bare, /problem +Node\.js 18\.0\.0: Bugframe needs 18\.17 or newer/);
    assert.match(bare, /problem +Playwright: audit and crawl need Node\.js 20 or newer/);
    const noPw = await doctor({ dir, node: '20.11.0', onPath: () => false, playwright: async () => null });
    assert.match(noPw, /missing +Playwright: needed for audit and crawl\. Install it with: npm i -D playwright && npx playwright install chromium/);
    assert.match(bare, /missing +Claude Code \(claude\): .*--agent none/);
    assert.match(bare, /missing +Reports folder .*nope: it is created by the first report/);
    const old = await doctor({ dir, node: '22.3.0', onPath: () => true, playwright: async () => ({ version: '1.40.0', chromium: false }) });
    assert.match(old, /problem +Playwright 1\.40\.0: audit and crawl need 1\.48 or newer/);
    // Playwright exits the whole process on Node.js below 20, so doctor must not even load it there.
    let loaded = false;
    const node18 = await doctor({ dir, node: '18.20.8', onPath: () => true, playwright: async () => { loaded = true; return { version: '1.64.1', chromium: true }; } });
    assert.equal(loaded, false, 'Playwright is never loaded on Node.js 18');
    assert.match(node18, /ok +Node\.js 18\.20\.8/);
    assert.match(node18, /problem +Playwright: audit and crawl need Node\.js 20 or newer \(you have 18\.20\.8\)/);
    assert.match(await run(dir, 'doctor'), /Node\.js/);
  } finally { await cleanup(dir); }
});
