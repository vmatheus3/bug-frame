// The audit.md contract: one format for the model's report and the probe-only report, checked before it is stored.
export const SEVERITIES = ['blocker', 'high', 'medium', 'low'];
const FIELDS = ['Severity', 'Status', 'Area', 'Where', 'Evidence', 'Root cause', 'Fix'];
const one = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const cell = s => one(s).replace(/\|/g, '\\|');

/** Remove one outer ```markdown fence some models add around the whole answer. */
export function unfence(md) {
  const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(String(md ?? ''));
  return (m ? m[1] : String(md ?? '')).trim() + '\n';
}

/** Parse the finding blocks (`#### F1. Title` + `- Field: value` lines). */
export function parseFindings(md) {
  const out = [], re = /^#### (F\d+)\. (.+)$/gm; let m; const heads = [];
  while ((m = re.exec(md))) heads.push({ id: m[1], title: one(m[2]), start: m.index, end: re.lastIndex });
  heads.forEach((h, i) => {
    const block = md.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : md.search(/^## Fix list/m) > h.end ? md.search(/^## Fix list/m) : md.length);
    const fields = {};
    // A value may sit on the label's line and/or continue on indented lines below it (models write numbered fix lists).
    for (const f of FIELDS) { const v = new RegExp(`^- ${f}:[ \\t]*(.*)$((?:\\n[ \\t]+\\S.*$)*)`, 'm').exec(block); if (v && one(v[1] + v[2])) fields[f] = one(v[1] + v[2]); }
    out.push({ id: h.id, title: h.title, fields });
  });
  return out;
}

/** Check the required sections and every finding's fields. Returns { ok, errors, findings }. */
export function validateAuditMarkdown(input) {
  const md = String(input ?? ''), errors = [];
  if (!/^# Page audit\b/.test(md.trimStart())) errors.push('must start with "# Page audit"');
  if (!/^Verdict: \S.+$/m.test(md)) errors.push('missing "Verdict:" line');
  for (const h of ['## Summary', '## Findings', '## Fix list']) if (!new RegExp(`^${h}\\s*$`, 'm').test(md)) errors.push(`missing section "${h}"`);
  if (!/^\| # \| Severity \| Area \| Viewport \| Finding \| Status \|\s*$/m.test(md)) errors.push('missing summary table header');
  const findings = parseFindings(md), ids = new Set();
  if (!findings.length && !/^## Findings[\s\S]*No findings\./m.test(md)) errors.push('no "#### F1." findings and no "No findings." statement');
  for (const f of findings) {
    if (ids.has(f.id)) errors.push(`${f.id}: duplicate id`); ids.add(f.id);
    for (const k of FIELDS) if (!f.fields[k]) errors.push(`${f.id}: missing "- ${k}:"`);
    if (f.fields.Severity && !SEVERITIES.includes(f.fields.Severity.toLowerCase())) errors.push(`${f.id}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (f.fields.Status && !['verified', 'suspected'].includes(f.fields.Status.toLowerCase())) errors.push(`${f.id}: status must be verified or suspected`);
    if (!new RegExp(`^\\| ${f.id} \\|`, 'm').test(md)) errors.push(`${f.id}: not in the summary table`);
  }
  for (const [, id] of md.matchAll(/^\| (F\d+) \|/gm)) if (!ids.has(id)) errors.push(`${id}: in the summary table but no "#### ${id}." finding`);
  return { ok: errors.length === 0, errors, findings };
}

/** Severity counts plus the top three titles, for the report note the reporter sees. */
export function summaryNote(md, { degraded = false } = {}) {
  const findings = parseFindings(md), counts = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  for (const f of findings) { const s = f.fields.Severity?.toLowerCase(); if (s in counts) counts[s]++; }
  const rank = f => SEVERITIES.indexOf(f.fields.Severity?.toLowerCase());
  const top = [...findings].sort((a, b) => rank(a) - rank(b)).slice(0, 3).map(f => `${f.id} ${f.title}`);
  const tally = SEVERITIES.filter(s => counts[s]).map(s => `${counts[s]} ${s}`).join(', ') || 'no findings';
  const note = `Page analysis${degraded ? ' (probe-only: the auditor output was not usable)' : ''}: ${tally}.${top.length ? ` Top: ${top.join('; ')}.` : ''} Full report: audit.md.`;
  return { note: note.slice(0, 2000), counts };
}

export const FIXES = {
  'horizontal-overflow': 'Constrain the offending element at this width (max-width: 100%; min-width: 0 on flex/grid children; overflow-wrap: anywhere for long words) instead of hiding the overflow on body.',
  'clipped-text': 'Let the container grow (remove the fixed height/width or overflow: hidden) or truncate deliberately with text-overflow: ellipsis and a title.',
  offscreen: 'Bring the element back into the viewport at this width (check absolute positioning, negative margins and transforms).',
  contrast: 'Darken the text or lighten the background until the ratio reaches 4.5:1 (3:1 for large text); fix the design token rather than the one element.',
  'broken-image': 'Fix the image URL or the asset pipeline; serve a fallback when the source can fail.',
  'missing-alt': 'Add alt text that says what the image shows, or alt="" when it is decorative.',
  'unnamed-control': 'Give the control an accessible name: visible text, aria-label, or a <label for>.',
  'small-tap-target': 'Make the hit area at least 24x24 CSS px (44x44 recommended) with padding, without changing the icon size.',
  overlap: 'Separate the two controls so neither covers the other at this width (gap, wrapping, or a different breakpoint layout).',
  misaligned: 'Align the row (align-items: center on the flex container, or matching line-height/vertical-align on the icons).',
  'console-error': 'Fix the code path that throws or logs this error; do not silence it.',
  'page-error': 'Fix the uncaught exception at its source and add a test for that path.',
  'failed-request': 'Fix the endpoint or the URL the page requests, and show a clear error state when it fails.',
  'broken-link': 'Point the link at an existing page or remove it.',
  'dead-control': 'Wire the control to its action, or remove it / make it visibly disabled if it is not ready.',
  'click-error': 'Fix the error this click raises and add a test for the action.',
};

/** A deterministic audit.md from the probe alone (used for --agent none and as the degraded fallback). */
export function probeMarkdown(probe) {
  const findings = [...(probe.findings ?? [])].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, findings.filter(f => f.severity === s).length]));
  const worst = SEVERITIES.find(s => counts[s]);
  const verdict = worst ? `${findings.length} measured problem${findings.length === 1 ? '' : 's'} on this page, worst severity ${worst}; causes in code not located (probe-only report).` : 'The automated probe measured no problems on this page; a human or model review of design and content is still needed.';
  const o = [`# Page audit: ${probe.url}`, '', `Verdict: ${verdict}`, '', '## Summary', '', '| # | Severity | Area | Viewport | Finding | Status |', '|---|----------|------|----------|---------|--------|'];
  findings.forEach((f, i) => o.push(`| F${i + 1} | ${f.severity} | ${f.area} | ${cell(f.viewport)} | ${cell(f.title)} | verified |`));
  o.push('', '## Findings', '');
  for (const sev of SEVERITIES) {
    o.push(`### ${sev[0].toUpperCase()}${sev.slice(1)}`, '');
    const list = findings.map((f, i) => ({ f, n: i + 1 })).filter(x => x.f.severity === sev);
    if (!list.length) o.push('No findings.', '');
    for (const { f, n } of list) {
      o.push(`#### F${n}. ${one(f.title)}`, `- Severity: ${f.severity}`, '- Status: verified', `- Area: ${f.area}`,
        `- Where: ${[f.viewport, f.selector ? `\`${f.selector}\`` : '', f.screenshot ? `\`${f.screenshot}\`` : ''].filter(Boolean).join(' · ')}`,
        `- Evidence: ${one(f.evidence)} (probe ${f.id})`, '- Root cause: not located in code (probe-only report; run with --agent claude for file:line causes).',
        `- Fix: ${FIXES[f.type] ?? 'Investigate the measured evidence above.'}`, '');
    }
  }
  o.push('## Fix list', '');
  if (!findings.length) o.push('Nothing to fix from the probe.');
  findings.forEach((f, i) => o.push(`${i + 1}. F${i + 1} — ${one(f.title)}`));
  o.push('', '## Not checked', '', '- Visual design judgement, content accuracy and root causes in code need the auditor model (`--agent claude`).');
  if (probe.notes?.length) for (const n of probe.notes) o.push(`- ${one(n)}`);
  return o.join('\n') + '\n';
}
