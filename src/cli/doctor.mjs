// `bugframe doctor`: what works on this machine and how to get the rest. It only looks; it changes nothing.
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { ID_RE } from '../server/util.mjs';
import { shown } from './commands.mjs';
import { loadPlaywright } from './audit/probe.mjs';
import { onPath as findOnPath } from './audit/runner.mjs';

/** The installed Playwright: { version, chromium: is its browser downloaded } or null when it cannot be loaded. */
async function findPlaywright(project) {
  let pw; try { pw = await loadPlaywright(project); } catch { return null; }
  let version = 'unknown';
  for (const from of [project ? join(resolve(project), 'package.json') : null, import.meta.url].filter(Boolean)) {
    for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
      try { version = JSON.parse(readFileSync(createRequire(from).resolve(`${name}/package.json`), 'utf8')).version; break; } catch { /* try the next */ }
    }
    if (version !== 'unknown') break;
  }
  let chromium = false; try { chromium = existsSync(pw.chromium.executablePath()); } catch { /* not downloaded */ }
  return { version, chromium };
}
const older = (version, than) => { const [a, b] = String(version).split('.').map(Number), [x, y] = than.split('.').map(Number); return Number.isFinite(a) && (a < x || (a === x && b < y)); };

export async function doctor({ dir = './bug-reports', project, node = process.versions.node, onPath = findOnPath, playwright = findPlaywright } = {}) {
  const rows = [], add = (state, text) => rows.push(`${state.padEnd(9)}${text}`);
  if (older(node, '18.17')) add('problem', `Node.js ${node}: Bugframe needs 18.17 or newer`); else add('ok', `Node.js ${node}`);
  const folder = resolve(dir);
  try { const n = (await readdir(folder)).filter(name => ID_RE.test(name)).length; add('ok', `Reports folder ${shown(folder)}: ${n} report${n === 1 ? '' : 's'}`); }
  catch { add('missing', `Reports folder ${shown(folder)}: it is created by the first report (or point --dir / BUGFRAME_DIR at the right one)`); }
  const pw = await playwright(project).catch(() => null);
  if (!pw) add('missing', 'Playwright: needed for audit and crawl. Install it with: npm i -D playwright && npx playwright install chromium');
  else if (older(pw.version, '1.48')) add('problem', `Playwright ${pw.version}: audit and crawl need 1.48 or newer (they must block WebSockets). Update it with: npm i -D playwright@latest`);
  else if (!pw.chromium) add('problem', `Playwright ${pw.version}: its Chromium is not downloaded. Run: npx playwright install chromium`);
  else add('ok', `Playwright ${pw.version} with Chromium (audit, crawl)`);
  if (onPath('claude')) add('ok', 'Claude Code (claude): auditor for audit, fix plan for crawl --summarize. Verify: bugframe audit --check-blind');
  else add('missing', 'Claude Code (claude): not on PATH, so audit writes the measured report only (--agent none) and crawl --summarize is unavailable; --agent-cmd runs another auditor');
  if (onPath('codex')) add('ok', 'Codex CLI (codex): for connect codex');
  else add('missing', 'Codex CLI (codex): only needed for connect codex; connect agent --agent-cmd runs any other agent or script');
  return `${rows.join('\n')}\n\nNothing here is required to collect feedback: the widget, the server and list/show/export/ready need Node.js only.`;
}
