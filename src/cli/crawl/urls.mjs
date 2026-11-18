// URLs for the site crawl: one normal form per page, one route template per kind of page, and the crawl frontier
// (breadth-first queue with every cap). Pure functions: no browser, no network.
import { HASH_ROUTE, isDestructive } from '../audit/probe.mjs';

/** Query parameters that only track where a visitor came from; dropped before comparing URLs. */
export const TRACKING_PARAM = /^(utm_.+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid|igshid|ref_src|_hsenc|_hsmi)$/i;
/** A fragment that is a client-side route (`#/clients`, `#!/clients`) rather than an in-page anchor. */
export const isHashRoute = hash => HASH_ROUTE.test(hash ?? '');

/**
 * The normal form of a same-site URL: http(s) only, no credentials, fragment kept only when it is a hash route,
 * tracking parameters removed, the rest sorted, duplicate and trailing slashes removed. Null when it is not a page URL.
 */
export function normalizeUrl(href, base) {
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.username = ''; u.password = '';
  if (!isHashRoute(u.hash)) u.hash = '';
  const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  u.search = new URLSearchParams(params).toString();
  u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return u.href;
}

/** One path segment that is a record id: a number, a UUID, a long hex string, a long token mixing letters and digits,
 *  or numbers joined by separators (a version `1.2.3`, a range `10-20`). */
export function isIdSegment(seg) {
  const s = decodeURIComponentSafe(seg);
  return /^\d+([-._:]\d+)*$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || (/^[0-9a-f]{8,}$/i.test(s) && /\d/.test(s))
    || (s.length >= 16 && /\d/.test(s) && /[a-z]/i.test(s) && !/[-.~]/.test(s));
}
/** One path segment that is a date: `2026-01`, `2026-01-15`, `15-01-2026`, a week `2026-W03` or a quarter `2026-Q1`.
 *  Calendars link to the next month forever; as one route they are opened twice, not for ever. */
export function isDateSegment(seg) {
  const s = decodeURIComponentSafe(seg);
  return /^(\d{4}[-._]\d{1,2}([-._]\d{1,2})?|\d{1,2}[-._]\d{1,2}[-._]\d{4}|\d{4}-?[wq]\d{1,2})$/i.test(s);
}
function decodeURIComponentSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }
const templatePath = path => path.split('/').map(seg => (!seg ? seg : isDateSegment(seg) ? ':date' : isIdSegment(seg) ? ':id' : seg)).join('/');

/**
 * The route template of a normalised URL: id-like path segments become `:id`, query values are dropped (keys kept,
 * sorted), and a hash route is templated the same way. `/clients/123?tab=2` and `/clients/456?tab=9` are both
 * `/clients/:id?tab`, so a list of 10,000 records is one route, not 10,000.
 */
export function routeTemplate(href) {
  let u; try { u = new URL(href); } catch { return String(href); }
  const keys = [...new Set([...u.searchParams.keys()])].sort();
  let route = templatePath(u.pathname) + (keys.length ? `?${keys.join('&')}` : '');
  if (isHashRoute(u.hash)) { const [p, q] = u.hash.split('?'); route += templatePath(p) + (q ? `?${[...new Set([...new URLSearchParams(q).keys()])].sort().join('&')}` : ''); }
  return route;
}

/** The path a person reads for a URL on this site: path, query and hash route. */
export const shortUrl = href => { try { const u = new URL(href); return u.pathname + u.search + u.hash; } catch { return String(href); } };

/** `--include` / `--exclude` globs against the path (and hash route): `*` stays inside one segment, `**` spans any. */
export function globToRegExp(glob) {
  const body = String(glob).split(/(\*\*|\*|\?)/).map(p => (p === '**' ? '.*' : p === '*' ? '[^/]*' : p === '?' ? '[^/]' : p.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${body}$`);
}
const matchesAny = (res, path) => res.some(re => re.test(path));

/**
 * The breadth-first frontier with every cap. `add` answers why a URL was or was not queued: queued, seen, offsite,
 * destructive, excluded, depth, template (already `perTemplate` pages of that route) or pages (the --max-pages cap).
 */
export function createFrontier({ origin, maxPages = 200, maxDepth = 6, include = [], exclude = [], perTemplate = 2 }) {
  const inc = include.map(globToRegExp), exc = exclude.map(globToRegExp);
  const seen = new Map(), perRoute = new Map(), perShape = new Map(), banned = new Set(), queue = [];
  // Pages that differ only in a number inside a word (`/blog/page-2`, `/blog/page-3`) share a shape: a few are enough.
  const shapeOf = route => route.replace(/\d+/g, ':n'), perShapeCap = perTemplate * 3;
  const skipped = { offsite: 0, destructive: new Set(), excluded: new Set(), depth: new Set(), pages: new Set(), template: new Map() };
  let accepted = 0;
  return {
    queue, skipped,
    get accepted() { return accepted; },
    /** The verdict for one URL, without queueing it. */
    check(href, depth) {
      const url = normalizeUrl(href, origin); if (!url) return { status: 'invalid' };
      const u = new URL(url), route = routeTemplate(url), path = u.pathname + u.hash;
      if (u.origin !== origin) return { status: 'offsite', url, route };
      if (banned.has(url)) return { status: 'destructive', url, route };
      if (seen.has(url)) return { status: 'seen', url, route };
      if (isDestructive(u.pathname + u.search + u.hash)) return { status: 'destructive', url, route };
      if (accepted > 0 && ((inc.length && !matchesAny(inc, path)) || matchesAny(exc, path))) return { status: 'excluded', url, route };
      if (depth > maxDepth) return { status: 'depth', url, route };
      if ((perRoute.get(route) ?? 0) >= perTemplate) return { status: 'template', url, route };
      if (shapeOf(route) !== route && (perShape.get(shapeOf(route)) ?? 0) >= perShapeCap) return { status: 'template', url, route: shapeOf(route) };
      if (accepted >= maxPages) return { status: 'pages', url, route };
      return { status: 'queued', url, route };
    },
    add(href, { depth = 0, via = 'link', from = null } = {}) {
      const v = this.check(href, depth);
      if (v.status === 'queued') { seen.set(v.url, true); perRoute.set(v.route, (perRoute.get(v.route) ?? 0) + 1); perShape.set(shapeOf(v.route), (perShape.get(shapeOf(v.route)) ?? 0) + 1); accepted++; queue.push({ url: v.url, route: v.route, depth, via, from }); }
      else if (v.status === 'offsite') skipped.offsite++;
      else if (v.status === 'template') skipped.template.set(v.route, (skipped.template.get(v.route) ?? new Set()).add(v.url));
      else if (skipped[v.status] instanceof Set) skipped[v.status].add(shortUrl(v.url));
      return v;
    },
    /** Never open this URL: its link is labelled as destructive ("Sign out" pointing at /bye). Also drops it from the queue. */
    ban(href) {
      const url = normalizeUrl(href, origin); if (!url || banned.has(url)) return;
      banned.add(url); skipped.destructive.add(shortUrl(url));
      const i = queue.findIndex(q => q.url === url); if (i >= 0) { const [q] = queue.splice(i, 1); accepted--; perRoute.set(q.route, perRoute.get(q.route) - 1); perShape.set(shapeOf(q.route), perShape.get(shapeOf(q.route)) - 1); }
    },
    next() { return queue.shift() ?? null; },
  };
}
