// "Northstar Studio": a fictional client dashboard for trying `bugframe crawl`. It has problems planted on purpose:
// a dead "Export report" button, a "Share" button that does nothing, a contact form that never sends, a journal post
// that 404s, and an About page whose menu is out of step (its "Contact" goes to a page that does not exist).
// Writes ("Save notes", "Save") are real POSTs that the crawl blocks and records; "Delete draft" is never clicked.
const NAV = [['Overview', '/studio'], ['Projects', '/studio/projects'], ['Clients', '/studio/clients'], ['Journal', '/studio/journal'], ['Contact', '/studio/contact']];
const ABOUT_NAV = [['Overview', '/studio'], ['Projects', '/studio/projects'], ['Clients', '/studio/clients'], ['Contact', '/studio/contact-us']];
const PROJECTS = [['Harbor Bakery', 'Website refresh'], ['Fern & Field', 'Online shop'], ['Lumen Dental', 'Booking flow'], ['Oak Row Books', 'Events calendar'], ['Tidewater Yoga', 'Class schedule'], ['Copperleaf Cafe', 'Menu pages'],
  ['Atlas Movers', 'Quote form'], ['Bramble Florist', 'Gift guide'], ['Quarry Climbing', 'Membership pages'], ['Saltmarsh Inn', 'Room booking'], ['Kestrel Bikes', 'Repair tracker'], ['Pine & Pixel', 'Brand site']];

const CSS = `*{box-sizing:border-box}body{margin:0;background:#f8f6f1;color:#202421;font:15px/1.6 system-ui,sans-serif}a{color:inherit}header,main,footer{max-width:1080px;margin:auto;padding:20px 32px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #dddcd4;gap:20px;flex-wrap:wrap}
.brand{font-weight:750;letter-spacing:-.03em;font-size:18px;text-decoration:none}.brand b{color:#c2410c;margin-right:6px}nav{display:flex;gap:22px;font-size:14px;flex-wrap:wrap}nav a{text-decoration:none;color:#46604d}nav a:hover{color:#c2410c}
h1{font-size:34px;letter-spacing:-.04em;line-height:1.15;margin:18px 0 6px;font-weight:640}.lead{color:#62665d;margin:0 0 20px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{background:#fff;border:1px solid #dddcd4;border-radius:14px;padding:18px}
.card h2{font-size:16px;margin:0 0 4px}.card p{margin:0;color:#62665d;font-size:14px}.stat{font-size:28px;font-weight:650;letter-spacing:-.03em}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}
button{font:inherit;font-size:14px;border:0;border-radius:8px;background:#263b32;color:#fff;padding:10px 16px;cursor:pointer}button.ghost{background:#e9ede4;color:#263b32}button.danger{background:#fbe9e3;color:#9a2f0b}
ul.list{list-style:none;padding:0;margin:0;display:grid;gap:8px}ul.list a{display:flex;justify-content:space-between;background:#fff;border:1px solid #dddcd4;border-radius:10px;padding:12px 16px;text-decoration:none}ul.list small{color:#8b6d56}
form{display:grid;gap:12px;max-width:520px}label{display:grid;gap:6px;font-size:14px}input,textarea{font:inherit;padding:10px;border:1px solid #cfcdc4;border-radius:8px;background:#fff}dialog{border:1px solid #dddcd4;border-radius:14px;padding:22px}
footer{border-top:1px solid #dddcd4;font-size:13px;color:#686c62;margin-top:36px;display:flex;gap:18px}@media(max-width:720px){header,main,footer{padding:16px 20px}.grid{grid-template-columns:1fr}h1{font-size:28px}}`;

function page({ title, h1, lead = '', body, nav = NAV, script = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Northstar Studio</title><style>${CSS}</style></head><body>
<header><a class="brand" href="/studio"><b>✳</b>northstar studio</a><nav aria-label="Studio">${nav.map(([l, h]) => `<a href="${h}">${l}</a>`).join('')}</nav></header>
<main><h1>${h1}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}${body}</main>
<footer><a href="/studio/about">About the studio</a><span>Northstar Studio is a fictional client dashboard for the Bugframe demo.</span></footer>
<script>console.error('Analytics key missing: NS_ANALYTICS_KEY');${script}</script></body></html>`;
}

const PAGES = {
  '/studio': () => page({ title: 'Overview', h1: 'Good morning, Northstar', lead: 'Twelve projects in flight, three waiting on client feedback.', body: `
<div class="grid"><div class="card"><p>Active projects</p><div class="stat">12</div></div><div class="card"><p>Waiting on feedback</p><div class="stat">3</div></div><div class="card"><p>Invoices due</p><div class="stat">$4,800</div></div></div>
<div class="actions"><button id="new-project" type="button">New project</button><button id="export-report" type="button" class="ghost">Export report</button><button id="delete-draft" type="button" class="danger">Delete draft</button></div>
<dialog id="new-dialog" aria-label="New project"><p>Name the project and pick a client.</p><button type="button" class="ghost" onclick="this.closest('dialog').close()">Close</button></dialog>`,
  script: `document.getElementById('new-project').addEventListener('click', () => document.getElementById('new-dialog').show());
document.getElementById('delete-draft').addEventListener('click', () => fetch('/studio/api/drafts/7', { method: 'DELETE' }));` }),
  '/studio/projects': () => page({ title: 'Projects', h1: 'Projects', lead: 'Every website we are building or caring for.', body: `<ul class="list">${PROJECTS.map(([name, what], i) => `<li><a href="/studio/projects/${101 + i}"><span>${name}</span><small>${what}</small></a></li>`).join('')}</ul>` }),
  '/studio/clients': () => page({ title: 'Clients', h1: 'Clients', lead: 'Who we work with and how to reach them.', body: `
<div class="grid">${PROJECTS.slice(0, 6).map(([name]) => `<div class="card"><h2>${name}</h2><p>Primary contact on file</p></div>`).join('')}</div>
<div class="actions"><button id="save-clients" type="button">Save</button></div>`, script: `document.getElementById('save-clients').addEventListener('click', () => fetch('/studio/api/clients', { method: 'POST', body: '{}' }).catch(() => {}));` }),
  '/studio/journal': () => page({ title: 'Journal', h1: 'Journal', lead: 'Notes from the studio.', body: `<ul class="list"><li><a href="/studio/journal/autumn-update"><span>Autumn update: what we shipped</span><small>Oct 2026</small></a></li><li><a href="/studio/journal/accessible-forms"><span>Five fixes for friendlier forms</span><small>Sep 2026</small></a></li></ul>` }),
  '/studio/journal/accessible-forms': () => page({ title: 'Five fixes for friendlier forms', h1: 'Five fixes for friendlier forms', lead: 'Labels, errors, and a submit button that tells you what happened.', body: '<p>Forms are where websites earn trust.</p>' }),
  '/studio/contact': () => page({ title: 'Contact', h1: 'Start a conversation', lead: 'Tell us about your project.', body: `<form id="contact-form"><label>Your name <input name="name" autocomplete="name"></label><label>Email <input name="email" type="email" autocomplete="email"></label><label>About the project <textarea name="message" rows="4"></textarea></label><button type="submit" id="send">Send message</button></form>` }),
  '/studio/about': () => page({ title: 'About', h1: 'About the studio', nav: ABOUT_NAV, lead: 'A small team of designers and developers.', body: '<p>We have built websites with local businesses since 2014.</p>' }),
};
const PROJECT = (id, [name, what]) => page({ title: name, h1: name, lead: what, body: `
<div class="grid"><div class="card"><p>Status</p><div class="stat">In review</div></div><div class="card"><p>Next milestone</p><div class="stat">Nov 28</div></div><div class="card"><p>Open feedback</p><div class="stat">2</div></div></div>
<div class="actions"><button id="save-notes" type="button">Save notes</button><button id="share" type="button" class="ghost">Share</button><a href="/studio/projects">All projects</a></div>`,
  script: `document.getElementById('save-notes').addEventListener('click', () => fetch('/studio/api/projects/${id}/notes', { method: 'POST', body: '{}' }).catch(() => {}));` });

/** The demo page for `path`, or null. */
export function studioPage(path) {
  if (PAGES[path]) return PAGES[path]();
  const m = /^\/studio\/projects\/(\d+)$/.exec(path), i = m ? Number(m[1]) - 101 : -1;
  return i >= 0 && i < PROJECTS.length ? PROJECT(m[1], PROJECTS[i]) : null;
}
