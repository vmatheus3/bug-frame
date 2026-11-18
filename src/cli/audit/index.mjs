// `bugframe audit`: probe a page, hand the evidence and a blind copy of the code to a specialised auditor, store the report.
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError } from '../commands.mjs';
import { createFileStorage } from '../../server/storage-fs.mjs';
import { MAX_ATTACHMENT_BYTES, text } from '../../server/util.mjs';
import { EVIDENCE_DIR, cleanupAllSync, createBlindWorkspace } from './blind.mjs';
import { parseViewports, probePage, redactUrl } from './probe.mjs';
import { probeMarkdown, summaryNote, unfence, validateAuditMarkdown } from './report.mjs';
import { killAllChildren, onPath, runAuditor } from './runner.mjs';

export const PROMPT_PATH = new URL('../../../prompts/AUDIT_PAGE.md', import.meta.url);
export const MAX_ATTEMPTS = 3;
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
/** Error text for notes and logs: first line, short, no home folder. */
const short = e => String(e?.message ?? e).split('\n')[0].split(homedir()).join('~').slice(0, 300);

/**
 * Local development addresses only: localhost and *.localhost, *.test, 127.0.0.0/8, ::1 and 0.0.0.0. Private LAN ranges
 * (10/8, 192.168/16, …) are deliberately not local: intranet production servers live there too.
 */
export function isLocalUrl(href) {
  let host; try { host = new URL(href).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); } catch { return false; }
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test') || host === '::1' || host === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** 'claude' | 'none' | 'custom' from the flags; claude when it is installed and nothing was chosen. */
export function chooseAgent({ agent, agentCmd, warn = m => console.error(m) }) {
  if (agentCmd) { if (agent && agent !== 'custom') throw new CliError('Use either --agent or --agent-cmd.'); return 'custom'; }
  if (agent) { if (!['claude', 'none'].includes(agent)) throw new CliError('--agent must be claude or none (or use --agent-cmd "<command>").'); return agent; }
  if (onPath('claude')) return 'claude';
  warn('bugframe audit: Claude Code (claude) is not on PATH, so this run writes the probe-only report (--agent none).');
  return 'none';
}

function taskText(probe) {
  const sev = s => probe.findings.filter(f => f.severity === s).length;
  const clicks = probe.clicks.length, skipped = probe.clicks.filter(c => c.outcome?.startsWith('skipped: destructive')).length;
  return ['# Audit task', '', `Page: ${probe.url}`, `Viewports measured (light and dark): ${[...new Set(probe.viewports.map(v => `${v.width}x${v.height}`))].join(', ')}`,
    `Evidence: ${EVIDENCE_DIR}/probe.json, ${EVIDENCE_DIR}/screens/, ${EVIDENCE_DIR}/clicks/, ${EVIDENCE_DIR}/manifest.json`,
    `Probe: ${probe.findings.length} measured findings (${sev('high')} high, ${sev('medium')} medium, ${sev('low')} low); ${clicks} controls examined, ${skipped} skipped as destructive.`,
    '', `Audit this one page and output only the report, in the exact format from your instructions, titled "# Page audit: ${probe.url}".`, ''].join('\n');
}

/** The audit.json body, kept under the attachment cap. */
function auditJson(res) {
  const body = { url: res.probe.url, generatedAt: new Date().toISOString(), agent: res.agent, model: res.model ?? null, degraded: res.degraded, validationErrors: res.validation?.errors ?? [], manifest: res.manifest, probe: res.probe, ...(res.degraded && res.rawOutput ? { agentOutput: res.rawOutput.slice(0, 200_000) } : {}) };
  let json = JSON.stringify(body, null, 2);
  if (json.length > MAX_ATTACHMENT_BYTES - 1024) { delete body.agentOutput; body.probe = { ...res.probe, clicks: res.probe.clicks.slice(0, 40), findings: res.probe.findings.slice(0, 300), truncated: true }; json = JSON.stringify(body); }
  return json.length > MAX_ATTACHMENT_BYTES - 1024 ? JSON.stringify({ url: body.url, generatedAt: body.generatedAt, agent: body.agent, degraded: body.degraded, truncated: true }) : json;
}

/**
 * One audit. Builds the blind workspace, probes, runs the auditor, validates its report and falls back to the
 * probe-only report when it is unusable (degraded). With `out`, writes audit.md, audit.json and the evidence there.
 */
export async function auditOnce({ url, project, viewports, agent = 'none', agentCmd, model, click = true, timeoutMs = 900_000, keep = false, out, tmpRoot, exclude = [], allowRemote = false, signal, probe = probePage, log = () => {}, warn = m => console.error(m) }) {
  if (!project) throw new CliError('audit needs --project <the folder of the code behind this page>.');
  try { new URL(url); } catch { throw new CliError('Give the page URL to audit, e.g. http://localhost:3000/settings'); }
  if (!isLocalUrl(url)) {
    if (!allowRemote) throw new CliError(`Refusing to audit ${redactUrl(url)}: it is not a local address. The audit loads the page and clicks its controls, so it only runs against your dev server: pass --base-url http://localhost:3000 to audit the same path there, or --allow-remote to accept the risk.`);
    warn(`bugframe audit: WARNING --allow-remote: auditing ${redactUrl(url)}, which is NOT a local address. The probe loads the page and clicks its controls with your browser session's rights; it blocks writes but cannot know what a GET does on that server. Never point it at production.`);
  }
  const vps = Array.isArray(viewports) ? viewports : parseViewports(viewports);
  const ws = await createBlindWorkspace({ project, tmpRoot, exclude: [...exclude, out] });
  try {
    log(`blind copy: ${ws.manifest.copiedFiles} files, ${ws.manifest.excludedInstructions.length} instruction files left out`);
    const p = await probe({ url, viewports: vps, click, outDir: ws.evidenceDir, evidencePrefix: EVIDENCE_DIR, project, signal, log });
    await writeFile(join(ws.evidenceDir, 'manifest.json'), JSON.stringify(ws.manifest, null, 2));
    const task = taskText(p); await writeFile(join(ws.evidenceDir, 'AUDIT_TASK.md'), task);
    const res = { markdown: probeMarkdown(p), degraded: false, validation: null, rawOutput: null, probe: p, manifest: ws.manifest, agent, model, workspace: keep ? ws.dir : null };
    if (agent !== 'none') {
      const promptFile = join(ws.root, 'AUDIT_PAGE.md'); await copyFile(PROMPT_PATH, promptFile);
      log(`auditor: ${agent}`);
      try {
        res.rawOutput = await runAuditor({ agent, agentCmd, model, cwd: ws.dir, promptFile, prompt: await readFile(PROMPT_PATH, 'utf8'), task: `Audit the page ${p.url}. ${EVIDENCE_DIR}/AUDIT_TASK.md has the details; the evidence is in ${EVIDENCE_DIR}/. Output only the report.`, timeoutMs, signal, warn });
        const md = unfence(res.rawOutput); res.validation = validateAuditMarkdown(md);
        if (res.validation.ok) res.markdown = md; else res.degraded = true;
      } catch (e) { if (signal?.aborted) throw e; res.degraded = true; res.validation = { ok: false, errors: [short(e)] }; }
    }
    if (out) {
      const dir = resolve(out); await mkdir(dir, { recursive: true });
      await cp(ws.evidenceDir, join(dir, EVIDENCE_DIR), { recursive: true });
      await copyFile(PROMPT_PATH, join(dir, 'AUDIT_PAGE.md'));
      await writeFile(join(dir, 'audit.md'), res.markdown); await writeFile(join(dir, 'audit.json'), auditJson(res));
      if (res.degraded && res.rawOutput) await writeFile(join(dir, 'agent-output.txt'), res.rawOutput);
      res.out = dir;
    }
    return res;
  } catch (e) { if (signal?.aborted) throw new CliError('The audit was stopped; its blind copy was removed.'); throw e; }
  finally { if (!keep || signal?.aborted) await ws.cleanup(); }
}

/** The page to audit: the captured URL, with its origin swapped for --base-url (e.g. a local dev server). */
export function targetUrl(captured, baseUrl) {
  let u; try { u = new URL(captured); } catch { throw new CliError('The report has no valid page URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new CliError('The report page URL is not http(s).');
  if (baseUrl) { let b; try { b = new URL(baseUrl); } catch { throw new CliError('--base-url must be a URL like http://localhost:3000'); } if (!/^https?:$/.test(b.protocol)) throw new CliError('--base-url must be http(s).'); u.protocol = b.protocol; u.host = b.host; }
  return u.href;
}

/** Process one queued page-analysis report: in_progress → audit → attachments → ready_for_review, or a clear failure note. */
async function processOne(storage, r, options) {
  const log = options.log ?? (() => {}), now = () => new Date().toISOString();
  const attempts = (r.audit?.attempts ?? 0) + 1, startedAt = now();
  const current = await storage.update(r.id, { status: 'in_progress', note: `Page analysis running (attempt ${attempts} of ${MAX_ATTEMPTS}).`, closedAt: null, audit: { ...(r.audit ?? {}), attempts, startedAt },
    activity: [...(r.activity ?? []), { status: 'in_progress', note: 'Page analysis started', at: startedAt, by: 'developer' }].slice(-100) });
  try {
    const url = targetUrl(r.context?.url, options.baseUrl);
    log(`${r.id}: auditing ${redactUrl(url)}`);
    const res = await (options.audit ?? auditOnce)({ ...options, url, out: options.out ? join(resolve(options.out), r.id) : undefined });
    const canAttach = typeof storage.writeAttachment === 'function';
    if (canAttach) { await storage.writeAttachment(r.id, 'audit.md', Buffer.from(res.markdown)); await storage.writeAttachment(r.id, 'audit.json', Buffer.from(auditJson(res))); }
    const { note, counts } = summaryNote(res.markdown, { degraded: res.degraded });
    const finalNote = text(canAttach ? note : `${note.replace(' Full report: audit.md.', '')} (This storage cannot hold audit.md; only this note was saved.)`, 2000);
    const at = now();
    await storage.update(r.id, { status: 'ready_for_review', note: finalNote, closedAt: null, reviewVersion: (current?.reviewVersion ?? 0) + 1, files: { ...(r.files ?? {}), ...(canAttach ? { audit: 'audit.md' } : {}) },
      audit: { attempts, startedAt, finishedAt: at, degraded: res.degraded, counts, ...(canAttach ? {} : { noteOnly: true }) },
      activity: [...(current?.activity ?? []), { status: 'ready_for_review', note: finalNote, at, by: 'developer' }].slice(-100) });
    log(`${r.id}: ${finalNote}`);
    return true;
  } catch (e) {
    if (options.signal?.aborted) {
      const note = 'Page analysis was interrupted before it finished; it will run again.';
      await storage.update(r.id, { status: 'open', note, audit: { ...(r.audit ?? {}), attempts: attempts - 1 }, activity: [...(current?.activity ?? []), { status: 'open', note, at: now(), by: 'developer' }].slice(-100) });
      log(`${r.id}: ${note}`);
      return false;
    }
    const giveUp = attempts >= MAX_ATTEMPTS || e instanceof CliError && /no valid page URL|not http|not a local address/.test(e.message);
    const note = `Page analysis failed (attempt ${attempts} of ${MAX_ATTEMPTS}): ${short(e)}${giveUp ? ' Not retrying; run `bugframe audit <url> --project <folder>` to see the details, then reopen this request.' : ' It will be retried.'}`;
    await storage.update(r.id, { status: 'open', note: text(note, 2000), audit: { ...(r.audit ?? {}), attempts: giveUp ? Math.max(attempts, MAX_ATTEMPTS) : attempts, startedAt, lastError: short(e) },
      activity: [...(current?.activity ?? []), { status: 'open', note: text(note, 2000), at: now(), by: 'developer' }].slice(-100) });
    log(`${r.id}: ${note}`);
    return false;
  }
}

/** Reports waiting for analysis: kind audit, open, with attempts left. */
export const auditQueue = reports => reports.filter(r => r.kind === 'audit' && r.status === 'open' && (r.audit?.attempts ?? 0) < MAX_ATTEMPTS).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

/** `bugframe audit --watch`: process queued analyses from a local reports folder until stopped (or once). */
export async function watchAudits({ dir, storage, once = false, intervalMs = 5000, signal, log = m => console.log(m), ...options }) {
  const store = storage ?? createFileStorage({ dir });
  let processed = 0;
  for (;;) {
    for (const r of auditQueue(await store.list())) { if (signal?.aborted) return processed; await processOne(store, r, { ...options, log }); processed++; }
    if (once || signal?.aborted) return processed;
    try { await sleep(intervalMs, undefined, { signal }); } catch { return processed; }
  }
}

export { stamp };

/** The `bugframe audit` command line. */
export async function auditCommand(url, v, dir, { checkBlind } = {}) {
  if (v.remote) throw new CliError('bugframe audit works on a local reports folder (--dir). Remote mode is not supported because the API has no route for uploading results; run it where the reports folder lives.');
  if (v['check-blind']) {
    const r = await (checkBlind ?? (await import('./runner.mjs')).checkBlind)({ model: v.model });
    console.log(r.lines.join('\n'));
    if (!r.ok) throw new CliError('Blindness check FAILED: do not rely on --agent claude being blind on this machine.');
    return 'Blindness check passed: no instruction file reached the auditor and reads outside its workspace were refused.';
  }
  const timeoutMs = v.timeout === undefined ? 900_000 : Number(v.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 7_200_000) throw new CliError('--timeout is the auditor time limit in milliseconds (10000–7200000).');
  const agent = chooseAgent({ agent: v.agent, agentCmd: v['agent-cmd'] });
  const log = m => console.error(`[audit] ${m}`);
  // First Ctrl+C (or SIGTERM): kill the running auditor's process group, stop the probe, remove the blind copy, then exit.
  // A second one exits at once after the same cleanup done synchronously.
  const controller = new AbortController(); let signals = 0;
  const stop = () => {
    if (++signals > 1) { killAllChildren(); cleanupAllSync(); process.exit(130); }
    log('stopping: ending the auditor and removing the blind copy (Ctrl+C again to force)');
    controller.abort();
  };
  const common = { project: v.project, viewports: parseViewports(v.viewports), agent, agentCmd: v['agent-cmd'], model: v.model, click: !v['no-click'], timeoutMs, keep: v.keep, allowRemote: v['allow-remote'],
    exclude: [dir, v.out], signal: controller.signal, log };
  if (v.watch && url) throw new CliError('--watch takes no URL: it reads page-analysis requests from --dir.');
  if (v.watch && !v.project) throw new CliError('audit --watch needs --project <the folder of the code behind the pages>.');
  if (!v.watch && !url) throw new CliError('Usage: bugframe audit <url> --project <folder> [options], or bugframe audit --watch --dir <reports> --project <folder>.');
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (v.watch) {
      log(`watching ${resolve(dir)} for page-analysis requests${v.once ? ' (once)' : '; Ctrl+C to stop'}`);
      const n = await watchAudits({ dir, once: v.once, baseUrl: v['base-url'], out: v.out, ...common });
      return `Processed ${n} page-analysis request${n === 1 ? '' : 's'}${controller.signal.aborted ? ' (stopped)' : ''}.`;
    }
    return await auditOne(v['base-url'] ? targetUrl(url, v['base-url']) : url, v, common);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

async function auditOne(url, v, common) {
  const res = await auditOnce({ url, out: v.out ?? join('bugframe-audit', stamp()), ...common });
  const lines = [`Wrote ${join(res.out, 'audit.md')}`, summaryNote(res.markdown, { degraded: res.degraded }).note];
  if (res.degraded) lines.push(`Degraded: the auditor's answer was not usable (${(res.validation?.errors ?? []).slice(0, 3).join('; ')}). audit.md is the probe-only report${res.rawOutput ? '; the raw answer is in agent-output.txt' : ''}.`);
  if (res.workspace) lines.push(`Blind workspace kept at ${res.workspace} (delete it when done).`);
  return lines.join('\n');
}
