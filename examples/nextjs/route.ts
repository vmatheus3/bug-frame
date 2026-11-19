// app/api/bugframe/[...path]/route.ts  (Next.js App Router; the same shape works in SvelteKit, Remix, Hono, Astro, Cloudflare Workers with a custom storage adapter)
import { createBugframe, routeHandlers } from 'bugframe/server';
// Put the session verifier from examples/authentication/README.md in your app's lib/bugframe-auth.ts.
import { authorize } from '@/lib/bugframe-auth';

const bf = createBugframe({
  dir: process.env.BUGFRAME_DIR ?? './bug-reports',      // on serverless hosts use a storage adapter instead (see examples/storage-adapters)
  basePath: '/api/bugframe',
  authorize,
  adminToken: process.env.BUGFRAME_ADMIN_TOKEN,
  trustProxy: true,                                       // you are behind your host's proxy; rate limits use X-Forwarded-For
});

export const { GET, POST, PUT, PATCH, OPTIONS } = routeHandlers(bf); // PUT: page-analysis results from `bugframe audit --watch --remote`
export const runtime = 'nodejs';
