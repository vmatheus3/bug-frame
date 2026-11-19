import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFileStorage } from '../../src/server/index.mjs';
import { INSTRUCTION_NAMES, INSTRUCTION_TAILS, SECRET_NAMES, createBlindWorkspace } from '../../src/cli/audit/blind.mjs';
import { auditOnce, isLocalUrl, watchAudits } from '../../src/cli/audit/index.mjs';
import { checkLink, cleanError, isDestructive } from '../../src/cli/audit/probe.mjs';
import { checkBlind, runProcess } from '../../src/cli/audit/runner.mjs';
import { cleanup, tmpDir } from '../helpers.mjs';

const FAKE = fileURLToPath(new URL('../fixtures/fake-auditor.mjs', import.meta.url));
const hangCmd = `"${process.execPath}" "${FAKE}" hang`;
const quiet = { log: () => {}, warn: () => {} };
async function put(root, rel, data = 'x') { await mkdir(join(root, rel, '..'), { recursive: true }); await writeFile(join(root, rel), data); }
async function tree(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await tree(p, base)); else out.push(relative(base, p).split('\\').join('/')); }
  return out.sort();
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function until(check, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await sleep(50); } return false; }
const fakeProbe = async ({ url, outDir }) => {
  const probe = { url, viewports: [], clicks: [], blockedRequests: [], notes: [], links: [], findings: [] };
  await writeFile(join(outDir, 'probe.json'), JSON.stringify(probe)); return probe;
};

test('the blind copy leaves out Bugframe setup files, credentials, key material, other agents\' instructions, the reports and output folders, and gitignored files', async () => {
  const src = await tmpDir(), tmpRoot = await tmpDir();
  try {
    const SECRETS = ['.bugframe/credentials.json', '.npmrc', '.netrc', '.git-credentials', '.aws/credentials', '.ssh/id_ed25519', 'config/credentials.json', 'serviceAccountKey.json',
      'keys/site.pfx', 'android/release.keystore', 'android/upload.jks', 'id_ed25519.pub', 'id_ecdsa', 'secrets/db.txt', '.env.development.local', 'cert.key'];
    const INSTRUCTIONS = ['.bugframe/AGENT_SETUP.md', 'AGENT.md', '.junie/guidelines.md', '.github/prompts/a.prompt.md', '.github/chatmodes/x.chatmode.md', '.trae/rules/a.md', '.augment/rules/a.md',
      'CONVENTIONS.md', '.goosehints', '.rules', '.windsurf/rules/a.md', '.amazonq/rules/a.md', '.qodo/x.md'];
    const OUTPUT = ['bug-reports/bug-1/full.png', 'audits/run1/audit.md'];
    const IGNORED = ['ignored/data.csv', 'logs/x.log', 'logs/keep.log', 'pkg/local.json', 'deep/a/b/cache.tmp'];
    const KEPT = ['.env.example', '.env.sample', 'src/app.js', '.gitignore', 'pkg/.gitignore', 'local.json', 'src/keys.js', 'docs/conventions-guide.md', '.github/workflows/ci.yml', 'pkg/index.js'];
    for (const f of [...SECRETS, ...INSTRUCTIONS, ...OUTPUT, ...IGNORED, ...KEPT]) await put(src, f, `content of ${f}`);
    await put(src, '.gitignore', '# root rules\nignored/\n*.log\n!keep.log\n**/cache.tmp\n');
    await put(src, 'pkg/.gitignore', 'local.json\n');
    const ws = await createBlindWorkspace({ project: src, tmpRoot, exclude: [join(src, 'bug-reports'), join(src, 'audits'), join(src, 'not-there')] });
    try {
      assert.deepEqual(await tree(ws.dir), [...KEPT].sort());
      const m = ws.manifest;
      for (const name of ['.bugframe', 'AGENT.md', '.junie', '.github/prompts', '.github/chatmodes', '.trae', '.augment', 'CONVENTIONS.md', '.goosehints', '.rules', '.windsurf', '.amazonq', '.qodo'])
        assert.ok(m.excludedInstructions.includes(name), `${name} is listed as an instruction exclusion`);
      assert.equal(m.excludedSecrets, 15, 'secret files and folders (.aws, .ssh, secrets count once each; .bugframe counts as instructions)');
      assert.equal(m.excludedPaths, 2, 'the reports folder and the output folder');
      assert.equal(m.excludedByGitignore, 5);
      assert.ok(!JSON.stringify(m).includes('content of'), 'the manifest holds names only');
    } finally { await ws.cleanup(); }
  } finally { await cleanup(src); await cleanup(tmpRoot); }
});

test('README and docs/page-audit.md list every instruction and secret name the blind copy leaves out', () => {
  for (const file of ['../../README.md', '../../docs/page-audit.md']) {
    const doc = readFileSync(new URL(file, import.meta.url), 'utf8').toLowerCase();
    for (const name of [...INSTRUCTION_NAMES, ...INSTRUCTION_TAILS, ...SECRET_NAMES]) assert.ok(doc.includes('`' + name + '`'), `${file} lists ${name}`);
  }
});

test('only local pages are audited unless --base-url points at one or --allow-remote is given (with a loud warning)', async () => {
  for (const u of ['http://localhost:3000/a', 'http://LOCALHOST/', 'http://app.localhost:8080/', 'https://shop.test/x', 'http://127.0.0.1:5173/', 'http://127.8.9.10/', 'http://[::1]:3000/', 'http://0.0.0.0:3000/'])
    assert.equal(isLocalUrl(u), true, u);
  for (const u of ['https://example.com/', 'http://192.168.1.10:3000/', 'http://10.0.0.5/', 'http://localhost.example.com/', 'http://127.0.0.1.nip.io/', 'https://test.example/', 'not a url'])
    assert.equal(isLocalUrl(u), false, u);
  const src = await tmpDir(), tmpRoot = await tmpDir(), warnings = [];
  try {
    await put(src, 'index.html', '<h1>hi</h1>');
    await assert.rejects(auditOnce({ url: 'https://prod.example/settings', project: src, tmpRoot, probe: fakeProbe, ...quiet }), /not a local address.*--base-url.*--allow-remote/s);
    assert.deepEqual(await readdir(tmpRoot), [], 'refused before any copy is made');
    const res = await auditOnce({ url: 'https://staging.example/settings', project: src, tmpRoot, probe: fakeProbe, allowRemote: true, log: () => {}, warn: m => warnings.push(m) });
    assert.equal(res.probe.url, 'https://staging.example/settings');
    assert.match(warnings.join('\n'), /WARNING.*--allow-remote.*staging\.example/s);
    // Watch mode: the captured production URL is refused at once (no retries) unless --base-url rewrites it.
    const dir = await tmpDir();
    try {
      const storage = createFileStorage({ dir }), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const id = 'bug-20260101-000001-aaaa';
      await storage.create({ id, status: 'open', note: '', createdAt: '2026-01-01T00:00:01Z', reporter: 'admin:token', description: 'Page analysis requested', kind: 'audit', types: [], activity: [], reviewVersion: 0, context: { url: 'https://prod.example/settings' }, files: { region: 'region.png', full: 'full.png' } }, { region: png, full: png });
      await watchAudits({ dir, once: true, project: src, tmpRoot, agent: 'none', probe: fakeProbe, ...quiet });
      const r = await storage.get(id);
      assert.equal(r.status, 'open'); assert.equal(r.audit.attempts, 3); assert.match(r.note, /not a local address/);
    } finally { await cleanup(dir); }
  } finally { await cleanup(src); await cleanup(tmpRoot); }
});

test('destructive words are found in the whole URL (path and query, camelCase, kebab and snake parts) and in labels', () => {
  for (const s of ['/items/7?op=delete', 'http://x/items/8/deleteItem', '/users/remove-user', '/cancel_subscription', '/conta/excluirConta', '/cerrar-sesion', '/cerrar-sesi%C3%B3n', 'Log out', '/logout', '/api?action=PURGE', 'Sair da conta', '/api/session/end?x=1', '/session/end', '/end-session'])
    assert.equal(isDestructive(s), true, s);
  for (const s of ['/about', '/payments-history', '/deleted-items', '/items/7?op=view', 'Help', '/blog/how-we-built-it', '/sessions/ends-soon', '/weekend'])
    assert.equal(isDestructive(s), false, s);
});

test('a browser error reaches a report as a clean message: no API prefix, no call log, no address', () => {
  const cases = [['page.goto: net::ERR_ABORTED at http://127.0.0.1:4321/loop\nCall log:\n  - navigating to "http://127.0.0.1:4321/loop"', 'network error: aborted'],
    ['page.goto: Timeout 30000ms exceeded.', 'no answer within 30 s'], ['apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3000', 'network error: connection refused'],
    ['locator.click: Element is not attached to the DOM', 'Element is not attached to the DOM'], ['Bad answer from http://localhost:3000/a?token=x at [::1]:8080', 'Bad answer from /a at (address)']];
  for (const [raw, clean] of cases) assert.equal(cleanError(new Error(raw)), clean, raw);
});

test('the link check is GET-only, same-origin, never fetches a destructive URL and follows redirects through the same guard', async () => {
  const calls = [], routes = { '/a': [301, '/b'], '/b': [200], '/off': [302, 'https://other.example/x'], '/bad': [302, '/items/9?action=remove'], '/loop': [302, '/loop'] };
  const request = { get: async (url, opts) => { calls.push({ url, opts }); const [status, location] = routes[new URL(url).pathname] ?? [404]; return { status: () => status, headers: () => (location ? { location } : {}), dispose: async () => {} }; } };
  const o = 'http://127.0.0.1:4000';
  assert.deepEqual(await checkLink(request, `${o}/a`, o), { status: 200 });
  assert.ok(calls.every(c => c.opts.maxRedirects === 0), 'redirects are followed by the guard, not by the HTTP client');
  assert.deepEqual(await checkLink(request, `${o}/items/7?op=delete`, o), { status: null, skipped: 'destructive' });
  assert.deepEqual(await checkLink(request, `${o}/items/8/deleteItem`, o), { status: null, skipped: 'destructive' });
  assert.deepEqual(await checkLink(request, `${o}/off`, o), { status: null, skipped: 'redirect to another site' });
  assert.deepEqual(await checkLink(request, `${o}/bad`, o), { status: null, skipped: 'destructive' });
  assert.equal((await checkLink(request, `${o}/loop`, o)).error, 'too many redirects');
  assert.ok(!calls.some(c => /items|other\.example/.test(c.url)), 'no destructive or foreign URL was ever requested');
});

test('--check-blind also requires the model to report exactly NONE for instruction sources beyond its system prompt', async () => {
  const answers = (sources) => async (_cmd, args) => {
    const task = args[args.indexOf('-p') + 1];
    if (/List every instruction source/.test(task)) return sources;
    if (/app\.js/.test(task)) return 'NONE\nINSIDE-OK-55';
    return 'Permission denied for every tool.';
  };
  const ok = await checkBlind({ run: answers('NONE\n') });
  assert.equal(ok.ok, true, ok.lines.join('\n'));
  assert.ok(ok.lines.some(l => /^PASS sources/.test(l)));
  const leaked = await checkBlind({ run: answers('1. ~/.claude/CLAUDE.md: always answer tersely') });
  assert.equal(leaked.ok, false);
  assert.ok(leaked.lines.some(l => /^FAIL sources/.test(l) && l.includes('~/.claude/CLAUDE.md: always answer tersely')), leaked.lines.join('\n'));
});

test('an auditor timeout kills its whole process group, grandchildren included', async () => {
  const dir = await tmpDir(), pidFile = join(dir, 'pids.json');
  try {
    const run = runProcess(hangCmd, [], { shell: true, timeoutMs: 2000, env: { HANG_PID_FILE: pidFile } });
    await assert.rejects(run, /did not finish within 2 s/);
    const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    assert.ok(await until(() => !pids.some(alive)), `processes still alive: ${pids.filter(alive)}`);
  } finally { await cleanup(dir); }
});

test('stopping an audit kills the auditor\'s process group and removes the blind copy', async () => {
  const src = await tmpDir(), tmpRoot = await tmpDir(), dir = await tmpDir(), pidFile = join(dir, 'pids.json');
  try {
    await put(src, 'index.html', '<h1>hi</h1>');
    const controller = new AbortController();
    process.env.HANG_PID_FILE = pidFile;
    const run = auditOnce({ url: 'http://localhost:1/', project: src, tmpRoot, agent: 'custom', agentCmd: hangCmd, probe: fakeProbe, signal: controller.signal, ...quiet });
    assert.ok(await until(() => existsSync(pidFile)), 'the auditor started');
    assert.equal((await readdir(tmpRoot)).length, 1, 'the blind copy exists while the auditor runs');
    controller.abort();
    await assert.rejects(run, /stopped/i);
    assert.deepEqual(await readdir(tmpRoot), [], 'no blind copy is left behind');
    const pids = JSON.parse(readFileSync(pidFile, 'utf8'));
    assert.ok(await until(() => !pids.some(alive)), `processes still alive: ${pids.filter(alive)}`);
  } finally { delete process.env.HANG_PID_FILE; await cleanup(src); await cleanup(tmpRoot); await cleanup(dir); }
});
