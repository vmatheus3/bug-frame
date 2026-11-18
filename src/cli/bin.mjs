#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBugframe } from '../server/handler.mjs';
import { toNodeListener } from '../server/node.mjs';
import { CliError, cmdClose, cmdExport, cmdImport, cmdList, cmdReady, cmdReopen, cmdShow } from './commands.mjs';
import { setupProject } from './setup.mjs';
import { connectCodex } from './codex.mjs';
import { remoteCommand, remoteCredentials, remoteExport } from './remote.mjs';
import { auditCommand } from './audit/index.mjs';
import { crawlCommand } from './crawl/index.mjs';

const HELP = `bugframe - collect visual feedback and hand them to a person or an AI agent

Usage: bugframe [--dir ./bug-reports] <command> [options]

Commands:
  setup --site https://your-site.example [--project FOLDER] [--auth-module FILE]
                                       website login, no extra customer password; private Codex setup
  connect codex --remote HTTPS_API --project FOLDER [--include-existing] [--once]
                                       notify a dedicated Codex inbox about new requests; keep running
  list [--open] [--json]               one line per report
  show <id> [--json]                   everything recorded for one report
  export [--all] [--out WORKLIST.md] [--budget TOKENS|NNNc|none] [--playwright]
                                       write the grouped work list (open reports unless --all);
                                       over budget it dedupes near-identical reports and trims with
                                       explicit markers (opt-in; default and "none" = unlimited);
                                       --playwright also writes failing-first repro test skeletons
  close <id> --note "..." [--status fixed|wontfix]
  ready <id> --note "what changed and what to review"
  reopen <id>
  import <report.zip>                  unpack a report downloaded from a backend-less page
  audit <url> --project FOLDER [--out DIR] [--viewports 390x844,768x1024,1280x800,1440x900]
        [--agent claude|none | --agent-cmd "CMD"] [--model ID] [--no-click] [--settle-ms 700] [--timeout MS] [--keep]
        [--base-url http://localhost:3000] [--allow-remote]
                                       blind page analysis: browser probe + an auditor that sees the
                                       code but no agent-instruction files; writes audit.md. Local pages
                                       only (localhost, *.localhost, *.test, 127.x, ::1) unless --base-url
                                       rewrites the origin or --allow-remote accepts a remote one
  audit --watch --dir REPORTS --project FOLDER [--base-url http://localhost:3000] [--once] [--allow-remote]
                                       process "Analyze this page" requests from the widget
  audit --watch --remote HTTPS_API --project FOLDER --base-url http://localhost:3000
                                       the same against a hosted API: results are uploaded to it
  audit --check-blind [--model ID]     prove on this machine that the auditor is blind and confined
  crawl <start-url> [--out DIR] [--max-pages 200] [--max-depth 6] [--include GLOB]... [--exclude GLOB]...
        [--viewports 390x844,1440x900] [--storage-state FILE] [--no-click] [--max-controls-per-page 60]
        [--concurrency 2] [--timeout MS] [--settle-ms 700] [--max-minutes 30] [--fail-on high|medium|low|none]
        [--allow-remote] [--summarize [--model haiku] [--budget 20000]]
                                       whole-site check, no AI tokens: opens every page (same-origin,
                                       one route per id pattern, max 2 each), clicks every safe control
                                       (writes blocked, destructive and sign-out skipped) and reports dead
                                       buttons, broken links, inconsistent navigation and wiring; writes
                                       crawl.html, CRAWL.md and crawl.json. Local sites only unless
                                       --allow-remote. --summarize: optional fix plan by a small model
  crawl login <url> [--save .bugframe-auth.json]
                                       open a browser, sign in yourself, save the session for --storage-state
  serve [--port 4455] [--origin URL]... [--auth-module FILE] [--admin-token T] [--webhook URL] [--webhook-secret S]
                                       authorized sessions via a module exporting authorize(request), or admin-token access only
                                       set BUGFRAME_ADMIN_TOKEN / BUGFRAME_AUTH_MODULE to keep config out of shell history

Options:
  --dir <folder>   reports folder (env BUGFRAME_DIR, default ./bug-reports)
  --remote <HTTPS URL>   operate on a hosted API (list/show/export/close/ready/reopen, audit --watch); excludes --dir
                        export copies the open requests and pictures to ./bugframe-remote/ (or --out FILE's folder)
  --credentials <file>  private JSON file containing adminToken (or BUGFRAME_ADMIN_TOKEN)
  --timeout <ms>        remote request timeout, default 30000
  -h, --help       this text          -v, --version   print the version
`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      'allow-localhost': { type: 'boolean' }, site: { type: 'string' }, project: { type: 'string' }, interval: { type: 'string' }, 'state-dir': { type: 'string' }, once: { type: 'boolean' }, 'include-existing': { type: 'boolean' },
      dir: { type: 'string' }, remote: { type: 'string' }, credentials: { type: 'string' }, timeout: { type: 'string' }, open: { type: 'boolean' }, all: { type: 'boolean' }, json: { type: 'boolean' }, out: { type: 'string' }, budget: { type: 'string' }, playwright: { type: 'boolean' }, note: { type: 'string' }, status: { type: 'string' },
      port: { type: 'string' }, host: { type: 'string' }, origin: { type: 'string', multiple: true }, 'client-token': { type: 'string', multiple: true }, 'admin-token': { type: 'string' }, webhook: { type: 'string' }, 'webhook-secret': { type: 'string' },
      viewports: { type: 'string' }, agent: { type: 'string' }, 'agent-cmd': { type: 'string' }, model: { type: 'string' }, 'no-click': { type: 'boolean' }, watch: { type: 'boolean' }, 'base-url': { type: 'string' }, keep: { type: 'boolean' }, 'check-blind': { type: 'boolean' }, 'allow-remote': { type: 'boolean' },
      'max-pages': { type: 'string' }, 'max-depth': { type: 'string' }, include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true }, 'storage-state': { type: 'string' }, 'max-controls-per-page': { type: 'string' },
      concurrency: { type: 'string' }, 'max-minutes': { type: 'string' }, 'settle-ms': { type: 'string' }, 'fail-on': { type: 'string' }, summarize: { type: 'boolean' }, save: { type: 'string' },
      'auth-module': { type: 'string' }, 'base-path': { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.version) { const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')); return pkg.version; }
  if (values.help || !cmd) return HELP;
  const dir = values.dir ?? process.env.BUGFRAME_DIR ?? './bug-reports';
  const need = () => { if (!arg) throw new CliError(`${cmd} needs an id`); return arg; };
  if (cmd === 'setup') return setupProject({ project: values.project, site: values.site, authModule: values['auth-module'] });
  if (cmd === 'connect') {
    if (arg !== 'codex' || !values.remote || values.dir) throw new CliError('Use connect codex --remote HTTPS_API_URL --project PROJECT_FOLDER.');
    const token = await remoteCredentials(values.credentials), controller = new AbortController();
    const stop = () => controller.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await connectCodex({ endpoint: values.remote, token, project: values.project, stateDir: values['state-dir'], intervalMs: Number(values.interval ?? 5000), once: values.once, includeExisting: values['include-existing'], allowInsecureLocalhost: values['allow-localhost'], signal: controller.signal }); return null; }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
  if (cmd === 'audit') return auditCommand(arg, { ...values, dir: values.dir }, dir);
  if (cmd === 'crawl') return crawlCommand(positionals.slice(1), values);
  if (values.remote) {
    if (values.dir) throw new CliError('--remote and --dir cannot be combined.');
    if (!['list', 'show', 'export', 'close', 'ready', 'reopen'].includes(cmd)) throw new CliError('Remote mode supports list, show, export, close, ready and reopen (and audit --watch).');
    const token = await remoteCredentials(values.credentials);
    if (cmd === 'export') return (await remoteExport({ endpoint: values.remote, token, timeoutMs: Number(values.timeout ?? 30000), allowInsecureLocalhost: values['allow-localhost'], all: values.all, out: values.out, budget: values.budget, playwright: values.playwright })).message;
    return remoteCommand(cmd, arg, { endpoint: values.remote, token, timeoutMs: Number(values.timeout ?? 30000), allowInsecureLocalhost: values['allow-localhost'], json: values.json, open: values.open, note: values.note, status: values.status });
  }
  if (values.credentials || values.timeout) throw new CliError('--credentials and --timeout require --remote.');
  switch (cmd) {
    case 'list': return cmdList(dir, { open: values.open, json: values.json });
    case 'show': return cmdShow(dir, need(), { json: values.json });
    case 'export': return (await cmdExport(dir, { all: values.all, out: values.out, budget: values.budget, playwright: values.playwright })).message;
    case 'close': return cmdClose(dir, need(), { note: values.note, status: values.status });
    case 'ready': return cmdReady(dir, need(), { note: values.note });
    case 'reopen': return cmdReopen(dir, need());
    case 'import': return (await cmdImport(dir, need())).message;
    case 'serve': {
      const adminToken = values['admin-token'] ?? process.env.BUGFRAME_ADMIN_TOKEN;
      if (values['client-token'] || process.env.BUGFRAME_CLIENT_TOKEN) throw new CliError('Public client tokens no longer authorize reporters. Use --auth-module with verified login sessions.');
      const authPath = values['auth-module'] ?? process.env.BUGFRAME_AUTH_MODULE;
      let authorize;
      if (authPath) {
        const module = await import(pathToFileURL(resolve(authPath)).href);
        if (typeof module.authorize !== 'function') throw new CliError('--auth-module must export an authorize(request) function');
        authorize = module.authorize;
      }
      if (!adminToken && !authorize) throw new CliError('serve requires BUGFRAME_ADMIN_TOKEN or --auth-module. Anonymous reporting is disabled.');
      const bf = createBugframe({ dir, basePath: values['base-path'] ?? '', authorize, adminToken, allowedOrigins: values.origin ?? [],
        webhook: values.webhook ? { url: values.webhook, secret: values['webhook-secret'] } : undefined, logger: (...a) => console.error('[bugframe]', ...a) });
      const port = Number(values.port ?? process.env.PORT ?? 4455), host = values.host ?? '127.0.0.1';
      await new Promise(res => createServer(toNodeListener(bf)).listen(port, host, res));
      console.log(`bugframe server on http://${host}:${port}${bf.basePath} saving to ${dir}`);
      return null; // keep running
    }
    default: throw new CliError(`Unknown command "${cmd}". Run bugframe --help.`);
  }
}

main(process.argv.slice(2)).then(out => { if (out) console.log(out); }, e => {
  console.error(e instanceof CliError || e?.code?.startsWith?.('ERR_PARSE_ARGS') ? `bugframe: ${e.message}` : e);
  process.exit(e instanceof CliError || e?.code?.startsWith?.('ERR_PARSE_ARGS') ? 2 : 1);
});
