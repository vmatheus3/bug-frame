import { readFile } from 'node:fs/promises';
import { resolveLocale, translator } from './inbox/i18n.js';

const headers = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const path = value => value === '' || /^\/[A-Za-z0-9_/-]+$/.test(value) && !value.startsWith('//') && !value.split('/').includes('..');

/** Optional admin inbox; all pages/assets reuse Bugframe's existing authorization hook. No new login system. */
export function createInbox({ bugframe, basePath = '/bugs', apiBase = bugframe?.basePath, siteName = 'Bugframe', loginUrl, siteUrl = '/?bugs=1', locale = 'auto', labels = {} } = {}) {
  basePath = basePath.replace(/\/+$/, '');
  apiBase = apiBase?.replace(/\/+$/, '');
  if (!bugframe?.handle || !basePath || !path(basePath) || typeof apiBase !== 'string' || !path(apiBase)) throw new Error('createInbox requires a Bugframe instance and same-origin base paths.');
  for (const location of [loginUrl, siteUrl].filter(Boolean)) {
    const url = new URL(location, 'https://inbox.invalid');
    if (!location.startsWith('/') || url.origin !== 'https://inbox.invalid') throw new Error('Inbox loginUrl and siteUrl must be same-origin paths.');
  }
  if (typeof siteName !== 'string' || siteName.length > 120 || Object.values(labels).some(v => typeof v !== 'string' || v.length > 300)) throw new Error('Inbox names and labels must be short strings.');
  if (!['auto', 'en', 'es', 'pt'].includes(locale)) throw new Error('Inbox locale must be auto, en, es or pt.');
  const routes = { [basePath]: 'index.html', [`${basePath}/`]: 'index.html', [`${basePath}/inbox.js`]: 'inbox.js', [`${basePath}/inbox.css`]: 'inbox.css' };
  routes[`${basePath}/review`] = 'index.html';
  if (bugframe.invitationsEnabled) { routes[`${basePath}/invite`] = 'invite.html'; routes[`${basePath}/invite.js`] = 'invite.js'; }
  routes[`${basePath}/export.js`] = 'export.js';
  routes[`${basePath}/i18n.js`] = 'i18n.js'; routes[`${basePath}/ui.js`] = 'ui.js';
  const assets = new Map();
  const matches = input => Object.hasOwn(routes, new URL(input, 'http://localhost').pathname);
  async function handle(req, ctx = {}) {
    const url = new URL(req.url), file = routes[url.pathname];
    const language = resolveLocale(url.searchParams.get('lang') ?? locale, req.headers.get('accept-language') ?? '');
    const t = translator(language, labels);
    const response = (body, status = 200, type = 'text/html; charset=utf-8') => new Response(req.method === 'HEAD' ? null : body, { status, headers: { ...headers, 'content-type': type } });
    if (!file) return response(t('notFound'), 404, 'text/plain');
    if (!['GET', 'HEAD'].includes(req.method)) return response(t('methodNotAllowed'), 405, 'text/plain');
    const publicAsset = ['invite.html', 'invite.js', 'inbox.css', 'i18n.js', 'ui.js'].includes(file);
    const customer = url.pathname === `${basePath}/review`;
    const access = publicAsset ? null : await bugframe.handle(new Request(new URL(`${bugframe.basePath}/access`, url), { headers: req.headers }), ctx);
    const role = access?.ok ? (await access.json()).role : null;
    if (!publicAsset && (!access.ok || (!customer && file === 'index.html' && role !== 'admin'))) {
      return response(`<!doctype html><html lang="${language}"><meta charset="utf-8"><title>${escape(t('privateInbox'))}</title><h1>${escape(t('privateInbox'))}</h1><p>${escape(t(customer ? 'customerRequired' : 'adminRequired'))}</p>${loginUrl ? `<p><a href="${escape(loginUrl)}">${escape(t('signIn'))}</a></p>` : ''}</html>`, access.ok ? 403 : access.status);
    }
    if (!assets.has(file)) assets.set(file, readFile(new URL(`./inbox/${file}`, import.meta.url), 'utf8'));
    let body = await assets.get(file);
    if (file.endsWith('.html')) body = body.replace(/\{\{(BASE|NAME|CONFIG|LANG|EYEBROW|INTRO|T:\w+)\}\}/g, (_match, key) => {
      const values = { BASE: basePath, NAME: siteName, LANG: language, EYEBROW: customer ? 'myRequests' : 'eyebrow', INTRO: customer ? 'customerIntro' : 'intro', CONFIG: JSON.stringify({ apiBase, labels, customer, basePath, siteUrl, loginUrl, siteName, locale: language, localePreference: locale, invitations: Boolean(bugframe.invitationsEnabled) }) };
      const translated = key === 'T:eyebrow' && customer ? 'myRequests' : key === 'T:intro' && customer ? 'customerIntro' : key.slice(2);
      return escape(key.startsWith('T:') ? t(translated, { name: siteName }) : values[key]);
    });
    if (file.endsWith('.html')) body = body.replace(`<option value="${language}">`, `<option value="${language}" selected>`);
    return response(body, 200, file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : undefined);
  }
  return { handle, matches, basePath };
}
