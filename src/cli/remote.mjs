import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './commands.mjs';
import { ID_RE, isOpen } from '../server/util.mjs';
import { oneLine } from './worklist.mjs';

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
