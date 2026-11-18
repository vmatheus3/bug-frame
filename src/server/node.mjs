// Adapters: Node http / Express / Connect / Fastify-raw, and Next.js (or any Request/Response framework) route handlers.
import { Readable } from 'node:stream';

/**
 * Node `(req, res, next?)` listener. Mount it with http.createServer(listener) or app.use('/api/bugframe', listener).
 * When mounted behind a prefix, set `basePath` in createBugframe to the same prefix.
 */
export function toNodeListener(bf, { trustProxy = false } = {}) {
  return async function bugframeListener(req, res, next) {
    const original = req.originalUrl ?? req.url ?? '/';
    const forwardedProto = trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() : '';
    const proto = ['http', 'https'].includes(forwardedProto) ? forwardedProto : req.socket?.encrypted ? 'https' : 'http';
    const host = req.headers.host ?? 'localhost';
    const url = new URL(original, `${proto}://${host}`);
    if (typeof next === 'function' && !bf.matches(url)) return next();
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined && req.readableEnded) body = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? req.body : JSON.stringify(req.body); // a body parser already consumed it
      else body = Readable.toWeb(req);
    }
    const request = new Request(url, { method: req.method, headers, body, duplex: 'half' });
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket?.remoteAddress;
    const response = await bf.handle(request, { ip });
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

/** Express / Connect middleware: `app.use('/api/bugframe', expressMiddleware(bf))`. Same as toNodeListener. */
export const expressMiddleware = toNodeListener;

/** Route handlers for Next.js App Router (`app/api/bugframe/[...path]/route.ts`), SvelteKit, Remix, Hono, Astro... */
export function routeHandlers(bf, { trustProxy = false } = {}) {
  const run = req => bf.handle(req, {});
  void trustProxy;
  return { GET: run, POST: run, PUT: run, PATCH: run, OPTIONS: run };
}
