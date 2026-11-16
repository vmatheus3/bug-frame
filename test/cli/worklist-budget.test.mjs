import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorklist, buildReproSpec, parseBudget, DEFAULT_BUDGET_TOKENS } from '../../src/cli/worklist.mjs';
import { createBugframe } from '../../src/server/index.mjs';
import { body, cleanup, post, tmpDir } from '../helpers.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../src/cli/bin.mjs');
const exec = promisify(execFile);
const run = (dir, ...args) => exec('node', [BIN, '--dir', dir, ...args]).then(r => r.stdout.trim(), e => { e.message = `${e.stderr}`; throw e; });

const STACK = 'TypeError: boom is not a function\n    at save (https://app.test/assets/app.js:10:5)\n    at node_modules/react-dom/x.js:5:1\n    at onClick (https://app.test/assets/app.js:99:2)\n    at node:internal/foo:1:1';
const mk = (i, over = {}) => ({
  id: `bug-20260101-0000${String(i).padStart(2, '0')}-aaaa`, status: 'open', createdAt: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
  description: `Save button broken, attempt ${i}. ${'Lots of words from the reporter. '.repeat(4)}`, kind: 'bug',
  context: { url: `https://app.test/settings`, title: 'Settings', viewport: { w: 1280, h: 720, dpr: 2 }, scroll: { x: 0, y: 40 }, region: { x: 1, y: 2, w: 3, h: 4 },
    elements: [{ path: 'div#a > button.b', component: 'save', text: 'Save' }], consoleErrors: [{ at: 'x', message: STACK }], userAgent: 'UA' },
  ...over });
const opts = { dir: '/reports', out: '/reports/WORKLIST.md' };

test('parseBudget: default, unlimited, tokens and chars', () => {
  assert.equal(parseBudget(undefined), DEFAULT_BUDGET_TOKENS * 4);
  assert.equal(parseBudget('none'), Infinity);
  assert.equal(parseBudget('0'), Infinity);
  assert.equal(parseBudget('2000'), 8000);
  assert.equal(parseBudget('2000c'), 2000);
  assert.throws(() => parseBudget('a lot'));
});

test('under budget the worklist passes through unchanged', () => {
  const reports = [mk(1), mk(2, { context: { ...mk(2).context, url: 'https://app.test/invoices' } })];
  const unlimited = buildWorklist(reports, { ...opts, now: new Date('2026-02-01') });
  const budgeted = buildWorklist(reports, { ...opts, now: new Date('2026-02-01'), budgetChars: 1_000_000 });
  assert.equal(budgeted, unlimited);
});

test('every worklist item carries an executable Repro block', () => {
  const md = buildWorklist([mk(1)], opts);
  assert.match(md, /- Repro:/);
  assert.match(md, /Open: https:\/\/app\.test\/settings/);
  assert.match(md, /Locate: `div#a > button\.b`/);
  assert.match(md, /no console error: "TypeError: boom is not a function"/);
});

test('the worklist header tells agents to use ready, matching the prompts', () => {
  const md = buildWorklist([mk(1)], opts);
  assert.match(md, /bugframe ready <id> --note/);
});

test('over budget: dedup with a right counter, marked trims, highest-signal first, fits', () => {
  // 3 near-identical reports (same page+element+error class) + 5 distinct ones.
  const reports = [mk(1), mk(2), mk(3),
    ...[4, 5, 6, 7, 8].map(i => mk(i, { context: { ...mk(i).context, url: `https://app.test/page${i}`, elements: [{ path: `div#p${i}`, component: '', text: '' }] } }))];
  const budget = 1600;
  const md = buildWorklist(reports, { ...opts, budgetChars: budget });
  assert.ok(md.length <= budget, `length ${md.length} > budget ${budget}`);
  assert.match(md, /8 reports deduplicated into 6 items/);
  assert.match(md, /Reported 3 times/);
  // The trio (most-reported) survives the cut and comes first, represented by its newest report.
  assert.match(md.split('### ')[1], /^bug-20260101-000003-aaaa/);
  assert.match(md.split('### ')[1], /Reported 3 times/);
  // Console error trimmed with a marker: first line + the user-code frame, never the node_modules frame.
  assert.match(md, /TypeError: boom is not a function/);
  assert.match(md, /at save \(https:\/\/app\.test\/assets\/app\.js:10:5\)/);
  assert.doesNotMatch(md, /node_modules\/react-dom/);
  assert.match(md, /lines omitted; full error in/);
  // Items that did not fit are named, not silently dropped.
  assert.match(md, /more reports? omitted to fit the budget/);
});

test('buildReproSpec emits a valid, red-first-shaped Playwright skeleton', async () => {
  const reports = [mk(1), mk(2, { context: { ...mk(2).context, consoleErrors: [] } })];
  const src = buildReproSpec(reports);
  assert.match(src, /import { test, expect } from '@playwright\/test';/);
  assert.equal([...src.matchAll(/\ntest\(/g)].length, 2);
  assert.match(src, /page\.on\('console'/);
  assert.match(src, /setViewportSize\(\{ width: 1280, height: 720 \}\)/);
  assert.match(src, /page\.goto\("https:\/\/app\.test\/settings"\)/);
  // Red first: asserts the captured error does NOT occur.
  assert.match(src, /errors\.filter\(e => e\.includes\("TypeError: boom is not a function"\)\)\)\.toEqual\(\[\]\)/);
  // No captured error -> an honest TODO, not a fake green assertion.
  assert.match(src, /TODO: assert the reported behavior is fixed/);
  const dir = await tmpDir();
  try {
    const file = join(dir, 'w.repro.spec.mjs');
    await writeFile(file, src);
    await exec('node', ['--check', file]); // throws if invalid
  } finally { await cleanup(dir); }
});

test('CLI: export --budget and --playwright are wired end to end', async () => {
  const dir = await tmpDir();
  try {
    const bf = createBugframe({ dir, rateLimit: false, authorize: () => ({ id: 'fixture', role: 'client' }) });
    for (let i = 0; i < 6; i++) await bf.handle(post('https://x.test/reports', body({ description: `Report ${i} ${'words '.repeat(30)}` })));
    const msg = await run(dir, 'export', '--budget', '250', '--playwright');
    assert.match(msg, /repro spec/);
    const md = await readFile(join(dir, 'WORKLIST.md'), 'utf8');
    assert.ok(md.length <= 1000, `budgeted worklist is ${md.length} chars`);
    await access(join(dir, 'WORKLIST.repro.spec.mjs'));
    await assert.rejects(() => run(dir, 'export', '--budget', 'nope'), /--budget/);
  } finally { await cleanup(dir); }
});
