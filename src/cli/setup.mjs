import { mkdir, readFile, writeFile, appendFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { CliError } from './commands.mjs';

/** Generate a private, fail-closed starter that uses the website's own login, with no customer review password. */
export async function setupProject({ project = process.cwd(), site, authModule } = {}) {
  project = await realpath(resolve(project));
  let url; try { url = new URL(site); } catch { throw new CliError('setup needs --site https://your-website.example'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new CliError('Use an HTTPS website origin without a path, credentials, query or fragment.');
  const folder = join(project, '.bugframe'), ignore = join(project, '.gitignore');
  try { const stat = await lstat(ignore); if (!stat.isFile()) throw new CliError('The project .gitignore must be a regular file.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (authModule) { authModule = await realpath(resolve(project, authModule)); if (!(await lstat(authModule)).isFile()) throw new CliError('The authentication module must be a file exporting authorize(request).'); }
  try { await mkdir(folder, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new CliError('.bugframe already exists. Existing setup and credentials were preserved.'); throw error; }
  const key = createHash('sha256').update(url.origin).digest('hex').slice(0, 16);
  const authorizeImport = authModule ? `import { authorize } from ${JSON.stringify(pathToFileURL(authModule).href)};` : "import { authorize } from './auth.mjs';";
  const server = `import { createServer } from 'node:http';
import { readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBugframe, createInbox, toNodeListener } from 'bugframe/server';
${authorizeImport}
let adminToken = process.env.BUGFRAME_ADMIN_TOKEN;
if (!adminToken) {
  const file = new URL('./credentials.json', import.meta.url), stat = await lstat(file);
  if (!stat.isFile() || process.platform !== 'win32' && (stat.mode & 0o077 || stat.uid !== process.getuid())) throw new Error('Keep credentials.json private (chmod 600).');
  adminToken = JSON.parse(await readFile(file, 'utf8')).adminToken;
}
const bf = createBugframe({ dir: process.env.BUGFRAME_DATA_DIR ?? join(homedir(), '.local/share/bugframe', '${key}', 'reports'), basePath: '/api/bugframe', authorize, invitations: true, adminToken });
const inbox = createInbox({ bugframe: bf, siteName: ${JSON.stringify(url.hostname)}, loginUrl: '/login', siteUrl: '/?bugs=1', locale: 'auto' });
const proxyOptions = { trustProxy: process.env.BUGFRAME_TRUST_PROXY === '1' };
const api = toNodeListener(bf, proxyOptions), review = toNodeListener(inbox, proxyOptions);
createServer((req, res) => { if (inbox.matches(req.url)) return review(req, res); if (bf.matches(req.url)) return api(req, res); res.writeHead(404); res.end('Mount these routes behind your website.'); }).listen(Number(process.env.PORT ?? 4455), '127.0.0.1');
console.log('Bugframe is private. Use the website login, and mount /api/bugframe and /bugs on the website origin. See AGENT_SETUP.md.');
`;
  const command = `npx bugframe connect codex --remote ${url.origin}/api/bugframe --project . --credentials .bugframe/credentials.json`;
  const guide = `# Connect Bugframe to this project\n\nCustomer access: the website's existing verified login. No separate Bugframe code or password.\n\n1. Inspect this application's current login/session verifier and server routing. Implement auth.mjs (or the supplied module) using that verifier: disabled/unsigned/unverifiable sessions return null; administrators return { id, role: 'admin' }; existing approved reporters return { id, role: 'client' }; invitation-only accounts return { id, role: 'user', email, emailVerified: true } only after verifying actual email ownership. Preserve stable account IDs.\n2. Mount the generated Bugframe API at /api/bugframe and createInbox at /bugs using this application's framework adapter or the local starter behind a same-origin proxy. Keep report storage private and persistent outside source/static roots. For the standalone starter behind an HTTPS proxy you control, strip incoming forwarded headers and set BUGFRAME_TRUST_PROXY=1; framework-native HTTPS Request adapters do not need that setting. There is no customer password form to add.\n3. Load the widget only when the private /access check succeeds: init({ endpoint: '/api/bugframe', enable: 'always', allowDownloadFallback: false, loginUrl: '/login' }). It adds the screenshot automatically. Customers write one message and send; spot selection and categories are optional. Use the existing application sign-in URL if it differs from /login.\n4. Keep credentials.json out of Git, screenshots, prompts and browser code. It is only for the local Codex connector/server operations. Use the hosting secret store for BUGFRAME_ADMIN_TOKEN and a persistent BUGFRAME_DATA_DIR when deploying. Never turn on anonymous reporting.\n5. Verify: guests are denied; approved users send and see only their own requests; admins manage requests/invitations; mobile users can send above the keyboard; expired logins show the real sign-in link; notifications arrive once in a dedicated Codex inbox during normal reconnects.\n\nAfter installing/signing into the Codex CLI, run this in the project terminal and keep it running:\n\n    ${command}\n\nThe first connection watches for new tickets. Use --include-existing on its first run to also notify about existing tickets. Short acknowledgment turns use the signed-in Codex account and its usage limits. Notifications include ticket IDs, not untrusted report descriptions, and run with read-only permissions. Connection state is private under ~/.config/bugframe/connections.\n\nThe standalone starter is node .bugframe/server.mjs; its default access stays denied until the real website session verifier is connected. Integrate its handlers with the existing project for production.\n`;
  let ignored = ''; try { ignored = await readFile(ignore, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!ignored.split(/\r?\n/).some(line => line.trim() === '.bugframe/' || line.trim() === '/.bugframe/')) await appendFile(ignore, (ignored && !ignored.endsWith('\n') ? '\n' : '') + '.bugframe/\n');
  await writeFile(join(folder, 'credentials.json'), JSON.stringify({ adminToken: randomBytes(32).toString('hex') }, null, 2), { flag: 'wx', mode: 0o600 });
  await writeFile(join(folder, 'server.mjs'), server, { flag: 'wx', mode: 0o600 });
  if (!authModule) await writeFile(join(folder, 'auth.mjs'), '// Connect the real website session verifier here. Login alone is not reporting permission.\nexport async function authorize(request) { return null; }\n', { flag: 'wx', mode: 0o600 });
  await writeFile(join(folder, 'AGENT_SETUP.md'), guide, { flag: 'wx', mode: 0o600 });

  return `Created .bugframe/ with private setup files. Customers use the website login; no extra Bugframe password.\nAsk Codex to follow .bugframe/AGENT_SETUP.md to connect the existing session verifier and routes.\nThen keep this running:\n${command}`;
}
