import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CliError } from './commands.mjs';
import { createFileStorage } from '../server/storage-fs.mjs';
import { ATTACHMENT_NAMES, ID_RE, isActionable, isOpen, isPng } from '../server/util.mjs';
import { buildReproSpec, buildWorklist, oneLine, parseBudget } from './worklist.mjs';

export async function remoteCredentials(file, env = process.env) {
  let token = env.BUGFRAME_ADMIN_TOKEN;
  const explicit = file ?? env.BUGFRAME_CREDENTIALS_FILE;
  if (!token || explicit) {
    const path = explicit ?? join(homedir(), '.config', 'bugframe', 'credentials.json');
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 16384 || (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) {
        throw new CliError('The credential file must be a private, user-owned file (chmod 600), not a symlink.');
      }
      const config = JSON.parse(await readFile(path, 'utf8'));
      token ||= config.adminToken;
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (error.code !== 'ENOENT' || explicit) throw new CliError('Could not read the private credential file.');
    }
  }
  if (typeof token !== 'string' || !token || token.length > 4096 || /[^\x21-\x7e]/.test(token)) throw new CliError('Set BUGFRAME_ADMIN_TOKEN or a private credential file containing adminToken.');
  return token;
}

export async function remoteCommand(command, id, { endpoint, token, timeoutMs = 30000, json = false, open = false, note, status = 'fixed', allowInsecureLocalhost = false, fetch: request = globalThis.fetch } = {}) {
  if (!['list', 'show', 'close', 'ready', 'reopen'].includes(command)) throw new CliError('Remote mode supports list, show, close, ready and reopen only.');
  let base;
  try { base = new URL(endpoint); } catch { throw new CliError('Use a valid HTTPS remote API URL.'); }
  const local = allowInsecureLocalhost && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((!local && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash) throw new CliError('Remote URLs must use HTTPS without embedded credentials, query strings or fragments.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new CliError('--timeout must be between 1 and 300000 milliseconds.');
  if (typeof token !== 'string' || !token || /[^\x21-\x7e]/.test(token)) throw new CliError('A private admin credential is required.');
  if (command !== 'list' && !ID_RE.test(id ?? '')) throw new CliError('A valid report id is required.');
  if (command === 'close' && (!note?.trim() || !['fixed', 'wontfix'].includes(status))) throw new CliError('close requires --note "what changed" and --status fixed or wontfix.');
  if (command === 'ready' && !note?.trim()) throw new CliError('ready requires --note "what changed and what to review".');
  const targetStatus = command === 'ready' ? 'ready_for_review' : command === 'reopen' ? 'open' : status;
  const route = command === 'list' ? '/reports?all=1' : `/reports/${id}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options = { redirect: 'manual', signal: controller.signal, headers: { authorization: `Bearer ${token}`, accept: 'application/json' } };
    if (command === 'close' || command === 'ready' || command === 'reopen') {
      options.method = 'PATCH'; options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify({ status: targetStatus, note: command === 'reopen' ? '' : note.trim() });
    }
    const response = await request(base.href.replace(/\/$/, '') + route, options);
    if (response.status >= 300 && response.status < 400) throw new CliError('Remote redirects are refused. Use the final HTTPS API URL.');
    if (!response.ok) { const error = new CliError(`Remote API returned HTTP ${response.status}. Check access and server availability.`); error.retryable = response.status === 429 || response.status >= 500; throw error; }
    const reader = response.body?.getReader();
    if (!reader) throw new CliError('The remote API returned an empty response.');
    const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new CliError('Remote response exceeded the 8 MB limit.'); }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (command === 'list') {
      if (!Array.isArray(result.reports)) throw new CliError('The remote API returned an invalid report list.');
      const reports = result.reports.filter(r => !open || isOpen(r.status));
      return json ? JSON.stringify(reports, null, 2) : reports.map(oneLine).join('\n') || 'No bug reports.';
    }
    if (command === 'show') {
      if (result.id !== id) throw new CliError('The remote API returned a different report.');
      return JSON.stringify({ ...result, images: { region: `${base.href.replace(/\/$/, '')}/reports/${id}/region.png`, full: `${base.href.replace(/\/$/, '')}/reports/${id}/full.png` } }, null, 2);
    }
    if (result.id !== id || result.status !== targetStatus) throw new CliError('The remote API returned an unexpected status update.');
    return json ? JSON.stringify(result, null, 2) : `${id} ${command === 'reopen' ? 'reopened' : command === 'ready' ? 'ready for customer review' : `marked ${status}`}`;
  } catch (error) {
    if (error instanceof CliError) throw error;
    const failure = new CliError(controller.signal.aborted ? 'Remote request timed out.' : 'Remote request failed or returned invalid JSON.'); failure.retryable = !(error instanceof SyntaxError); throw failure;
  } finally { clearTimeout(timer); }
}

/**
 * One bounded, authenticated request to the hosted API, with the rules of every remote command: HTTPS only (HTTP for
 * loopback when explicitly allowed), no redirects, a time limit, a size limit, and errors that never echo the credential.
 */
function remoteApi({ endpoint, token, timeoutMs = 30000, allowInsecureLocalhost = false, fetch: request = globalThis.fetch } = {}) {
  let base; try { base = new URL(endpoint); } catch { throw new CliError('Use a valid HTTPS remote API URL.'); }
  const local = allowInsecureLocalhost && base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((!local && base.protocol !== 'https:') || base.username || base.password || base.search || base.hash) throw new CliError('Remote URLs must use HTTPS without embedded credentials, query strings or fragments.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new CliError('--timeout must be between 1 and 300000 milliseconds.');
  if (typeof token !== 'string' || !token || /[^\x21-\x7e]/.test(token)) throw new CliError('A private admin credential is required.');
  const root = base.href.replace(/\/$/, '');
  /** Returns { status, buffer }. `missing: true` turns a 404 into { status: 404 } instead of an error. */
  async function call(route, { method = 'GET', body, type, accept = 'application/json', max = 8 * 1024 * 1024, missing = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(root + route, { method, redirect: 'manual', signal: controller.signal, body, headers: { authorization: `Bearer ${token}`, accept, ...(type ? { 'content-type': type } : {}) } });
      if (response.status >= 300 && response.status < 400) throw new CliError('Remote redirects are refused. Use the final HTTPS API URL.');
      if (response.status === 404 && missing) { try { await response.body?.cancel(); } catch { /* closed */ } return { status: 404, buffer: null }; }
      if (!response.ok) { const error = new CliError(`Remote API returned HTTP ${response.status}. Check access and server availability.`); error.status = response.status; error.retryable = response.status === 429 || response.status >= 500; throw error; }
      const reader = response.body?.getReader(), chunks = []; let size = 0;
      if (reader) for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > max) { await reader.cancel(); throw new CliError(`Remote response exceeded the ${Math.round(max / 1024 / 1024)} MB limit.`); }
        chunks.push(value);
      }
      return { status: response.status, buffer: Buffer.concat(chunks) };
    } catch (error) {
      if (error instanceof CliError) throw error;
      const failure = new CliError(controller.signal.aborted ? 'Remote request timed out.' : 'Remote request failed.'); failure.retryable = true; throw failure;
    } finally { clearTimeout(timer); }
  }
  const json = async (route, options) => { const { buffer } = await call(route, options); try { return JSON.parse(buffer.toString('utf8')); } catch { throw new CliError('The remote API returned invalid JSON.'); } };
  /** Every report as the list shows it; refuses a list that is not one. */
  const reports = async () => {
    const { reports: rows } = await json('/reports?all=1');
    if (!Array.isArray(rows) || rows.length > 10000 || rows.some(r => !r || typeof r.id !== 'string' || !ID_RE.test(r.id))) throw new CliError('The remote API returned an invalid report list.');
    return rows;
  };
  const report = async id => { const r = await json(`/reports/${id}`); if (r?.id !== id) throw new CliError('The remote API returned a different report.'); return r; };
  return { root, call, json, reports, report };
}

/**
 * `bugframe --remote URL export`: copy the requests to work on (with their pictures) into a private local folder and
 * write the worklist there, so a coding agent gets local picture paths. The copy is read-only context: the worklist
 * tells the agent to hand work back to the server with `bugframe --remote URL ready <id>`.
 */
export async function remoteExport({ out, all = false, budget, playwright = false, now, log = () => {}, ...options } = {}) {
  let budgetChars; try { budgetChars = parseBudget(budget); } catch (e) { throw new CliError(e.message); }
  const api = remoteApi(options), target = resolve(out ?? join('bugframe-remote', 'WORKLIST.md')), dir = dirname(target);
  const wanted = (await api.reports()).filter(r => all || isActionable(r.status));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = createFileStorage({ dir }), rows = [], skipped = [];
  for (const summary of wanted) {
    try {
      const report = await api.report(summary.id), pictures = {};
      for (const name of ['region', 'full']) {
        const { buffer } = await api.call(`/reports/${summary.id}/${name}.png`, { accept: 'image/png', max: 12 * 1024 * 1024 });
        if (!isPng(buffer, 12 * 1024 * 1024)) throw new CliError(`${name}.png is not a PNG picture`);
        pictures[name] = buffer;
      }
      try { await store.create(report, pictures); } catch (e) { if (e?.code !== 'EXISTS') throw e; await store.update(report.id, report); }
      rows.push(report); log(`pulled ${report.id}`);
    } catch (e) { skipped.push(`${summary.id}: ${String(e?.message ?? e).split('\n')[0].slice(0, 120)}`); }
  }
  await writeFile(target, buildWorklist(rows, { dir, out: target, label: all ? 'total' : 'open', now, budgetChars, command: `bugframe --remote ${api.root}` }), { mode: 0o600 });
  let spec; if (playwright && rows.length) { spec = target.replace(/\.md$/i, '') + '.repro.spec.mjs'; await writeFile(spec, buildReproSpec(rows), { mode: 0o600 }); }
  return { path: target, count: rows.length, skipped, message: `Wrote ${target}: ${rows.length} report${rows.length === 1 ? '' : 's'} from ${api.root}${spec ? `; repro spec ${spec}` : ''}${skipped.length ? `; skipped ${skipped.length} (${skipped.join('; ')})` : ''}.\nTheir pictures and report.json are next to it in ${dir}: customer screenshots, so keep that folder private and out of git. Hand work back with: bugframe --remote ${api.root} ready <id> --note "..."` };
}

/**
 * The hosted API as a storage adapter for `bugframe audit --watch --remote`: list, claim, upload audit.md and hand back.
 * Only what the API allows an administrator: a status and note, the watcher's bookkeeping, and the two analysis files.
 * History, review versions and file links are kept by the server.
 */
export function createRemoteStorage(options) {
  const api = remoteApi(options);
  const get = async id => { if (!ID_RE.test(id ?? '')) return null; try { return await api.report(id); } catch (e) { if (e.status === 404) return null; throw e; } };
  return {
    kind: 'remote', root: api.root, get,
    /** Waiting page analyses come back in full (the summary has neither the page URL nor the attempts); the rest as listed. */
    async list() { const out = []; for (const r of await api.reports()) out.push(r.kind === 'audit' && r.status === 'open' ? await api.report(r.id) : r); return out; },
    async update(id, patch) {
      if (!ID_RE.test(id ?? '')) return null;
      await api.json(`/reports/${id}`, { method: 'PATCH', type: 'application/json', body: JSON.stringify({ status: patch.status, note: patch.note ?? '', ...(patch.audit ? { audit: patch.audit } : {}) }) });
      return api.report(id);
    },
    async readFile(id, name) {
      if (!ID_RE.test(id ?? '') || !['region.png', 'full.png', ...ATTACHMENT_NAMES].includes(name)) return null;
      return (await api.call(`/reports/${id}/${name}`, { accept: '*/*', max: 12 * 1024 * 1024, missing: true })).buffer;
    },
    async writeAttachment(id, name, data) {
      if (!ID_RE.test(id ?? '') || !ATTACHMENT_NAMES.includes(name)) throw new CliError('Only audit.md or audit.json can be uploaded for a report.');
      try { await api.call(`/reports/${id}/${name}`, { method: 'PUT', type: name === 'audit.json' ? 'application/json' : 'text/markdown', body: Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? '')) }); }
      catch (e) { if (e.status === 404 || e.status === 405) throw new CliError('This server does not accept page-analysis uploads (or its storage cannot hold them). Upgrade the Bugframe server to 0.6.0 or newer, or run the watcher on the reports folder with --dir.'); throw e; }
    },
  };
}
