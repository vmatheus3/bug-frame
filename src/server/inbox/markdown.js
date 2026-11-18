// A small Markdown subset for reports written by tools (the page-analysis audit.md, a site-crawl report). The report
// quotes text from audited pages, so it is untrusted: every character reaches the page as text, tags come from a fixed
// list below, nothing from the report becomes an attribute, and links and images are never made live.
const MAX_UNITS = 4000, MAX_CHARS = 2 * 1024 * 1024;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|<>~]/;
const SEVERITY = /^(blocker|high|medium|low)$/i;

/** One line of text → [{ type: 'text' | 'code' | 'strong' | 'em', text }]. Anything unrecognised stays text. */
export function parseInline(source) {
  const s = String(source ?? ''), out = [];
  let plain = '';
  const push = (type, text) => { if (plain) { out.push({ type: 'text', text: plain }); plain = ''; } if (text) out.push({ type, text }); };
  const unescape = text => text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1');
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) { plain += s[i + 1]; i += 2; continue; }
    if (ch === '`') {
      let run = 1; while (s[i + run] === '`') run++;
      const fence = '`'.repeat(run), end = s.indexOf(fence, i + run);
      if (end > i) { push('code', s.slice(i + run, end).trim()); i = end + run; continue; }
    }
    if (ch === '*' && s[i + 1] === '*') { const end = s.indexOf('**', i + 2); if (end > i + 2) { push('strong', unescape(s.slice(i + 2, end))); i = end + 2; continue; } }
    if (ch === '*' && s[i + 1] !== undefined && !/[\s*]/.test(s[i + 1])) { const end = s.indexOf('*', i + 1); if (end > i + 1 && !/\s/.test(s[end - 1])) { push('em', unescape(s.slice(i + 1, end))); i = end + 1; continue; } }
    plain += ch; i++;
  }
  push('text', '');
  return out;
}

/** `| a | b \| c |` → ['a', 'b \| c']: split on pipes that are not escaped. */
function splitRow(line) {
  const cells = []; let cell = '', s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cell += s[i] + s[i + 1]; i++; continue; }
    if (s[i] === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += s[i];
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/;
const startsBlock = (line, next) => /^(#{1,6}\s|```|~~~|>)/.test(line) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line) || LIST_ITEM.test(line) || (line.includes('|') && TABLE_RULE.test(next ?? '') && (next ?? '').includes('-'));

/**
 * Markdown → blocks: heading { level, inline }, paragraph { inline }, list { ordered, items: [inline] },
 * table { head: [inline], rows: [[inline]] }, code { text }, quote { inline }, rule. Bounded: a report with more than
 * 4,000 lines of content ends with a note instead of freezing the page.
 */
export function parseMarkdown(source) {
  const lines = String(source ?? '').slice(0, MAX_CHARS).replace(/\r\n?/g, '\n').split('\n'), blocks = [];
  let units = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (units >= MAX_UNITS) { blocks.push({ type: 'paragraph', inline: [{ type: 'em', text: `Report shortened here: ${lines.length - i} more lines are not shown. Copy the report for the full text.` }] }); break; }
    const fence = /^(```|~~~)/.exec(line);
    if (fence) {
      const body = []; for (i++; i < lines.length && !lines[i].startsWith(fence[1]); i++) body.push(lines[i]);
      blocks.push({ type: 'code', text: body.join('\n') }); units += 1 + body.length; continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) }); units++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'rule' }); units++; continue; }
    if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      const head = splitRow(line).map(parseInline), rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim() && units + rows.length < MAX_UNITS; i++) rows.push(splitRow(lines[i]).slice(0, 40).map(parseInline));
      i--; blocks.push({ type: 'table', head: head.slice(0, 40), rows }); units += 1 + rows.length; continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[1]), items = [];
      for (; i < lines.length && units + items.length < MAX_UNITS; i++) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m && /\d/.test(m[1]) === ordered) { items.push(m[2]); continue; }
        if (!m && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ` ${lines[i].trim()}`; continue; } // a wrapped item
        break;
      }
      i--; blocks.push({ type: 'list', ordered, items: items.map(parseInline) }); units += items.length; continue;
    }
    if (line.startsWith('>')) {
      const body = []; for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^>\s?/, ''));
      i--; blocks.push({ type: 'quote', inline: parseInline(body.join(' ')) }); units++; continue;
    }
    const body = [line.trim()];
    for (; i + 1 < lines.length && lines[i + 1].trim() && !startsBlock(lines[i + 1], lines[i + 2]); i++) body.push(lines[i + 1].trim());
    blocks.push({ type: 'paragraph', inline: parseInline(body.join(' ')) }); units++;
  }
  return blocks;
}

const INLINE_TAG = { code: 'code', strong: 'strong', em: 'em' };

/**
 * Markdown → a DocumentFragment built with createElement and text nodes only. `doc` is the document to build with
 * (the page's own by default). Severity words in table cells and "Severity:" list lines get a coloured label.
 */
export function renderMarkdown(source, doc = document, { tableLabel = 'Table' } = {}) {
  const el = (tag, cls) => { const node = doc.createElement(tag); if (cls) node.className = cls; return node; };
  const chip = text => { const node = el('span', 'sev'); node.dataset.sev = text.toLowerCase(); node.textContent = text; return node; };
  const fill = (parent, parts) => {
    const plain = parts.map(p => p.text).join('').trim();
    if (parts.length === 1 && SEVERITY.test(plain)) { parent.append(chip(plain)); return parent; }
    const labelled = /^(Severity:\s*)(blocker|high|medium|low)\s*$/i.exec(parts.length === 1 && parts[0].type === 'text' ? parts[0].text : '');
    if (labelled) { parent.append(doc.createTextNode(labelled[1]), chip(labelled[2])); return parent; }
    for (const part of parts) {
      if (part.type === 'text') { parent.append(doc.createTextNode(part.text)); continue; }
      const node = el(INLINE_TAG[part.type] ?? 'span'); node.textContent = part.text; parent.append(node);
    }
    return parent;
  };
  const out = doc.createDocumentFragment();
  for (const block of parseMarkdown(source)) {
    if (block.type === 'heading') out.append(fill(el(`h${Math.min(6, block.level + 2)}`), block.inline));
    else if (block.type === 'paragraph') out.append(fill(el('p'), block.inline));
    else if (block.type === 'quote') out.append(fill(el('blockquote'), block.inline));
    else if (block.type === 'rule') out.append(el('hr'));
    else if (block.type === 'code') { const pre = el('pre'); pre.textContent = block.text; out.append(pre); }
    else if (block.type === 'list') { const list = el(block.ordered ? 'ol' : 'ul'); for (const item of block.items) list.append(fill(el('li'), item)); out.append(list); }
    else if (block.type === 'table') {
      // Wide tables scroll inside their own box, reachable from the keyboard.
      const box = el('div', 'md-table'), table = el('table'), head = el('thead'), body = el('tbody'), top = el('tr');
      box.setAttribute('role', 'region'); box.setAttribute('tabindex', '0'); box.setAttribute('aria-label', tableLabel);
      for (const cell of block.head) top.append(fill(el('th'), cell));
      head.append(top);
      for (const row of block.rows) { const tr = el('tr'); for (const cell of row) tr.append(fill(el('td'), cell)); body.append(tr); }
      table.append(head, body); box.append(table); out.append(box);
    }
  }
  return out;
}
