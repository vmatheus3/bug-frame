# Bugframe

[![CI](https://github.com/vmatheus3/bug-frame/actions/workflows/ci.yml/badge.svg)](https://github.com/vmatheus3/bug-frame/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-c2410c.svg)](LICENSE)
[![Download](https://img.shields.io/badge/download-v0.2.0-c2410c.svg)](https://github.com/vmatheus3/bug-frame/releases/tag/v0.2.0)

![Bugframe: frame the bug and send the context](docs/images/bugframe-overview.png)

**Drag a box around what is wrong, say what you expected, press send.** Bugframe is a small drop-in "report a problem"
button for any website or web app. Every report arrives with a screenshot of the exact area, the page link, the screen
size, the element under the box and the recent console errors, ready for a person or an AI coding agent to fix.

**Free and open source, under the MIT license.** Use it in personal or commercial projects, modify it, and share it.
Run it on your own infrastructure or download reports as ZIP files. No Bugframe account or subscription is required;
you cover any hosting you choose and any optional AI service you use to fix reports. Console capture is opt-in.

```
 tester / owner                 your site                  your server               you or your AI agent
 ──────────────                 ─────────                  ───────────               ────────────────────
  ?bugs=1  ───────────────▶  [ bug button ]
  drag a box, type  ─────▶   region.png + full.png  ───▶  bug-reports/<id>/   ───▶   bugframe export
                              + url, viewport,             report.json                 → WORKLIST.md (by page)
                                element path, console      region.png                  → agent fixes, proves, closes
  "My reports" ◀──────────── status + fix note  ◀─────────  full.png                   bugframe close <id> --note …
```

## How it works

1. Open your page with `?bugs=1`, click the bug button, and choose **Report a problem on this page**.
2. Drag a box around the problem, describe what you expected, and send the report.
3. Review the screenshot and page context, fix the problem, and close the report with a note.

| Frame the problem | Describe it and send |
| --- | --- |
| ![Select the wrong invoice total](docs/images/frame-the-problem.png) | ![Describe the problem and send the report](docs/images/describe-and-send.png) |

These images are illustrative mockups of the workflow on a fictional website, generated with the built-in imagegen tool.
The runnable demo below uses the actual widget. Image files and the final generation prompts are in [docs/MOCKUPS.md](docs/MOCKUPS.md).

## Why

- **Non-technical people can't describe UI problems in words.** A screenshot with a box around the thing, taken in their own
  browser at their own screen size, removes the back-and-forth ("which page? what phone? what did you click?").
- **AI agents fix many small bugs very well, in one batch.** Give them the grouped work list, the pictures and a good prompt
  (`prompts/FIX_BUGS.md`) and they find the root causes, fix them together, prove each fix with a before/after picture and
  write a plain-language answer back to the reporter.
- **Approved users only.** Reporting requires a server-verified login and reporting permission. `?bugs=1` only controls visibility; ordinary visitors cannot authorize themselves.

## 5-minute quick start

Try the complete widget and server locally with Node.js 18.17+:

```bash
git clone https://github.com/vmatheus3/bug-frame.git
cd bug-frame
npm ci
npm run build
npm run example
```

Open <http://127.0.0.1:4455/?bugs=1> and follow **Sign in as an approved tester**. The terminal prints a random demo password.
Once signed in, report the deliberately wrong invoice total, then try **My reports**. Signing out revokes the session.
Reports are stored in `examples/plain-html/reports/`. This localhost demo uses an HttpOnly session cookie; integrate your own website login in production.
In another terminal in the repository:

```bash
node src/cli/bin.mjs --dir ./examples/plain-html/reports list
node src/cli/bin.mjs --dir ./examples/plain-html/reports export
node src/cli/bin.mjs --dir ./examples/plain-html/reports close <id> --note "Fixed the overlapping footer"
```

### Add it to your own project

Install the built package from the [GitHub release](https://github.com/vmatheus3/bug-frame/releases/tag/v0.2.0).
This installation does not depend on a package named `bugframe` being published to the npm registry:

```bash
npm install https://github.com/vmatheus3/bug-frame/releases/download/v0.2.0/bugframe-0.2.0.tgz
# First connect your server-side login verifier as described under "Access control" below.
npx bugframe serve --dir ./bug-reports --port 4455 --auth-module ./bugframe-auth.mjs
```

For a script tag, download `bugframe.min.js` from the same release and serve it from your site's `/vendor/` directory.
Add the widget to any page (script tag, no build step):

```html
<script src="/vendor/bugframe.min.js"
        data-endpoint="/api/bugframe"></script>
```

> The standalone `serve` command answers at its root; if your page is on another origin add `--origin http://localhost:3000`
> so the browser is allowed to call it.

Only load the widget for signed-in users with reporting permission, and verify that permission on the API.
For an approved user, open the page with `?bugs=1`. A bug button appears (and stays, until `?bugs=0`). Click it, choose "Report a problem on this
page", drag a box, describe it, send. Then:

```bash
npx bugframe --dir ./bug-reports list
npx bugframe --dir ./bug-reports export         # writes bug-reports/WORKLIST.md grouped by page
npx bugframe --dir ./bug-reports close <id> --note "Fixed the overlapping footer"
```

No server at all? Use download mode: add `data-download` instead of `data-endpoint`. Each report is saved as a `.zip` the tester
sends you; `npx bugframe import report.zip` unpacks it. See [examples/static-download](examples/static-download).

The release includes the standalone browser bundle, an installable package with types, and a checksum file.

## Install for any stack

| Stack | How |
| --- | --- |
| Any HTML page, WordPress, Webflow, Shopify, static sites | Load the script for approved users and connect a session-authorized endpoint (or use local ZIP download mode). |
| React / Preact / Next.js | `useEffect(() => { const b = init({...}); return () => b.destroy(); }, [])` - [examples/react](examples/react), [examples/nextjs](examples/nextjs) |
| Vue / Nuxt / Svelte / SvelteKit / Angular | call `init()` on mount - [examples/vue-svelte](examples/vue-svelte) |
| Server: Node http, Express, Fastify, Connect | `toNodeListener(bf)` / `expressMiddleware(bf)` - [examples/express](examples/express) |
| Server: Next.js, SvelteKit, Remix, Hono, Workers, Deno, Bun | `routeHandlers(bf)` or `bf.handle(request)` (plain `Request` to `Response`) |
| Server: not Node (PHP, Python, Go...) | Run `bugframe serve` beside it, or implement the 4 HTTP routes below; the JSON shape is documented here |

```js
import { init } from 'bugframe';

const bugframe = init({
  endpoint: '/api/bugframe',
  metadata: () => ({ appVersion: APP_VERSION, userId: user?.id, mode: currentMode }),
  captureConsole: true,
});
```

## Access control (required for server mode)

**Visitors and ordinary customer accounts cannot submit reports.** The API is closed by default. Configure `authorize`
to verify the website's login session and check an explicit reporting permission or admin role. The server calls it on
**every** report request, including lists and screenshots. Missing, expired, revoked, denied, or unverifiable sessions get HTTP 401.

```js
// bugframe-auth.mjs — runs only on the server
import { verifySession } from './your-app/auth.mjs'; // your existing login/session service

export async function authorize(request) {
  const session = await verifySession(request); // verifies signature/session storage, expiry and revocation
  const user = session?.user;
  if (!user || user.disabled) return null;
  if (user.role === 'admin') return { id: String(user.id), role: 'admin' };
  if (user.canReportBugs === true) return { id: String(user.id), role: 'client' };
  return null; // being signed in alone is insufficient
}
```

Pass this function to `createBugframe({ dir, authorize })`, or load it with `bugframe serve --auth-module ./bugframe-auth.mjs`.
`verifySession` belongs to your application; Bugframe does not invent or auto-approve user accounts. Keep the endpoint on
the same origin to use existing HttpOnly session cookies. Never trust a browser-provided role, user id, or unsigned cookie.

`?bugs=1` is only a display preference. Copying the widget token or changing localStorage/reporter ids does not bypass the
API. Ownership and account rate limits come from the verified identity. Admin bearer credentials are only for server-side
operations. No `authorize` configuration means browser reporting remains denied.

See [authentication examples and the 0.1.x migration guide](examples/authentication/README.md). Upgrade the server and widget
together; existing reports with browser-generated ownership ids remain accessible to admins and the local CLI.

## Configuration reference (widget)

All options are optional except where noted. `init(options)` returns `{ open, close, enable, disable, isEnabled, destroy }`.
For the script tag, options map to `data-*` attributes (`data-endpoint`, `data-token`, `data-position`, `data-enable`,
`data-enable-param`, `data-locale`, `data-accent`, `data-capture-console="true"`, `data-types="A,B"`, `data-mask`, `data-exclude`, `data-avoid`, `data-download`).

| Option | Default | What it does |
| --- | --- | --- |
| `endpoint` | none | Base URL of the report API. Without it the widget runs in download mode. |
| `token` | none | Legacy public widget identifier (`x-bugframe-token`); grants no access. Use verified login sessions on the server. |
| `mode` | auto | `'server'` or `'download'`. |
| `enable` | `'query'` | `'query'` (`?bugs=1` on, `?bugs=0` off, remembered in localStorage), `'storage'` (only the stored flag), `'always'`, `'never'`, a boolean or a function `() => boolean` (for example "only for staff"). |
| `enableParam`, `storageKey` | `'bugs'`, `'bugframe:enabled'` | Names for the query parameter and storage key. |
| `position` | `'bottom-right'` | `'bottom-right' 'bottom-left' 'top-right' 'top-left'`. Includes safe-area insets for phones. |
| `offset` | `{x:0,y:0}` | Extra pixels from the corner. |
| `avoid` | `[]` | CSS selectors of other floating buttons (chat bubbles, cookie buttons). The button slides along the edge to stay clear of them. |
| `zIndex` | `2147483000` | Stacking of the widget layers. |
| `types` | five defaults | Chip labels. `[]` hides the chips. |
| `strings`, `locale` | `'auto'` | Replace any text; built-in `en`, `es`, `pt`. |
| `captureConsole` | `false` | Record console errors and uncaught exceptions of the last minute (opt-in). |
| `metadata` | none | `() => object` (sync or async) merged into every report: app version, user id, current mode, feature flags. Max 8 KB. |
| `reporterId` | random id in localStorage | Legacy browser identifier. The server ignores it for ownership and uses the verified account id. |
| `maskInputs` | `true` | Paint over every `input`, `textarea`, `select`, contenteditable in the pictures. |
| `mask` | `[]` | More selectors to paint over. `[data-bug-mask]` and password fields are always masked. |
| `exclude` | `[]` | Selectors left out of the picture entirely. |
| `redactParams` | token, key, password, secret, auth, code, session... | Query parameters whose values are replaced in the recorded URL. |
| `maxPixelRatio` | `2` | Caps picture resolution so phone reports stay small. |
| `accent`, `colorScheme` | orange, `'auto'` | Button colour; `'light' 'dark' 'auto'`. |
| `container` | `document.body` | Where the host element is appended. |
| `captureFn` | built-in | Bring your own screenshot function (returns a PNG data URL of the viewport). |
| `fetch`, `onSent`, `onError` | | Custom fetch, callbacks. |

### What a report contains

`report.json` (plus `region.png` and `full.png`):

```json
{
  "id": "bug-20261017-153012-9f3a", "status": "open", "note": "", "createdAt": "2026-10-17T15:30:12.000Z", "reporter": "user:<sha256 of verified account id>",
  "description": "The total is wrong, it should be $1,420.00", "types": ["Wrong data"],
  "context": {
    "url": "https://app.example.com/invoices/4021?tab=summary", "title": "Invoice 4021",
    "viewport": { "w": 390, "h": 844, "dpr": 3 }, "scroll": { "x": 0, "y": 120 }, "region": { "x": 20, "y": 180, "w": 300, "h": 90 },
    "userAgent": "...", "language": "en-US", "capturedAt": "...",
    "elements": [{ "path": "section > div > span#total", "component": "component:invoice-summary", "text": "$1,240.00" }],
    "consoleErrors": [{ "at": "...", "message": "TypeError: ..." }],
    "metadata": { "appVersion": "1.4.2", "userId": "u_42" }
  }
}
```

Tip: put a `data-component="invoice-summary"` (or `data-testid`) on your main components. The tool records the nearest one under
the box, which tells an agent which code to open.

## Server reference

```js
import { createBugframe, toNodeListener } from 'bugframe/server';
import { createServer } from 'node:http';
import { authorize } from './bugframe-auth.mjs';

const bf = createBugframe({
  dir: './bug-reports',                    // or storage: myAdapter
  basePath: '/api/bugframe',
  authorize, // your server-side session verifier; see Access control above
  adminToken: process.env.BUGFRAME_ADMIN_TOKEN,
  allowedOrigins: ['https://www.example.com'],
});
createServer(toNodeListener(bf)).listen(4455);
```

| Option | Default | |
| --- | --- | --- |
| `dir` / `storage` | required (one of) | Built-in folder storage, or your own adapter. |
| `basePath` | `''` | URL prefix the API is mounted under (must match your mount). |
| `clientTokens` | deprecated | Ignored for authorization. Public widget tokens never grant access. |
| `adminToken` | none | `Authorization: Bearer ...`: list everyone's reports, read full reports, close. |
| `authorize` | deny | Verify login and reporting permission; return `{ id, role: 'client' }` or `{ id, role: 'admin' }`, otherwise `null`. |
| `allowedOrigins` | none | Cross-site browser origins allowed. Origin approval does not bypass login authorization; prefer a same-origin session API. |
| `maxBodyBytes`, `maxImageBytes`, `maxDescription` | 24 MB, 10 MB, 4000 | Hard limits (413 / 400). |
| `rateLimit` | 10 / minute | Separate limits for verified account and IP. In-memory per instance; `false` disables. 429 with `Retry-After`. |
| `trustProxy` | `false` | Read the IP from `X-Forwarded-For` (only behind a proxy you control). |
| `publicList` | `true` | `false`: clients see no "My reports". |
| `webhook` | none | `{ url, secret, includeImages }`: POST `report.created` with `x-bugframe-signature: sha256=<hmac>`. Failures never fail a report. |
| `onReport`, `logger` | none | Hooks. |

HTTP routes (relative to `basePath`):

| Route | Who | |
| --- | --- | --- |
| `POST /reports` | client | JSON `{ description, types, context, region, full }` with PNG data URLs. `201 { id, status }`. |
| `GET /reports` | approved account | Only reports belonging to the verified account. Admin: `?all=1`. |
| `GET /reports/:id/region.png`, `/full.png` | client (own) / admin | The pictures. |
| `GET /reports/:id` | admin | Full report. |
| `PATCH /reports/:id` | admin | `{ status: 'open'\|'fixed'\|'wontfix', note }`. |
| `GET /health` | anyone | `{ ok: true }`. |

Storage adapters: implement `create / get / list / update / readFile` ([examples/storage-adapters](examples/storage-adapters)).

## CLI

```
bugframe [--dir ./bug-reports] [--remote URL [--token T]] <command>
  list [--open] [--json]            show [id] [--json]
  export [--all] [--out FILE]       close <id> --note "..." [--status fixed|wontfix]
  reopen <id>                       import <report.zip>
  serve [--port 4455] [--origin URL]... [--auth-module FILE] [--admin-token T] [--webhook URL]
```

`--dir` can also come from `BUGFRAME_DIR`. `serve` reads `BUGFRAME_ADMIN_TOKEN` and `BUGFRAME_AUTH_MODULE`.
An auth module exports `authorize(request)` and verifies your existing login. Without a module, only the admin credential is accepted.
Startup requires at least one of those settings; public `--client-token` access has been removed. `close` writes the note to `report.json`; the server reads it, so the reporter sees it in "My reports".

### Remote mode

When the reports live on a hosted server, run the same commands from your own computer against its API:

```bash
export BUGFRAME_REMOTE=https://www.example.com/api/bugframe   # the widget's data-endpoint
export BUGFRAME_REMOTE_TOKEN=...                              # that server's BUGFRAME_ADMIN_TOKEN
npx bugframe list
npx bugframe export      # downloads the open reports into ./bug-reports and writes WORKLIST.md
npx bugframe close <id> --note "Fixed the overlapping footer"
```

`--remote URL` and `--token T` do the same for one command. `list` (also with `--json`) shows the server's short summaries,
`close` and `reopen` change the report on the server, and `show` and `export` also save the reports they print into `--dir`, so
every picture path exists. It uses the server's admin API, so it works with any storage adapter. The token has its own variable,
so a machine's own `BUGFRAME_ADMIN_TOKEN` never travels to another server. It is only sent over HTTPS (plain HTTP only to
localhost), redirects are refused, and downloads are checked like imports: exact ids, cleaned fields, real PNG pictures.
`export` skips a report whose pictures are missing or broken and says so. Downloads never overwrite a report that was not
downloaded, so keep `--dir` apart from the server's own folder. Closing or reopening a downloaded copy without `--remote` is
refused, so the note always reaches the reporter. `import` and `serve` work on local folders only.

## The workflow with an AI coding agent

1. People report problems as they find them (each one is a folder in `bug-reports/`).
2. When you have a batch: `npx bugframe export` writes `WORKLIST.md`, grouped by page, each item with the person's words, the
   link, the viewport, the element under the box and the picture paths. Reports on a hosted server: set `BUGFRAME_REMOTE` and
   `BUGFRAME_REMOTE_TOKEN` first ([remote mode](#remote-mode)).
3. Open your coding agent in the project and paste [`prompts/FIX_BUGS.md`](prompts/FIX_BUGS.md) (or the short
   [`FIX_BUGS_SHORT.md`](prompts/FIX_BUGS_SHORT.md)). It looks at the pictures, groups reports by cause, reproduces each at the
   reported size, fixes the root cause, proves it with before/after screenshots, runs the tests and closes every report with a
   plain-language note.
4. You review the diff. The reporters see "Fixed" and the note next time they open "My reports".

## Privacy and security notes

- Pictures are taken in the browser. Inputs, password fields, `data-bug-mask` elements and your `mask` selectors are painted over
  **in the image** before it is sent. Use `exclude` for things that should not even be in the layout (chat widgets).
- Console capture is **off** by default; URLs have secret-looking parameters redacted; metadata is only what you return.
- Nothing is sent anywhere except your endpoint. No analytics, no third-party services.
- All report routes require an approved account or admin credential. `authorize` verifies login and reporting permission on every request.
  URL flags, public tokens, and browser reporter ids never grant access. The admin token never belongs in a browser.
- Server hardening: ids are validated against one exact pattern before touching the filesystem, only three file names exist,
  uploads must be real PNGs (signature + header), images are served `nosniff` with a locked CSP, tokens are compared in constant
  time, bodies are size-limited while streaming.
- Reports can be shown to AI agents: treat their text as untrusted input (the supplied prompts say so).
- Details and how to report a vulnerability: [SECURITY.md](SECURITY.md).

Known limits: screenshots are drawn from the DOM (html-to-image), so cross-origin images without CORS headers, `<video>`, `<canvas>`
WebGL and some CSS effects can render blank or slightly different. Iframes' content is not captured. The mask is painted from
element positions at capture time; content that moves during capture can leave a gap, so keep `data-bug-mask` close to the data.

## Size

| Build | Raw | Gzip |
| --- | --- | --- |
| `dist/bugframe.min.js` (script tag, includes html-to-image) | 52 KB | 18 KB |
| `dist/bugframe.mjs` (ES module; html-to-image loaded on first report) | 51 KB (unminified, your bundler shrinks it) | 15 KB |

## FAQ

**Does it work on phones?** Yes: touch drag, 44px targets, safe-area insets, 16px inputs (no iOS zoom), the sheet rises above
the keyboard.

**Can reporters see each other's reports?** The server restricts lists and screenshots to the verified account, even if a caller forges a reporter header. Admins can see all. Destroy the widget when switching accounts to discard previews already loaded in the browser.

**Can I keep it on in production?** Configure the server's `authorize` hook to verify approved login sessions, then load the widget only for those accounts. UI visibility is a convenience; the API enforces access.

**Where do reports live?** In `bug-reports/<id>/`. Back that folder up like any data. Use a storage adapter for serverless hosts.

**Why not a SaaS tool?** Those are great for teams that want dashboards. This one is for owners and small teams who want the
reports as plain files that an AI agent can read, with nothing to sign up for.

**Can it create GitHub issues / Jira tickets?** Use the `webhook` or `onReport`, or write a storage adapter. A ready-made GitHub adapter is on the roadmap.

**Can the report include the DOM or a video?** Not yet (see roadmap): the goal is a tiny, safe default.

## Roadmap

- First-party adapters: S3/R2, GitHub Issues, SQLite.
- Annotation tools (arrow, pen) on the selected area; optional redo of the region.
- Optional DOM snapshot and short screen-recording as opt-in extras.
- More languages (community translations welcome).
- A tiny review page that lists reports and pictures for people who prefer a browser to a CLI.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run test:all` runs typecheck, unit/server/CLI tests, the build and the
Playwright end-to-end test.

Found a problem or have an idea? [Open an issue](https://github.com/vmatheus3/bug-frame/issues/new/choose).
Translations, integration examples, documentation improvements, and fixes are welcome.

## License

MIT, see [LICENSE](LICENSE). Bundles [html-to-image](https://github.com/bubkoo/html-to-image) (MIT), see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
