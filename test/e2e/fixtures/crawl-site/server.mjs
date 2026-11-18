// A small CRM-like site with planted wiring problems for the `bugframe crawl` end-to-end test. Every problem is
// intentional. The server records every request and WebSocket upgrade, so the test can prove nothing mutating,
// destructive or session-ending ever reached it.
import { createServer } from 'node:http';

export const SESSION_COOKIE = 'fixture_session';
const NAV = [['Home', '/'], ['Clients', '/clients'], ['App', '/app'], ['Contact', '/contact']];
// The About page's menu is out of step: no "App", and "Contact" points somewhere else.
const ABOUT_NAV = [['Home', '/'], ['Clients', '/clients'], ['Contact', '/support']];

function layout({ title, h1, body, nav = NAV, script = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#111;background:#fff}header,main,footer{padding:12px 20px}nav{display:flex;gap:16px}a{color:#0b4f8a}button{min-height:32px;margin:4px}</style></head>
<body><header><a href="/" id="logo">Fixture CRM</a><nav aria-label="Main">${nav.map(([l, h]) => `<a href="${h}">${l}</a>`).join('')}</nav></header>
<main>${h1 === null ? '' : `<h1>${h1}</h1>`}${body}</main><footer><a href="/about">About</a> · <a href="/account">Account</a></footer>
<script>console.error('Theme config missing: palette');${script}</script></body></html>`;
}

const PAGES = {
  '/': () => layout({ title: 'Dashboard · Fixture CRM', h1: 'Dashboard', body: `
<p><a href="/pricing">Pricing</a> · <a href="/clients?utm_source=newsletter">Clients (newsletter)</a></p>
<button id="export" type="button">Export &lt;img src=x onerror=alert(1)&gt;</button>
<button id="save" type="button">Save</button>
<button id="open-menu" type="button" aria-expanded="false" aria-controls="menu">Open menu</button>
<button id="delete-account" type="button">Delete account</button>
<div id="menu" role="dialog" aria-label="Quick menu" hidden><p>Quick menu</p></div>`,
  script: `
document.getElementById('save').addEventListener('click', () => { fetch('/api/save', { method: 'POST', body: '{}' }).catch(() => {}); });
document.getElementById('open-menu').addEventListener('click', e => { document.getElementById('menu').hidden = false; e.currentTarget.setAttribute('aria-expanded', 'true'); });
document.getElementById('delete-account').addEventListener('click', () => { fetch('/api/account', { method: 'DELETE' }); fetch('/api/account/delete'); });
try { new WebSocket('ws://' + location.host + '/live'); } catch (e) {}` }),
  '/clients': () => layout({ title: 'Clients · Fixture CRM', h1: 'Clients', body: `<ul>${Array.from({ length: 50 }, (_, i) => `<li><a href="/clients/${i + 1}">Client ${i + 1}</a></li>`).join('')}</ul>` }),
  '/about': () => layout({ title: 'About · Fixture CRM', h1: 'About', nav: ABOUT_NAV, body: '<p>We build a fixture.</p>' }),
  '/contact': () => layout({ title: 'Contact · Fixture CRM', h1: 'Contact', body: '<p>Write to us.</p>' }),
  '/support': () => layout({ title: 'Support · Fixture CRM', h1: 'Support', body: '<p>Support desk.</p>' }),
  '/orphan': () => layout({ title: 'Old campaign · Fixture CRM', h1: 'Old campaign', body: '<p>Nothing links here; only the sitemap lists it.</p>' }),
  '/login': () => layout({ title: 'Sign in · Fixture CRM', h1: 'Sign in', body: '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><button type="submit">Sign in</button></form>' }),
  // A hash-router app: #/reports is reachable only by clicking "Open reports".
  '/app': () => layout({ title: 'App · Fixture CRM', h1: 'App', body: '<div id="view"></div>', script: `
const view = document.getElementById('view');
function render() {
  if (location.hash === '#/reports') { view.innerHTML = '<h2>Reports</h2><button id="refresh" type="button">Refresh reports</button>'; document.getElementById('refresh').addEventListener('click', () => fetch('/api/reports')); }
  else { view.innerHTML = '<button id="open-reports" type="button">Open reports</button>'; document.getElementById('open-reports').addEventListener('click', () => { location.hash = '#/reports'; }); }
}
window.addEventListener('hashchange', render); render();` }),
};
const CLIENT = n => layout({ title: `Client ${n} · Fixture CRM`, h1: `Client ${n}`, body: '<p><a href="/clients">Back</a></p><button id="client-save" type="button">Save</button>' });
const ACCOUNT = () => layout({ title: 'Account · Fixture CRM', h1: 'Your account', body: '<p>Signed in.</p><p><a href="/logout">Sign out</a></p>' });
const SITEMAP = origin => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/clients', '/about', '/orphan'].map(p => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`;

/** Start the fixture on a free localhost port. */
export async function startCrawlSite() {
  const seen = [], sockets = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'), path = url.pathname;
    seen.push({ method: req.method ?? '', path, url: req.url ?? '' });
    const signedIn = (req.headers.cookie ?? '').split(';').some(c => c.trim() === `${SESSION_COOKIE}=ok`);
    const html = (body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('no'); }
    if (path === '/sitemap.xml') { res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(SITEMAP(`http://${req.headers.host}`)); }
    if (path === '/api/reports') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
    if (path === '/account') { if (!signedIn) { res.writeHead(302, { location: '/login' }); return res.end(); } return html(ACCOUNT()); }
    const m = /^\/clients\/(\d+)$/.exec(path); if (m && Number(m[1]) >= 1 && Number(m[1]) <= 50) return html(CLIENT(m[1]));
    if (PAGES[path]) return html(PAGES[path]());
    html('<!doctype html><title>Not found</title><h1>Not found</h1>', 404);
  });
  server.on('upgrade', (req, socket) => { sockets.push(req.url ?? ''); socket.destroy(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, sockets, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

if (import.meta.url === `file://${process.argv[1]}`) { const s = await startCrawlSite(); console.log(s.base); }
