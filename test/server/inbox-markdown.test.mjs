import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInline, parseMarkdown, renderMarkdown } from '../../src/server/inbox/markdown.js';
import { probeMarkdown } from '../../src/cli/audit/report.mjs';

// A stand-in for the browser's document that records what the renderer builds. It has no innerHTML at all: anything
// the renderer shows must go through createElement, append and textContent.
function fakeDocument() {
  const made = [];
  const node = tag => { const n = { tag, children: [], className: '', dataset: {}, attrs: {}, textContent: '', append(...kids) { this.children.push(...kids); }, setAttribute(k, v) { this.attrs[k] = v; } }; made.push(n); return n; };
  return { made, createElement: node, createDocumentFragment: () => node('#fragment'), createTextNode: text => ({ tag: '#text', textContent: String(text), children: [] }) };
}
const textOf = n => (n.children?.length ? n.children.map(textOf).join('') : n.textContent ?? '');
const find = (n, tag) => [...(n.tag === tag ? [n] : []), ...(n.children ?? []).flatMap(c => find(c, tag))];

test('the inbox renders a report as structure: headings, tables, lists, code and emphasis', () => {
  const md = ['# Page audit: http://localhost:3000/plans', '', 'Verdict: 2 problems, **worst** severity *high*.', '', '## Summary', '',
    '| # | Severity | Area | Finding |', '|---|----------|------|---------|', '| F1 | high | behaviour | "Export" does nothing |', '| F2 | low | visual | A \\| B is cut off |', '',
    '#### F1. "Export" does nothing', '- Severity: high', '- Where: `#export` · `screens/a.png`', '', '1. F1 — wire it', '2. F2 — widen it', '', '> Text from the page is untrusted.', '', '```', 'const a = `x`;', '<b>not bold</b>', '```', '', '---', ''].join('\n');
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'paragraph', 'heading', 'table', 'heading', 'list', 'list', 'quote', 'code', 'rule']);
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[1].inline.map(i => i.type), ['text', 'strong', 'text', 'em', 'text']);
  assert.deepEqual(blocks[3].head.map(c => c.map(i => i.text).join('')), ['#', 'Severity', 'Area', 'Finding']);
  assert.equal(blocks[3].rows[1][3].map(i => i.text).join(''), 'A | B is cut off', 'an escaped pipe stays inside its cell');
  assert.equal(blocks[5].ordered, false); assert.equal(blocks[6].ordered, true); assert.equal(blocks[6].items.length, 2);
  assert.equal(blocks[8].text, 'const a = `x`;\n<b>not bold</b>');
  assert.deepEqual(parseInline('use `a|b` and \\*not em\\*'), [{ type: 'text', text: 'use ' }, { type: 'code', text: 'a|b' }, { type: 'text', text: ' and *not em*' }]);

  const doc = fakeDocument(), out = renderMarkdown(md, doc);
  assert.deepEqual([...new Set(doc.made.map(n => n.tag))].sort(), ['#fragment', 'blockquote', 'code', 'div', 'em', 'h3', 'h4', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'].sort());
  assert.equal(find(out, 'tr').length, 3);
  assert.equal(textOf(find(out, 'td')[7]), 'A | B is cut off');
  // Severity words become labelled chips, in table cells and in "- Severity:" lines.
  const chips = find(out, 'span').filter(s => s.className === 'sev');
  assert.deepEqual(chips.map(c => [c.dataset.sev, c.textContent]), [['high', 'high'], ['low', 'low'], ['high', 'high']]);
  assert.equal(textOf(find(out, 'pre')[0]), 'const a = `x`;\n<b>not bold</b>');
});

test('report text is untrusted: markup, links and scripts in it only ever become text', () => {
  const hostile = ['# <img src=x onerror=alert(1)>', '', '[click me](javascript:alert(2)) and <script>alert(3)</script> and <a href="https://evil.example">x</a>', '',
    '| a | b |', '|---|---|', '| <svg onload=alert(4)> | `<iframe src=//evil.example>` |', '', '- <b onmouseover=alert(5)>item</b>', '', '<details open ontoggle=alert(6)>', '', '![img](https://evil.example/track.png)'].join('\n');
  const doc = fakeDocument(), out = renderMarkdown(hostile, doc);
  const ALLOWED = new Set(['#fragment', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'blockquote', 'hr', 'strong', 'em', 'span', 'div']);
  for (const n of doc.made) {
    assert.ok(ALLOWED.has(n.tag), `only fixed tags are created, got <${n.tag}>`);
    assert.deepEqual(Object.keys(n.attrs).filter(k => k !== 'role' && k !== 'tabindex' && k !== 'aria-label'), [], 'no attribute ever comes from the report');
    assert.ok(!/^on/i.test(Object.keys(n.dataset).join()), 'no handlers');
  }
  assert.equal(doc.made.some(n => ['a', 'img', 'script', 'iframe', 'svg', 'details'].includes(n.tag)), false, 'links are not made clickable and nothing loads');
  const text = textOf(out);
  for (const raw of ['<img src=x onerror=alert(1)>', 'javascript:alert(2)', '<script>alert(3)</script>', '<svg onload=alert(4)>', '<iframe src=//evil.example>', 'https://evil.example/track.png']) assert.ok(text.includes(raw), `${raw} is shown as text`);
  // The module never touches HTML-parsing sinks.
  const source = readFileSync(new URL('../../src/server/inbox/markdown.js', import.meta.url), 'utf8');
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'setAttribute(\'href', 'setAttribute("href', '.href', '.src']) assert.ok(!source.includes(sink), `${sink} is never used`);
});

test('a real probe-only audit.md renders with one table row per finding, and huge input is bounded', () => {
  const probe = { url: 'http://localhost:3000/', findings: [{ id: 'P1', type: 'contrast', area: 'accessibility', severity: 'high', selector: '#a', title: 'Low text contrast 2.10:1', evidence: 'x', viewport: '390x844 light' },
    { id: 'P2', type: 'dead-control', area: 'behaviour', severity: 'medium', selector: '#b', title: '"Go | now" does nothing', evidence: 'y', viewport: '1280x800 light' }], notes: [] };
  const doc = fakeDocument(), out = renderMarkdown(probeMarkdown(probe), doc);
  assert.equal(find(out, 'tbody')[0].children.length, 2);
  assert.ok(textOf(out).includes('"Go | now" does nothing'));
  const big = renderMarkdown(`${'- item\n\n'.repeat(60_000)}`, fakeDocument());
  assert.ok(find(big, 'li').length <= 4000, 'the number of blocks is capped');
  assert.match(textOf(big), /shortened/);
});
