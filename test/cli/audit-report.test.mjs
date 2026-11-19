import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeMarkdown, summaryNote, unfence, validateAuditMarkdown } from '../../src/cli/audit/report.mjs';

const GOOD = `# Page audit: http://localhost:3000/

Verdict: Not ready: the checkout button is dead.

## Summary

| # | Severity | Area | Viewport | Finding | Status |
|---|----------|------|----------|---------|--------|
| F1 | blocker | behaviour | 1280x800 | Checkout dead | verified |

## Findings

### Blocker

#### F1. Checkout dead
- Severity: blocker
- Status: verified
- Area: behaviour
- Where: 1280x800 light · \`#checkout\` · \`_bugframe_audit/clicks/c1.png\`
- Evidence: no DOM change after click
- Root cause: \`src/cart.js:12\` — handler bound to a removed node
- Fix: bind on the container

### High

No findings.

## Fix list

1. F1 — rebind the handler

## Not checked

- nothing
`;

test('a report in the required format validates', () => {
  const v = validateAuditMarkdown(GOOD);
  assert.deepEqual(v.errors, []); assert.equal(v.findings.length, 1); assert.equal(v.findings[0].fields['Root cause'], '`src/cart.js:12` — handler bound to a removed node');
  assert.ok(validateAuditMarkdown(unfence('```markdown\n' + GOOD + '```\n')).ok, 'one outer fence is tolerated');
});

test('the validator names each missing piece', () => {
  const cases = [
    [GOOD.replace('# Page audit', '# Audit'), /start with "# Page audit"/],
    [GOOD.replace(/^Verdict:.*$/m, ''), /Verdict/],
    [GOOD.replace('## Fix list', '## Fixes'), /Fix list/],
    [GOOD.replace('| # | Severity | Area | Viewport | Finding | Status |', '| a | b |'), /table header/],
    [GOOD.replace('- Severity: blocker', '- Severity: critical'), /F1: severity/],
    [GOOD.replace('- Status: verified', '- Status: maybe'), /F1: status/],
    [GOOD.replace(/^- Root cause:.*$/m, ''), /F1: missing "- Root cause:"/],
    [GOOD.replace('| F1 |', '| F9 |'), /F1: not in the summary table/],
    [GOOD.replace(/#### F1[\s\S]*?(?=### High)/, ''), /F1: in the summary table but no "#### F1\." finding/],
    [GOOD.replace(/#### F1[\s\S]*?(?=### High)/, '').replace(/No findings\./, '').replace(/^\| F1 .*$/m, ''), /no "#### F1\." findings/],
    ['Sure, here is my review: looks fine!', /Page audit/],
  ];
  for (const [md, re] of cases) { const v = validateAuditMarkdown(md); assert.equal(v.ok, false); assert.match(v.errors.join('\n'), re); }
  assert.ok(validateAuditMarkdown(GOOD.replace(/#### F1[\s\S]*?(?=### High)/, 'No findings.\n\n').replace(/^\| F1 .*$/m, '')).ok, 'a clean page states No findings.');
});

test('the probe-only report always passes its own validator, with and without findings', () => {
  const probe = { url: 'http://localhost:3000/', notes: ['n1'], findings: [
    { id: 'P1', type: 'contrast', severity: 'medium', area: 'accessibility', selector: 'p.muted', title: 'Low text contrast 2.10:1', evidence: '"x" is #bbbbbb on #ffffff', viewport: '390x844 light', screenshot: '_bugframe_audit/screens/390x844-light.png' },
    { id: 'P2', type: 'dead-control', severity: 'high', area: 'behaviour', selector: '#dead', title: '"Export | all" does nothing', evidence: 'no change', viewport: '1280x800 light' }] };
  const md = probeMarkdown(probe), v = validateAuditMarkdown(md);
  assert.deepEqual(v.errors, []);
  assert.match(md, /#### F1\. "Export \| all" does nothing/); assert.match(md, /\| F1 \| high \|/, 'sorted by severity');
  assert.match(md, /Root cause: not located in code/);
  assert.ok(validateAuditMarkdown(probeMarkdown({ url: 'http://x/', findings: [] })).ok);
  const { note, counts } = summaryNote(md);
  assert.deepEqual(counts, { blocker: 0, high: 1, medium: 1, low: 0 }); assert.match(note, /^Page analysis: 1 high, 1 medium\. Top: F1 /);
  assert.match(summaryNote(md, { degraded: true }).note, /probe-only/);
});

test('a field may continue on indented lines below its label (a numbered fix list is a fix)', () => {
  // A real Claude audit of a 26-finding page was thrown away for this alone: `- Fix:` followed by "  1. ..." lines (2026-11-18).
  const multi = GOOD.replace('- Fix: bind on the container', '- Fix:\n  1. Bind the handler on the container.\n  2. Add a test that clicks #checkout.');
  const r = validateAuditMarkdown(multi);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.match(r.findings[0].fields.Fix, /^1\. Bind the handler on the container\. 2\. Add a test/);
  // an empty label with nothing indented below it is still missing
  const empty = GOOD.replace('- Fix: bind on the container', '- Fix:');
  assert.deepEqual(validateAuditMarkdown(empty).errors, ['F1: missing "- Fix:"']);
});
