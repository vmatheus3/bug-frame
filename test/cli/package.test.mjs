import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('the package ships what the CLI and server load at run time, and no documentation pictures', () => {
  // Everything bin, exports and the CLI read from disk must be inside `files`.
  const covered = path => pkg.files.some(f => path === f || path.startsWith(`${f}/`) || (f.endsWith('/*.md') && path.startsWith(f.slice(0, -4)) && path.endsWith('.md') && !path.slice(f.length - 4).includes('/')));
  for (const path of ['src/cli/bin.mjs', 'src/server/index.mjs', 'src/server/inbox/markdown.js', 'src/cli/doctor.mjs', 'types/server.d.ts', 'prompts/AUDIT_PAGE.md', 'prompts/CRAWL_SUMMARY.md', 'prompts/FIX_BUGS.md', 'docs/crawl.md', 'docs/page-audit.md', 'README.md', 'LICENSE'])
    { assert.ok(covered(path), `${path} is packed`); assert.ok(existsSync(join(ROOT, path)), `${path} exists`); }
  assert.equal(pkg.bin.bugframe, './src/cli/bin.mjs');
  for (const target of [pkg.exports['./server'].import, pkg.exports['./server'].types]) assert.ok(existsSync(join(ROOT, target)), target);
  // The screenshots are 2 MB of a 2.3 MB tarball and are only read on the repository page.
  assert.ok(!pkg.files.includes('docs'), 'docs is not packed wholesale');
  assert.equal(covered('docs/images/crawl-report.png'), false);
  // Every inbox file the server can serve exists (a missing one would be a 500 for a signed-in admin).
  const served = readFileSync(join(ROOT, 'src/server/inbox.mjs'), 'utf8').match(/'[a-z-]+\.(?:js|css|html)'/g).map(s => s.slice(1, -1));
  for (const file of new Set(served)) assert.ok(readdirSync(join(ROOT, 'src/server/inbox')).includes(file), `inbox/${file}`);
  // No runtime dependency crept in: the widget's screenshot library is the only one, Playwright stays optional.
  assert.deepEqual(Object.keys(pkg.dependencies), ['html-to-image']);
  for (const source of ['src/cli/audit/probe.mjs', 'src/cli/crawl/index.mjs', 'src/cli/doctor.mjs']) assert.doesNotMatch(readFileSync(join(ROOT, source), 'utf8'), /^import .* from ['"](playwright|@playwright\/test)['"]/m, `${source} loads Playwright only when it runs`);
});
