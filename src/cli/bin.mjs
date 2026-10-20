#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBugframe } from '../server/handler.mjs';
import { toNodeListener } from '../server/node.mjs';
import { CliError, cmdClose, cmdExport, cmdImport, cmdList, cmdReopen, cmdShow } from './commands.mjs';
import { createRemote } from './remote.mjs';

const HELP = `bugframe - collect screenshot bug reports and hand them to a person or an AI agent

Usage: bugframe [--dir ./bug-reports] [--remote URL] <command> [options]

Commands:
  list [--open] [--json]               one line per report
  show <id> [--json]                   everything recorded for one report
  export [--all] [--out WORKLIST.md]   write the grouped work list (open reports unless --all)
  close <id> --note "..." [--status fixed|wontfix]
  reopen <id>
  import <report.zip>                  unpack a report downloaded from a backend-less page
  serve [--port 4455] [--origin URL]... [--auth-module FILE] [--admin-token T] [--webhook URL] [--webhook-secret S]
                                       authorized sessions via a module exporting authorize(request), or admin-token access only
                                       set BUGFRAME_ADMIN_TOKEN / BUGFRAME_AUTH_MODULE to keep config out of shell history

Options:
  --dir <folder>   reports folder (env BUGFRAME_DIR, default ./bug-reports)
  --remote <url>   run list, show, export, close and reopen against a hosted server's API instead (env BUGFRAME_REMOTE);
                   show and export also download the reports they print into --dir
  --token <T>      the server's admin token for --remote (env BUGFRAME_REMOTE_TOKEN keeps it out of shell history)
  -h, --help       this text          -v, --version   print the version
`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      dir: { type: 'string' }, open: { type: 'boolean' }, all: { type: 'boolean' }, json: { type: 'boolean' }, out: { type: 'string' }, note: { type: 'string' }, status: { type: 'string' },
      port: { type: 'string' }, host: { type: 'string' }, origin: { type: 'string', multiple: true }, 'client-token': { type: 'string', multiple: true }, 'admin-token': { type: 'string' }, webhook: { type: 'string' }, 'webhook-secret': { type: 'string' },
      'auth-module': { type: 'string' }, 'base-path': { type: 'string' }, remote: { type: 'string' }, token: { type: 'string' },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.version) { const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')); return pkg.version; }
  if (values.help || !cmd) return HELP;
  const dir = values.dir ?? process.env.BUGFRAME_DIR ?? './bug-reports';
  const need = () => { if (!arg) throw new CliError(`${cmd} needs an id`); return arg; };
  const remoteUrl = values.remote ?? process.env.BUGFRAME_REMOTE;
  if (remoteUrl && (cmd === 'import' || cmd === 'serve')) throw new CliError(`${cmd} works on a local folder only. Run it without --remote (and without BUGFRAME_REMOTE).`);
  // Its own token variable: BUGFRAME_ADMIN_TOKEN is this machine's server secret and must never travel to another server.
  const remote = () => (remoteUrl ? createRemote({ url: remoteUrl, token: values.token ?? process.env.BUGFRAME_REMOTE_TOKEN }) : undefined);
  switch (cmd) {
    case 'list': return cmdList(dir, { open: values.open, json: values.json, remote: remote() });
    case 'show': return cmdShow(dir, need(), { json: values.json, remote: remote() });
    case 'export': return (await cmdExport(dir, { all: values.all, out: values.out, remote: remote() })).message;
    case 'close': return cmdClose(dir, need(), { note: values.note, status: values.status, remote: remote() });
    case 'reopen': return cmdReopen(dir, need(), { remote: remote() });
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
