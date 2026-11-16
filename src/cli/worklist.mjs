import { relative, join, dirname } from 'node:path';

const one = s => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The page a report belongs to: path (+ hash route) without origin or query. */
export function pageOf(r) {
  try { const u = new URL(r.context?.url ?? ''); return (u.pathname || '/') + (u.hash && u.hash.length > 1 ? u.hash.split('?')[0] : ''); } catch { return '(unknown page)'; }
}

export function oneLine(r) {
  return `${r.id}  ${String(r.status ?? 'open').padEnd(6)}  ${pageOf(r).slice(0, 32).padEnd(32)}  ${one(r.description).slice(0, 70)}`;
}

export function showText(r, dir) {
  const c = r.context ?? {}, vp = c.viewport ?? {};
  const lines = [`${r.id}  [${r.status}]  ${r.createdAt}`, `Page: ${pageOf(r)}`, `Link: ${c.url ?? ''}`, `Title: ${c.title ?? ''}`,
    `Viewport: ${vp.w}x${vp.h} @${vp.dpr}x   scroll: ${JSON.stringify(c.scroll)}   region: ${JSON.stringify(c.region)}`,
    `Feedback: ${r.kind ?? 'bug'}`, `Types: ${(r.types ?? []).join(', ') || '-'}`, '', 'What they wrote:', `  ${r.description}`, '',
    `Region picture: ${join(dir, r.id, 'region.png')}`, `Full screen:    ${join(dir, r.id, 'full.png')}`];
  if (c.elements?.length) lines.push('', 'Under the box:', ...c.elements.map(e => `  - ${e.component || '-'}  |  ${e.path}  |  "${e.text}"`));
  if (c.consoleErrors?.length) lines.push('', 'Console errors (last minute):', ...c.consoleErrors.map(e => `  - ${e.message}`));
  if (c.metadata && Object.keys(c.metadata).length) lines.push('', `App data: ${JSON.stringify(c.metadata)}`);
  if (r.kind === 'content') lines.push('', `Current wording: ${r.currentText ?? ''}`, `Suggested wording: ${r.suggestedText ?? ''}`);
  if (r.reviewNote) lines.push('', `Customer review: ${r.reviewNote}`);
  if (r.note) lines.push('', `Note: ${r.note}`);
  lines.push(`User agent: ${c.userAgent ?? ''}`);
  return lines.join('\n');
}

/** Tokens are approximated at 4 characters each throughout. */

/** Parse an export --budget value into a character limit. Opt-in: absent, "none" and "0" → unlimited output. */
export function parseBudget(v) {
  if (v === undefined || v === null) return Infinity;
  const s = String(v).trim().toLowerCase();
  if (s === 'none') return Infinity;
  const m = /^(\d+)(c|chars?)?$/.exec(s);
  if (!m) throw new Error('--budget takes a token count (e.g. 4000), a character count (e.g. 16000c), or "none" for unlimited');
  const n = Number(m[1]);
  return n === 0 ? Infinity : m[2] ? n : n * 4;
}

const firstLine = s => one(String(s ?? '').split('\n')[0]);
const errClass = m => firstLine(m).replace(/\d+/g, '#').slice(0, 160);

const GUIDANCE = `Each item is one person's own words with a picture of the area they marked (open the region picture first), the exact link and the state of the screen. ` +
  'Triage suggestions before implementing them; submission is not scope approval. Fix accepted work at its root cause, prove it with a before/after picture, then hand it back for review with `bugframe ready <id> --note "what changed and what to review"` (legacy close-only workflows: `bugframe close <id> --note "..."`).';

/** A block an agent can execute: where to go, how the screen was set up, what to look at, and what must no longer happen. */
function reproBlock(r) {
  const c = r.context ?? {}, vp = c.viewport ?? {};
  const o = ['- Repro:', `  - Open: ${c.url ?? ''}${vp.w ? ` at ${vp.w}x${vp.h} @${vp.dpr ?? 1}x` : ''}${c.scroll?.y ? `, scroll to y=${c.scroll.y}` : ''}`];
  if (c.elements?.[0]?.path) o.push(`  - Locate: \`${c.elements[0].path}\``);
  const err = c.consoleErrors?.[0]?.message;
  o.push(err ? `  - Expect: no console error: "${firstLine(err).slice(0, 160)}"` : '  - Expect: the reported behavior is fixed');
  return o;
}

/** First error line plus the first frame naming user code; the rest cut with a marker, never silently. */
function trimmedError(message, fullRef) {
  const lines = String(message ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length <= 2) return lines.length ? [`- Console: ${lines.join('  ')}`] : [];
  const frame = lines.slice(1).find(l => !/node_modules|node:internal|\(native\)/.test(l));
  const kept = frame ? `${lines[0]}  ${frame}` : lines[0];
  const omitted = lines.length - (frame ? 2 : 1);
  return [`- Console: ${kept}`, `  (${omitted} line${omitted === 1 ? '' : 's'} omitted; full error in \`${fullRef}\`)`];
}

/** Merge near-identical reports: same page + marked element + console error class become one item with a count. */
function dedupe(reports) {
  const m = new Map();
  for (const r of reports) {
    const c = r.context ?? {};
    const k = [pageOf(r), c.elements?.[0]?.path ?? '', errClass(c.consoleErrors?.[0]?.message ?? '')].join('\u0000');
    const g = m.get(k);
    if (!g) m.set(k, { rep: r, ids: [r.id] });
    else { g.ids.push(r.id); if (String(r.createdAt) > String(g.rep.createdAt)) g.rep = r; }
  }
  return [...m.values()].sort((a, b) => b.ids.length - a.ids.length || String(b.rep.createdAt).localeCompare(String(a.rep.createdAt)));
}

/** Build WORKLIST.md: reports grouped by page, with picture paths relative to the worklist file.
 *  When the result would exceed budgetChars, near-identical reports are merged, console errors trimmed
 *  with explicit markers, and the highest-signal items (most-reported first, then newest) kept. */
export function buildWorklist(reports, { dir, out, label = 'open', now = new Date(), budgetChars = Infinity }) {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  if (!reports.length) return `# Bug work list\n\nNo ${label} bug reports. (${stamp})\n`;
  const groups = new Map();
  for (const r of [...reports].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) { const k = pageOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const rel = (id, f) => relative(dirname(out), join(dir, id, f)).split('\\').join('/');
  const o = [`# Bug work list (${reports.length} ${label} across ${groups.size} page${groups.size === 1 ? '' : 's'})`, '',
    `Generated ${stamp} by \`bugframe export\`. ${GUIDANCE}`, ''];
  for (const page of [...groups.keys()].sort()) {
    o.push(`## ${page}`, '');
    for (const r of groups.get(page)) {
      const c = r.context ?? {}, vp = c.viewport ?? {};
      o.push(`### ${r.id}`, '', `> ${one(r.description)}`, '');
      o.push(`- Feedback: ${r.kind ?? 'bug'}; status: ${r.status}`);
      if (r.kind === 'content') o.push(`- Current wording: ${one(r.currentText)}`, `- Suggested wording: ${one(r.suggestedText)}`);
      if (r.reviewNote) o.push(`- Customer review: ${one(r.reviewNote)}`);
      if (r.types?.length) o.push(`- Type: ${r.types.join(', ')}`);
      o.push(`- Link: ${c.url ?? ''}`, `- Viewport: ${vp.w}x${vp.h} at ${vp.dpr}x, scrolled to y=${c.scroll?.y ?? 0}`,
        `- Region picture: \`${rel(r.id, 'region.png')}\`  (whole screen: \`${rel(r.id, 'full.png')}\`)`);
      if (c.region) o.push(`- Marked area (viewport px): ${JSON.stringify(c.region)}`);
      o.push(...reproBlock(r));
      for (const e of (c.elements ?? []).slice(0, 5)) o.push(`- Under the box: ${e.component || '(no data- name)'} \`${e.path}\`${e.text ? ` "${e.text.slice(0, 60)}"` : ''}`);
      for (const e of (c.consoleErrors ?? []).slice(0, 5)) o.push(`- Console: ${e.message}`);
      if (c.metadata && Object.keys(c.metadata).length) o.push(`- App data: \`${JSON.stringify(c.metadata).slice(0, 300)}\``);
      if (c.userAgent) o.push(`- Browser: ${c.userAgent.slice(0, 120)}`);
      o.push('');
    }
  }
  const full = o.join('\n');
  if (!(budgetChars < Infinity) || full.length <= budgetChars) return full;

  // Over budget: dedupe, trim with markers, keep the highest-signal items.
  const merged = dedupe(reports);
  const head = [`# Bug work list (${reports.length} ${label}, budgeted)`, '', `Generated ${stamp} by \`bugframe export\`. ${GUIDANCE}`, '',
    `Budgeted to ~${Math.round(budgetChars / 4)} tokens: ${reports.length} reports deduplicated into ${merged.length} items, most-reported first, then newest. Full list: \`bugframe export --budget none\`.`, ''];
  let body = head.join('\n'); let used = 0;
  for (const g of merged) {
    const r = g.rep, c = r.context ?? {};
    const item = [`### ${r.id}`, '', `> ${one(r.description).slice(0, 300)}`, '', `- Page: ${pageOf(r)}; feedback: ${r.kind ?? 'bug'}; status: ${r.status}`];
    if (g.ids.length > 1) item.push(`- Reported ${g.ids.length} times (also ${g.ids.filter(i => i !== r.id).slice(0, 5).join(', ')})`);
    item.push(...reproBlock(r), `- Region picture: \`${rel(r.id, 'region.png')}\``);
    for (const e of (c.consoleErrors ?? []).slice(0, 2)) item.push(...trimmedError(e.message, rel(r.id, 'report.json')));
    let block = '\n' + item.join('\n') + '\n';
    if (body.length + block.length + 120 > budgetChars) {
      if (used) break;
      // An empty worklist helps no agent: keep the top item, cut as hard as the marked-cut rules allow.
      block = '\n' + [`### ${r.id}`, '', `> ${one(r.description).slice(0, 120)}${one(r.description).length > 120 ? ' [cut]' : ''}`, '', `- Page: ${pageOf(r)}`,
        ...(g.ids.length > 1 ? [`- Reported ${g.ids.length} times`] : []), ...reproBlock(r), ...(c.consoleErrors?.[0] ? trimmedError(c.consoleErrors[0].message, rel(r.id, 'report.json')) : [])].join('\n') + '\n';
    }
    body += block; used++;
  }
  const omitted = merged.length - used;
  if (omitted) body += `\n> ${omitted} more report${omitted === 1 ? '' : 's'} omitted to fit the budget. Run \`bugframe export --budget none\` for the full list.\n`;
  return body;
}

/** A failing-first Playwright skeleton per report: navigates, then asserts the captured console error
 *  does NOT occur — red on the broken page, green once fixed. Plain .mjs so Playwright and node --check both take it. */
export function buildReproSpec(reports) {
  const q = JSON.stringify;
  const o = ['// Failing-first repro skeletons generated by `bugframe export --playwright`.',
    '// Each test fails while its reported bug is present and goes green when it is fixed.',
    '// Adjust navigation and auth to your app; keep the console assertion.',
    "import { test, expect } from '@playwright/test';", ''];
  for (const r of reports) {
    const c = r.context ?? {}, vp = c.viewport ?? {};
    o.push(`// ${r.id}: ${one(r.description)}`,
      `test(${q(`${r.id} ${one(r.description).slice(0, 60)}`)}, async ({ page }) => {`,
      '  const errors = [];',
      "  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });",
      "  page.on('pageerror', e => errors.push(String(e)));");
    if (Number(vp.w) && Number(vp.h)) o.push(`  await page.setViewportSize({ width: ${Number(vp.w)}, height: ${Number(vp.h)} });`);
    o.push(`  await page.goto(${q(c.url ?? '')});`);
    if (c.elements?.[0]?.path) o.push(`  await expect(page.locator(${q(c.elements[0].path)}).first()).toBeVisible();`);
    const err = c.consoleErrors?.[0]?.message;
    if (err) o.push('  // Red first: this console error was captured on the broken page.',
      `  expect(errors.filter(e => e.includes(${q(firstLine(err).slice(0, 160))}))).toEqual([]);`);
    else o.push(`  // TODO: assert the reported behavior is fixed: ${one(r.description).slice(0, 100)}`);
    o.push('});', '');
  }
  return o.join('\n');
}
