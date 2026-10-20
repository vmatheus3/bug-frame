// Remote mode: the CLI commands against a hosted server's admin API instead of a local folder. The admin token only travels
// over HTTPS (plain HTTP just to localhost), redirects are refused, and downloads are checked like imports: exact ids, cleaned fields, real PNGs.
import { mkdir, readFile as readLocal, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ID_RE, FILE_NAMES, STATUSES, cleanContext, isPng, text } from '../server/util.mjs';
import { CliError } from './commands.mjs';

const MAX_BYTES = 32 * 1024 * 1024, TIMEOUT_MS = 60_000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const fields = r => ({ id: r.id, status: STATUSES.includes(r.status) ? r.status : 'open', note: text(r.note, 2000), createdAt: text(r.createdAt, 40),
  description: text(r.description, 4000), types: (Array.isArray(r.types) ? r.types : []).slice(0, 8).map(t => text(t, 40)).filter(Boolean) });
/** A list row, as the server summarizes it. */
const summaryOf = r => ({ ...fields(r), page: text(r.page, 120) });
/** A full report, with the same fields and limits the server and `import` keep. */
const reportOf = r => ({ ...fields(r), closedAt: text(r.closedAt, 40) || null, reporter: text(r.reporter, 300), context: cleanContext(r.context), files: { region: 'region.png', full: 'full.png' } });
/** A problem with one report only: export skips it and goes on with the others. */
const broken = message => Object.assign(new CliError(message), { skip: true });

/**
 * @param {{ url: string, token?: string }} options  the API address (the widget's data-endpoint) and the server's admin token
 */
export function createRemote({ url, token }) {
  let u;
  try { u = new URL(url); } catch { throw new CliError('--remote needs the API address, like https://www.example.com/api/bugframe'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname))) throw new CliError('--remote must use https:// so the admin token is never sent in clear text (http:// works only for localhost).');
  if (!token) throw new CliError("--remote needs the server's admin token: set BUGFRAME_REMOTE_TOKEN (or pass --token).");
  const api = u.origin + u.pathname.replace(/\/+$/, '');
  const notApi = () => new CliError(`${api} did not answer like a Bugframe server. Use the widget's data-endpoint address, like https://www.example.com/api/bugframe`);

  async function read(res) {
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new CliError(`${api} sent more than 32 MB.`);
    const chunks = []; let size = 0;
    try {
      for await (const chunk of res.body ?? []) { size += chunk.length; if (size > MAX_BYTES) throw new CliError(`${api} sent more than 32 MB.`); chunks.push(chunk); }
    } catch (e) { throw e instanceof CliError ? e : new CliError(`Lost the connection to ${api}: ${e?.message}`); }
    return Buffer.concat(chunks);
  }
  const readJson = async res => { const buf = await read(res); try { return JSON.parse(buf.toString('utf8')); } catch { return null; } };

  /** The response, or null for 404. Refused credentials and server errors become plain CLI errors. */
  async function call(path, init = {}) {
    let res;
    try { res = await fetch(api + path, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch (e) { throw new CliError(/redirect/i.test(e?.cause?.message) ? `${api} answered with a redirect, which remote mode never follows. Use the exact API address.` : `Could not reach ${api}: ${e?.cause?.message ?? e?.message}`); }
    if (res.status === 401 || res.status === 403) throw new CliError(`${api} refused the admin token (HTTP ${res.status}).`);
    if (res.status === 404) { await res.body?.cancel().catch(() => {}); return null; }
    if (!res.ok) { const code = (await readJson(res).catch(() => null))?.error; throw new CliError(`${api} answered HTTP ${res.status}${typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? ` (${code})` : ''}.`); }
    return res;
  }

  /** Every report, as the server's short summaries, newest first. */
  async function list() {
    const res = await call('/reports?all=1'), data = res && await readJson(res);
    if (!Array.isArray(data?.reports)) throw notApi();
    return data.reports.filter(r => ID_RE.test(r?.id)).map(summaryOf);
  }

  async function get(id) {
    if (!ID_RE.test(id)) return null;
    const res = await call(`/reports/${id}`); if (!res) return null;
    const raw = await readJson(res);
    if (raw?.id !== id) throw notApi();
    return reportOf(raw);
  }

  async function readFile(id, name) {
    if (!ID_RE.test(id) || !FILE_NAMES.includes(name)) return null;
    const res = await call(`/reports/${id}/${name}`); if (!res) return null;
    const buf = await read(res);
    if (!isPng(buf, MAX_BYTES)) throw broken(`${api} sent a ${name} for ${id} that is not a PNG picture`);
    return buf;
  }

  /** The server replaces the note on every change, so a status-only change (reopen) sends the current note back. */
  async function update(id, patch) {
    if (!ID_RE.test(id)) return null;
    const note = patch.note ?? (await get(id))?.note;
    if (note === undefined) return null;
    const res = await call(`/reports/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: patch.status, note }) });
    if (!res) return null;
    const out = await readJson(res);
    if (out?.id !== id) throw notApi();
    return out;
  }

  /** Save one report into <dir>/<id>/ (pictures first, report.json last) and return it, or null when the server has no such report. */
  async function download(id, dir) {
    const report = await get(id); if (!report) return null;
    const folder = join(resolve(dir), id), existing = await readLocal(join(folder, 'report.json'), 'utf8').then(JSON.parse, () => null);
    if (existing && !existing.downloadedFrom) throw new CliError(`${folder} holds a report that was not downloaded (is --dir the server's own folder?). Use another --dir for remote mode.`);
    const [region, full] = await Promise.all(FILE_NAMES.map(name => readFile(id, name)));
    if (!region || !full) throw broken(`${api} has no pictures for ${id}`);
    const copy = { ...report, downloadedFrom: api };
    await mkdir(folder, { recursive: true });
    for (const [name, data] of [['region.png', region], ['full.png', full], ['report.json', JSON.stringify(copy, null, 2)]]) {
      const tmp = join(folder, `${name}.${randomBytes(4).toString('hex')}.tmp`);
      await writeFile(tmp, data); await rename(tmp, join(folder, name));
    }
    return copy;
  }

  return { kind: 'remote', url: api, list, get, readFile, update, download };
}
