// A site that tries everything the crawl guard must stop, for the `bugframe crawl` safety tests: sockets and writes
// from Web Workers, SharedWorkers and iframes, redirects that leave the site, sign-out controls under other names, GET
// endpoints that end the session, a page that never stops changing, and a calendar that links to itself forever.
// Both servers record every request and WebSocket upgrade. `other` stands in for a different website.
import { createServer } from 'node:http';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const js = (res, body) => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(body); };

function page(title, body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Hostile fixture</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#111;background:#fff}header,main{padding:12px 20px}nav{display:flex;gap:16px}a{color:#0b4f8a}button{min-height:32px;margin:4px}</style></head>
<body><header><nav aria-label="Main"><a href="/">Home</a><a href="/poll">Live board</a><a href="/workers">Workers</a></nav></header>
<main><h1>${title}</h1>${body}</main><script>${script}</script></body></html>`;
}

/** Start the hostile site and the "other website" it tries to reach. */
export async function startHostileSite() {
  const seen = [], sockets = [], otherSeen = [];
  const other = createServer((req, res) => {
    otherSeen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Another website</title><h1>Another website</h1><script>fetch("/tracked")</script>');
  });
  const otherBase = await listen(other);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x'), path = url.pathname;
    seen.push({ method: req.method ?? '', path, url: req.url ?? '' });
    const html = (body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('no'); }
    switch (path) {
      case '/': return html(page('Home', `
<p><a href="/out">Partner</a> · <a href="/go-off">Jump</a> · <a href="/hop">Moved page</a> · <a href="#" id="hash-dead">Hash dead</a> · <a href="#notes" id="to-notes">Notes</a> · <a href="/bye">Sign out</a> · <a href="/cal/2026-01">Calendar</a></p>
<button id="logoff" type="button">Log off</button>
<button id="leave" type="button">Switch workspace</button>
<button id="ends" type="button">Encerrar sessão</button>
<button id="moved" type="button">Open moved page</button>
<button id="away" type="button">Open partner</button>
<button id="sync" type="button">Sync now</button>
<p id="notes">Notes live here.</p>`, `
document.getElementById('logoff').onclick = () => { location.href = '/logoff'; };
document.getElementById('ends').onclick = () => { location.href = '/session/end'; };
document.getElementById('leave').onclick = () => { fetch('/api/logout').catch(() => {}); };
document.getElementById('moved').onclick = () => { location.href = '/hop'; };
document.getElementById('away').onclick = () => { location.href = '/go-off'; };
document.getElementById('sync').onclick = () => { fetch('/api/sync', { method: 'POST', body: '{}' }); }; // no catch: the block must not read as a bug`));
      // Redirects: two leave the site, one stays on it (and must keep working).
      case '/out': res.writeHead(302, { location: `${otherBase}/landing?from=out` }); return res.end();
      case '/go-off': res.writeHead(302, { location: `${otherBase}/clicked` }); return res.end();
      case '/hop': res.writeHead(302, { location: '/landed' }); return res.end();
      case '/landed': return html(page('Landed', '<p>The redirect stayed on this site.</p>'));
      // A page that never stops: a poll every 200 ms and a ticking clock. "Archive" has no handler; "Filters" works.
      case '/poll': return html(page('Live board', `
<p>Updated <span id="clock"></span></p><button id="archive" type="button">Archive</button><button id="filters" type="button" aria-expanded="false">Filters</button>
<div id="panel" role="dialog" aria-label="Filters" hidden><p>Filter panel</p></div>`, `
setInterval(() => fetch('/api/poll').catch(() => {}), 200);
setInterval(() => { document.getElementById('clock').textContent = String(Date.now()); }, 100);
document.getElementById('filters').onclick = e => { document.getElementById('panel').hidden = false; e.currentTarget.setAttribute('aria-expanded', 'true'); };`));
      case '/api/poll': res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]');
      // Workers of every kind, each trying a socket and a write. The dedicated worker also answers the page.
      case '/workers': return html(page('Workers', `
<p id="worker-status">starting</p><button id="ask" type="button">Ask the worker</button><p id="answer"></p><iframe src="/frame" title="Embedded"></iframe>`, `
const worker = new Worker('/worker.js?lang=en');
worker.onmessage = e => { if (e.data === 'ready') document.getElementById('worker-status').textContent = 'worker ready'; else document.getElementById('answer').textContent = String(e.data); };
document.getElementById('ask').onclick = () => worker.postMessage('ask');
new Worker('/module-worker.js', { type: 'module' });
const inline = URL.createObjectURL(new Blob(["try { new WebSocket('ws://${req.headers.host}/blob-ws'); } catch (e) {}"], { type: 'text/javascript' }));
new Worker(inline); URL.revokeObjectURL(inline);
try { new SharedWorker('/shared.js'); } catch (e) {}`));
      case '/frame': return html(`<!doctype html><title>Frame</title><p>frame</p><script>try { new WebSocket('ws://' + location.host + '/frame-ws'); } catch (e) {} new Worker('/worker.js?from=frame');</script>`);
      case '/worker.js': return js(res, `'use strict';
try { new WebSocket('ws://' + location.host + '/worker-ws'); } catch (e) {}
fetch('/api/worker-write', { method: 'POST', body: 'x' }).catch(() => {});
importScripts('/imported.js');
try { new Worker('/nested.js'); } catch (e) {}
onmessage = () => postMessage('the worker answered (' + new URLSearchParams(location.search).get('lang') + ')');
postMessage('ready');`);
      case '/imported.js': return js(res, `try { new WebSocket('ws://' + location.host + '/imported-ws'); } catch (e) {}`);
      case '/nested.js': return js(res, `try { new WebSocket('ws://' + location.host + '/nested-ws'); } catch (e) {}`);
      case '/module-worker.js': return js(res, `import './module-dep.js';\ntry { new WebSocket('ws://' + location.host + '/module-ws'); } catch (e) {}`);
      case '/module-dep.js': return js(res, `try { new WebSocket('ws://' + location.host + '/module-dep-ws'); } catch (e) {}`);
      case '/shared.js': return js(res, `try { new WebSocket('ws://' + location.host + '/shared-ws'); } catch (e) {}\nfetch('/api/shared-write', { method: 'POST', body: 'x' }).catch(() => {});`);
      default: {
        // An endless calendar: every month links to the next one.
        const m = /^\/cal\/(\d{4})-(\d{2})$/.exec(path);
        if (m) { const y = Number(m[1]), mo = Number(m[2]), next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; return html(page(`Calendar ${m[1]}-${m[2]}`, `<p><a href="/cal/${next}">Next month</a></p>`)); }
        return html('<!doctype html><title>Not found</title><h1>Not found</h1>', 404);
      }
    }
  });
  server.on('upgrade', (req, socket) => { sockets.push(req.url ?? ''); socket.destroy(); });
  const base = await listen(server);
  return { base, otherBase, seen, sockets, otherSeen, close: async () => { await close(server); await close(other); } };
}

if (import.meta.url === `file://${process.argv[1]}`) { const s = await startHostileSite(); console.log(s.base, s.otherBase); }
