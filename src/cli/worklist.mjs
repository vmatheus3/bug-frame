import { relative, join, dirname } from 'node:path';

/** Report text is data: control characters become spaces, so it cannot recolor, retitle or rewrite the reader's terminal. */
const safe = s => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ');
const one = s => safe(s).replace(/\s+/g, ' ').trim();
/** Text that may span lines: every line after the first is indented by the caller, so none can pose as a field. */
const textLines = s => safe(s).split('\n');

/** The page a report belongs to: path (+ hash route) without origin or query. */
export function pageOf(r) {
  try { const u = new URL(r.context?.url ?? ''); return (u.pathname || '/') + (u.hash && u.hash.length > 1 ? u.hash.split('?')[0] : ''); } catch { return '(unknown page)'; }
}

export function oneLine(r) {
  return `${r.id}  ${one(r.status ?? 'open').padEnd(6)}  ${one(pageOf(r)).slice(0, 32).padEnd(32)}  ${one(r.description).slice(0, 70)}`;
}

export function showText(r, dir) {
  const c = r.context ?? {}, vp = c.viewport ?? {};
  const lines = [`${r.id}  [${one(r.status)}]  ${one(r.createdAt)}`, `Page: ${one(pageOf(r))}`, `Link: ${one(c.url)}`, `Title: ${one(c.title)}`,
    `Viewport: ${vp.w}x${vp.h} @${vp.dpr}x   scroll: ${JSON.stringify(c.scroll)}   region: ${JSON.stringify(c.region)}`,
    `Types: ${one((r.types ?? []).join(', ')) || '-'}`, '', 'What they wrote:', ...textLines(r.description).map(l => `  ${l}`), '',
    `Region picture: ${join(dir, r.id, 'region.png')}`, `Full screen:    ${join(dir, r.id, 'full.png')}`];
  if (c.elements?.length) lines.push('', 'Under the box:', ...c.elements.map(e => `  - ${one(e.component) || '-'}  |  ${one(e.path)}  |  "${one(e.text)}"`));
  if (c.consoleErrors?.length) lines.push('', 'Console errors (last minute):', ...c.consoleErrors.map(e => `  - ${one(e.message)}`));
  if (c.metadata && Object.keys(c.metadata).length) lines.push('', `App data: ${safe(JSON.stringify(c.metadata))}`);
  if (r.note) lines.push('', `Note: ${textLines(r.note).join('\n  ')}`);
  lines.push(`User agent: ${one(c.userAgent)}`);
  return lines.join('\n');
}

/** Build WORKLIST.md: reports grouped by page, with picture paths relative to the worklist file. */
export function buildWorklist(reports, { dir, out, label = 'open', now = new Date() }) {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  if (!reports.length) return `# Bug work list\n\nNo ${label} bug reports. (${stamp})\n`;
  const groups = new Map();
  for (const r of [...reports].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) { const k = pageOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const rel = (id, f) => relative(dirname(out), join(dir, id, f)).split('\\').join('/');
  const o = [`# Bug work list (${reports.length} ${label} across ${groups.size} page${groups.size === 1 ? '' : 's'})`, '',
    `Generated ${stamp} by \`bugframe export\`. Each item is one person's own words with a picture of the area they marked (open the region picture first), the exact link and the state of the screen. ` +
    'Fix every item at its root cause, prove it with a before/after picture, then close it with `bugframe close <id> --note "what changed, in plain words"`.', ''];
  for (const page of [...groups.keys()].sort()) {
    o.push(`## ${one(page)}`, '');
    for (const r of groups.get(page)) {
      const c = r.context ?? {}, vp = c.viewport ?? {};
      o.push(`### ${r.id}`, '', `> ${one(r.description)}`, '');
      if (r.types?.length) o.push(`- Type: ${one(r.types.join(', '))}`);
      o.push(`- Link: ${one(c.url)}`, `- Viewport: ${vp.w}x${vp.h} at ${vp.dpr}x, scrolled to y=${c.scroll?.y ?? 0}`,
        `- Region picture: \`${rel(r.id, 'region.png')}\`  (whole screen: \`${rel(r.id, 'full.png')}\`)`);
      if (c.region) o.push(`- Marked area (viewport px): ${JSON.stringify(c.region)}`);
      for (const e of (c.elements ?? []).slice(0, 5)) o.push(`- Under the box: ${one(e.component) || '(no data- name)'} \`${one(e.path)}\`${e.text ? ` "${one(e.text).slice(0, 60)}"` : ''}`);
      for (const e of (c.consoleErrors ?? []).slice(0, 5)) o.push(`- Console: ${one(e.message)}`);
      if (c.metadata && Object.keys(c.metadata).length) o.push(`- App data: \`${safe(JSON.stringify(c.metadata)).slice(0, 300)}\``);
      if (c.userAgent) o.push(`- Browser: ${one(c.userAgent).slice(0, 120)}`);
      o.push('');
    }
  }
  return o.join('\n');
}
