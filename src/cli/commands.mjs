import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { createFileStorage } from '../server/storage-fs.mjs';
import { FEEDBACK_KINDS, ID_RE, FILE_NAMES, isOpen, isActionable, cleanContext, isPng, text } from '../server/util.mjs';
import { buildReproSpec, buildWorklist, oneLine, parseBudget, showText } from './worklist.mjs';
import { readZip } from './zip-read.mjs';

export class CliError extends Error {}

export function openStore(dir) { return createFileStorage({ dir }); }

export async function cmdList(dir, { open = false, json = false } = {}) {
  const rows = (await openStore(dir).list()).filter(r => !open || isOpen(r.status));
  if (json) return JSON.stringify(rows, null, 2);
  if (!rows.length) return open ? 'No open bug reports.' : 'No bug reports.';
  return rows.map(oneLine).join('\n');
}

export async function cmdShow(dir, id, { json = false } = {}) {
  const r = await openStore(dir).get(id);
  if (!r) throw new CliError(`No report with id ${id} in ${resolve(dir)}`);
  return json ? JSON.stringify(r, null, 2) : showText(r, resolve(dir));
}

export async function cmdExport(dir, { all = false, out, now, budget, playwright = false } = {}) {
  let budgetChars; try { budgetChars = parseBudget(budget); } catch (e) { throw new CliError(e.message); }
  const rows = (await openStore(dir).list()).filter(r => all || isActionable(r.status));
  const target = resolve(out ?? join(dir, 'WORKLIST.md'));
  await mkdir(join(target, '..'), { recursive: true });
  const body = buildWorklist(rows, { dir: resolve(dir), out: target, label: all ? 'total' : 'open', now, budgetChars });
  await writeFile(target, body);
  let spec;
  if (playwright && rows.length) { spec = target.replace(/\.md$/i, '') + '.repro.spec.mjs'; await writeFile(spec, buildReproSpec(rows)); }
  return { path: target, count: rows.length, message: rows.length ? `Wrote ${target}: ${rows.length} report${rows.length === 1 ? '' : 's'}${spec ? `; repro spec ${spec}` : ''}` : `No ${all ? '' : 'open '}bug reports; wrote ${target}` };
}

export async function cmdClose(dir, id, { note, status = 'fixed' } = {}) {
  if (!note || !String(note).trim()) throw new CliError('close needs --note "what changed"');
  if (!['fixed', 'wontfix'].includes(status)) throw new CliError('--status must be fixed or wontfix');
  if (!ID_RE.test(id)) throw new CliError(`Not a report id: ${id}`);
  const r = await openStore(dir).update(id, { status, note: text(note, 2000), closedAt: new Date().toISOString() });
  if (!r) throw new CliError(`No report with id ${id} in ${resolve(dir)}`);
  return `${id} marked ${status}`;
}

/** Deliver verified work to its original reporter without claiming customer approval. */
export async function cmdReady(dir, id, { note } = {}) {
  if (!note || !String(note).trim()) throw new CliError('ready needs --note "what changed and what to review"');
  if (!ID_RE.test(id)) throw new CliError(`Not a report id: ${id}`);
  const store = openStore(dir), current = await store.get(id);
  if (!current) throw new CliError(`No report with id ${id} in ${resolve(dir)}`);
  const at = new Date().toISOString(), message = text(note, 2000).trim();
  await store.update(id, { status: 'ready_for_review', note: message, closedAt: null, reviewVersion: (current.reviewVersion ?? 0) + 1,
    activity: [...(current.activity ?? []), { status: 'ready_for_review', note: message, at, by: 'developer' }].slice(-100),
  });
  return `${id} ready for customer review`;
}

export async function cmdReopen(dir, id) {
  if (!ID_RE.test(id)) throw new CliError(`Not a report id: ${id}`);
  const r = await openStore(dir).update(id, { status: 'open', closedAt: null });
  if (!r) throw new CliError(`No report with id ${id} in ${resolve(dir)}`);
  return `${id} reopened`;
}

/** Unpack a .zip made by download mode into the reports folder. Only well-formed report folders are accepted. */
export async function cmdImport(dir, zipPath) {
  const entries = readZip(await readFile(zipPath));
  const byId = new Map();
  for (const e of entries) {
    const m = /^([^/\\]+)\/(report\.json|region\.png|full\.png)$/.exec(e.name);
    if (!m || !ID_RE.test(m[1])) continue;
    if (!byId.has(m[1])) byId.set(m[1], {});
    byId.get(m[1])[m[2]] = e.data;
  }
  const store = openStore(dir); const imported = [], skipped = [];
  for (const [id, f] of byId) {
    try {
      if (!f['report.json'] || !isPng(f['region.png']) || !isPng(f['full.png'])) throw new Error('incomplete or not PNG');
      const raw = JSON.parse(f['report.json'].toString('utf8'));
      const report = { id, status: 'open', note: '', createdAt: text(raw.createdAt, 40) || new Date().toISOString(), reporter: 'imported', description: text(raw.description, 4000).trim(), kind: FEEDBACK_KINDS.includes(raw.kind) ? raw.kind : 'bug', currentText: text(raw.currentText, 2000), suggestedText: text(raw.suggestedText, 2000), types: (Array.isArray(raw.types) ? raw.types : []).slice(0, 8).map(t => text(t, 40)), context: cleanContext(raw.context), files: { region: 'region.png', full: 'full.png' } };
      if (!report.description) throw new Error('no description');
      await store.create(report, { region: f['region.png'], full: f['full.png'] });
      imported.push(id);
    } catch (e) { skipped.push(`${id}: ${e.code === 'EXISTS' ? 'already imported' : e.message}`); }
  }
  void FILE_NAMES; void basename;
  return { imported, skipped, message: `Imported ${imported.length} report${imported.length === 1 ? '' : 's'}${skipped.length ? `; skipped ${skipped.length} (${skipped.join('; ')})` : ''}` };
}
