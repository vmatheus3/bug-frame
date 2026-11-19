# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-11-18

### Fixed
- `bugframe doctor` (and the CI `doctor` step) crashed on Node.js 18: loading Playwright there exits the whole process. Audit and crawl now check the Node.js version first and say they need Node.js 20+; doctor reports it as a problem line and still finishes.

### Added
- Whole-site crawl, script only: `bugframe crawl <start-url>` opens every page of a local site in a real browser (breadth-first through same-site links, `area`/`data-href`/router links, redirects, `sitemap.xml` and pushState or `#/hash` routes reached by clicks), collapses record pages into route templates (`/clients/123` → `/clients/:id`, two pages each), clicks every safe control in a fresh page and records its outcome (`navigates`, `opens`, `changes`, `calls-backend` with the blocked or fired request, `error`, `dead`). Whole-system checks: dead controls and forms, click errors, broken links and routes, orphan and broken sitemap entries, header/nav/footer regions that differ between pages, one label leading to several places (and one place with several labels), the same button wired differently on different pages, missing or duplicate titles and headings, the same console error on many pages, failing endpoints grouped across pages, loading states that never finish and mixed languages, plus the `audit` page probe on every page. Writes `crawl.html` (self-contained, filterable, light and dark, phone-friendly, with screenshots and a site map of what every control does), `CRAWL.md` for coding agents and `crawl.json`. Same guards as `audit` (local sites unless `--allow-remote`, writes, forms, WebSockets and beacons blocked, destructive and sign-out controls never clicked) plus caps on pages, depth, clicks per page and time; `--fail-on` exits 1 for CI. `bugframe crawl login <url> --save FILE` lets a person sign in in a visible browser and saves the session (mode 0600, never printed) for `--storage-state`. Optional `--summarize [--model haiku] [--budget 20000]`: a small model, confined like the `audit` auditor and given only a trimmed `crawl.json`, writes `SUMMARY.md`, a fix plan grouped by root cause that may cite only real findings (else degraded with a script-only fallback). Details: `docs/crawl.md`.
- The demo server (`npm run example`) has a fictional multi-page "Northstar Studio" dashboard at `/studio` with problems planted for the crawl.
- Token-budgeted worklists, opt-in: `export --budget TOKENS|NNNc|none` (no budget by default; unlimited output unless you pass it). Over budget, near-identical reports (same page, marked element, and console-error class) merge into one item with a `Reported N times` count, long console errors are trimmed to the first line plus the first user-code stack frame with an explicit `lines omitted` marker, items are ordered most-reported first then newest, and anything dropped is counted in a closing marker. A worklist that fits is unchanged by the budget, and the top item is always kept, trimmed as hard as the cuts allow, even when it alone exceeds the budget.
- Every worklist item carries an executable `Repro:` block (URL, viewport, element selector, captured console error), and `export --playwright` writes `WORKLIST.repro.spec.mjs` with a failing-first Playwright skeleton per report: navigate, check the marked element, and assert the captured console error does not occur — red on the broken page, green once fixed.
- Page analysis. Administrators get **Analyze this page** in the widget menu (shown only when `GET /access` returns `admin`; the server refuses `kind: "audit"` from anyone else with 403). `bugframe audit <url> --project DIR` and `bugframe audit --watch --dir REPORTS --project DIR [--base-url URL] [--once]` measure the page with Playwright at four viewports in light and dark mode (errors, failed requests, overflow, clipping, contrast, images, accessible names, tap targets, overlaps, icon alignment, broken links, and a click probe that aborts every non-GET request, never submits forms and never clicks destructive controls), then run a specialised auditor (`prompts/AUDIT_PAGE.md`) on that evidence and a blind copy of the code. The result is `audit.md` (severity table, findings with evidence, `file:line` cause and fix, prioritised fix list) plus `audit.json`, validated against a fixed format; an unusable answer is kept raw and the run marked degraded with a probe-only report. Watch mode moves requests `open → in_progress → ready_for_review` with a summary note, and records attempts (at most three) on failure.
- Blind workspace: the auditor's copy of the project leaves out agent instruction files and folders at any depth and in any case (AGENTS.md, CLAUDE.md, GEMINI.md, .claude, .agents, .keel, .codex, .cursor, .aider*, Copilot instructions, …), secrets, build output and large binaries, plus a project `.bugframe-blind` ignore file; it never follows symlinks and refuses to run below an instruction file. With `--agent claude`, Claude Code runs with no settings, hooks, skills, MCP servers or session files and read-only tools confined to the workspace. `bugframe audit --check-blind` verifies this on the user's machine (canary and outside-read refusal); verified on 2026-11-18 with Claude Code 2.1.325, including a negative control. Codex is not offered as a blind auditor because it still loads the global `~/.codex/AGENTS.md`; `--agent-cmd` runs other agents with a warning.
- Page analysis safety: audits run only against local pages (`localhost`, `*.localhost`, `*.test`, `127.0.0.0/8`, `::1`, `0.0.0.0`); `--base-url` (now also for one-shot audits) points a captured live URL at a local server, and the new `--allow-remote` flag accepts a non-local page with a loud warning. The probe also blocks WebSockets (Playwright 1.48+ required), beacons, downloads and popups, matches destructive words in whole URLs (path and query, camelCase/kebab/snake parts) as well as labels, and runs the link check through the same guard (GET only, same origin, redirects checked hop by hop). The blind copy also leaves out `.bugframe` (setup guide and credentials), credentials and key material (`.npmrc`, `.netrc`, `.git-credentials`, `.aws`, `.ssh`, `credentials.json`, `serviceAccount*.json`, `*.pfx`, keystores, SSH keys, `secrets/`, …), the reports and output folders, everything the project's `.gitignore` files ignore, and more agents' instruction files (`AGENT.md`, `CONVENTIONS.md`, `.junie`, `.trae`, `.augment`, `.goosehints`, `.rules`, `.amazonq`, `.qodo`, `.github/prompts`, `.github/chatmodes`). `--check-blind` now also requires the model to answer exactly `NONE` when asked for instruction sources beyond its system prompt. Ctrl+C and `--timeout` kill the auditor's whole process group and always remove the blind copy; an interrupted watch request returns to `open` without using an attempt.
- Server and storage: `GET /reports/:id/audit.md` (admin-only, `text/markdown`, `nosniff`, `no-store`, sandbox CSP); optional `StorageAdapter.writeAttachment(id, name, data)` for exactly `audit.md` and `audit.json` (2 MB cap) in file and memory storage. Adapters without it keep working (note-only results). The private inbox shows a Page analysis badge, filter and the report. English, Spanish and Portuguese strings for every new message.

- The inbox renders the page-analysis report instead of showing raw Markdown: headings, the findings table with severity labels, lists, code and quotes, plus **Copy analysis as Markdown** for a coding agent. The report quotes the audited page, so it is treated as untrusted: elements come from a fixed tag list and are built from text nodes only, nothing from the report becomes an attribute, links and images are never made live, and huge input is bounded.
- Remote mode, completed. `bugframe --remote URL export` copies the open requests and their screenshots into a private local folder (`0700`/`0600`, pictures verified as PNG) and writes `WORKLIST.md` there with local picture paths and instructions to hand work back with `bugframe --remote URL ready <id>`; `--all`, `--budget`, `--playwright` and `--out` work as for a local folder. `bugframe audit --watch --remote URL --project DIR --base-url URL` processes "Analyze this page" requests of a hosted site: the API is the queue and the store.
- Server: `PUT /reports/:id/audit.md` and `/audit.json` for those uploads. Admin only; page-analysis requests only; exactly those names; UTF-8 text or valid JSON; 2 MB enforced while streaming; only when the storage adapter implements `writeAttachment`; not offered to cross-origin browsers. `PATCH /reports/:id` accepts the watcher's bookkeeping (`audit`: attempts, times, counts, last error) in a fixed shape, for page-analysis requests only. `routeHandlers()` returns `PUT` as well.
- `bugframe connect agent --remote URL --project DIR --agent-cmd "COMMAND"`: the connector for any agent or script, not only Codex. The command runs once per batch of new tickets with their validated ids and kinds on stdin (JSON) and in `BUGFRAME_REPORT_IDS`, `BUGFRAME_REPORT_COUNT` and `BUGFRAME_API`; it never gets a customer's text or the private credential; exit code 0 acknowledges, anything else keeps the batch queued; what it prints is shown by the listener.
- Crawl for CI: `--save-baseline FILE` and `--baseline FILE`. Every finding has a fingerprint that survives between runs; with a baseline, findings are marked new or already known, fixed ones are counted, the reports lead with what is new (`crawl.html` gets a filter) and `--fail-on` only looks at new findings.
- `bugframe --dir REPORTS crawl <url>` also files the run in the private inbox as a finished page analysis with the short report and a picture of the start page.
- Crawl findings `offsite-redirect` (a page redirects to another site; never followed, reported with the full target) and `redirect-loop`; click outcome `unknown` for a page that keeps changing on its own.
- `--settle-ms` for `crawl` and `audit` (how long a click gets to show an effect; 700 ms by default, was fixed).
- `bugframe doctor` (what works on this machine: Node.js, the reports folder, Playwright and its Chromium, Claude Code, Codex, and the command to get what is missing), `bugframe help <command>` / `<command> --help` for one command's options, and a suggestion for a mistyped command.

### Changed
- `CRAWL.md`: a link or button that is the same on three or more pages is one row of the wiring map with its page count (every row stays in `crawl.json`), and each finding shows its fingerprint. A 200-page site no longer pays for its menu 200 times.
- The crawl collapses dates (`/calendar/2026-01` → `/calendar/:date`), versions and ranges (`1.2.3`, `10-20` → `:id`), and keeps pages that differ only by a number inside a word (`/blog/page-2`) to six, so calendars and paginated lists cannot grow a crawl without end. The link check after the crawl now stops with `--max-minutes` and Ctrl+C.
- `bugframe crawl login` without a terminal (stdin closed or piped) no longer saves at once: it waits for the browser to leave the sign-in page (ten minutes at most), or saves nothing and says why.
- Widget accessibility: the popover behind the round button is a labelled dialog; only its actions are a menu of menu items, with Up/Down/Home/End moving between them; the request list and "Turn off" sit beside it (a menu may not contain links, buttons and a text box, and accessibility checkers on the host page reported it). The round button still shows the bug drawing and now announces a dialog. Review states get their colour in the request list.
- `list` keeps its columns aligned for every status; an empty list from a folder that does not exist names the folder; CLI messages show paths relative to the current folder when they are below it; `setup` and the inbox status line no longer assume Codex.
- The package is about 0.35 MB instead of 2.3 MB: the README pictures are no longer packed (`files` holds `docs/*.md`).
- The widget's round menu button next to "Leave feedback" now shows a small bug drawing instead of a three-line menu icon (same label, menu behaviour, spinner and open-count badge).
- The page-audit click probe now also notices a dialog, menu or popover opening, `aria-expanded` turning true and focus moving, and records where a submitted form would have gone (`FORM POST /api/save`, never sent); such clicks are no longer reported as dead.
- The `WORKLIST.md` header now tells agents to hand verified work back with `bugframe ready`, matching the prompts and the 0.5.0 review flow; `close` is named as the legacy path. This changes every generated worklist.
- Every `WORKLIST.md` item now includes a `- Repro:` block (URL, viewport, element selector, expected result). This changes every generated worklist.

### Fixed
- Crawl and audit guard, found by an independent review and fixed test-first against a fixture site that tries each of them:
  - A WebSocket opened from a Web Worker reached the server (Playwright's WebSocket routing lives in the page). Dedicated workers now start behind a stub that fails and records their sockets, whether they come from a URL, a blob or a data URL; SharedWorkers and workers started by a worker are not started at all, because their requests cannot be routed (a SharedWorker's `POST` went through unguarded). WebTransport is blocked too.
  - A redirect to another site was followed, from the start URL and from a link or click: the other site received requests and its script ran, and the report showed the target as a local path. Navigations are now fetched one hop at a time; a redirect off the site or to a destructive-looking URL is aborted before anything is requested there and reported with its full target.
  - "Log off" was clicked and its page crawled, ending a saved session. The word list gains log off, sign off, end session and more Portuguese and Spanish forms (deslogar, encerrar/terminar/finalizar sessão, salir, finalizar/terminar sesión, desconectarse); a link whose label is destructive bans its address from the crawl and the link check; and once a click was dispatched, an API call to a destructive-looking URL (`GET /api/logout`) is blocked.
  - A dead `href="#"` link was reported as navigating to its own page; it is dead. A working in-page anchor is not flagged.
  - A page that polls or shows a clock turned a button without a handler into `calls-backend` or `changes`. What the page does by itself is measured in the window before the click and subtracted; a click with no effect of its own there is `unknown` (*unclear* in `audit`), never dead and never working. A fetch that fails because the guard blocked it no longer counts as an error of the click.
  - If the guard itself fails on a request, the request is aborted instead of passed on.
  - A request the page fired (a click's `fetch('/feed')`, or one made while loading) followed its redirects unchecked, because Playwright shows a route only its first URL: `/feed` → 302 `/api/session/end` reached the server. Such requests (fetch, XHR, worker scripts) are now fetched one hop at a time; a hop to another site, to a destructive-looking URL (now also `session end`) or past the fifth is refused and recorded as `BLOCKED GET <target>` with the hop it came from. EventSource streams still follow their redirects in the browser (a stream never ends, so it cannot be fetched whole).
  - A start page or a linked page that redirects to itself was reported as a broken link with Playwright's raw error and the local address. It is now a `redirect-loop` finding with paths only, and no finding quotes a raw browser error (`page.goto: net::ERR_…`): errors are reduced to short messages without addresses.
- The inbox's report renderer took quadratic time on a long run of backticks with no closing run (100,000 backticks: 8 s); an unmatched run is now text in one step.
- `connect agent`: Ctrl+C now stops a running agent command with its whole process group at once (it used to wait up to ten minutes) and says which tickets were interrupted; they stay queued.
- Widget: Escape (or the round button) closing the menu popover returns focus to the round button that opened it, not to the feedback button.
- `crawl.html`: the severity, type, page and search filters updated the counter but hid nothing (the card's `display: grid` overrode the `hidden` attribute).
- The SvelteKit snippet in `examples/vue-svelte` was not valid JavaScript; the static-download example pointed at an old release.

## [0.5.0] - 2026-11-10

### Added
- Simple reporting: a labeled feedback button, automatic screenshot, one message, and send. Optional spot selection supports taps or dragging; categories and content fields live under More options. All new text supports English, Spanish, and Portuguese.
- Mobile form layout that keeps send above the virtual keyboard, preserves capture-time viewport metadata, and restores page scrolling after dismissal. Customer/developer requests use clear list/detail screens with a back button on phones.
- `bugframe setup --site HTTPS_ORIGIN` generates a private, fail-closed integration starter and Codex instructions for reusing the website's verified login. Customers need no extra Bugframe code or password. Private connector credentials are generated automatically and ignored in Git; existing setup files are preserved.
- `bugframe connect codex --remote HTTPS_API --project FOLDER` runs an outbound listener for new tickets. A dedicated Codex inbox receives read-only acknowledgment turns. Private checkpoints survive normal restarts, temporary API outages retry, and failed notifications remain unacknowledged for reconnect. Ticket descriptions and server credentials stay out of notification prompts.
- Developer connection status, admin-only heartbeats, durable webhook delivery state, exponential retries, stable event IDs, and manual retry for exhausted deliveries. Report storage provides persistence; receivers must deduplicate at-least-once deliveries.

### Changed / upgrade notes
- Upgrade widget and server together. Use `selection: 'area'` to retain the old area-first interaction. Existing account/invitation authorization remains required; anonymous reporting stays disabled.
- Custom storage adapters must preserve `delivery` fields. Webhook destinations require HTTPS without embedded credentials/fragments; HTTP loopback is an explicit testing option. Changing a webhook target does not automatically replay old private events there.
- Codex CLI sign-in and a running connector are required for notifications; acknowledgment turns use that account's usage limits. Normal code work remains an explicit user task.
- Add Chromium and WebKit mobile checks, including virtual-viewport keyboard geometry, one-tap reporting, element selection, and mobile request navigation. Refresh documentation images for the simpler interface.

## [0.4.1] - 2026-10-23

### Fixed
- Complete English, Spanish, and Portuguese support across the developer inbox, customer requests, invitation acceptance, access-denied pages, statuses, dates, validation, and success/error responses. The widget’s authorization copy now consistently refers to feedback.
- Add a portal language selector, `createInbox({ locale })`, browser language negotiation, and shareable `?lang=en|es|pt` preferences. Switching languages keeps unsaved notes, selected statuses, and pending invitation secrets in memory. The same-origin widget in `auto` mode follows the saved preference.
- Serve data-free styles and translation helpers to signed-out invitees so the public invitation page renders correctly. Request pages, application JavaScript, reports, and screenshots retain their authorization checks.

### Documentation
- Replace the three outdated illustrative GitHub images with real screenshots and add invitation, review, approval, Spanish, and Portuguese screenshots.
- Add a reproducible screenshot command and a fictional client website demo. Captures use disposable sessions/storage and actually change the example headline before the customer approves it.
- Let the localhost demo test runner explicitly raise its sign-in limit for the expanded browser matrix; the default remains 20 attempts per minute.

## [0.4.0] - 2026-10-23

### Added
- Broader feedback kinds: bugs, content changes, design improvements, and ideas. Content requests can include current and suggested wording. The customer widget uses friendly feedback/request language in English, Spanish, and Portuguese.
- Optional customer invitations in the developer inbox, bound to verified host-account email and then stable account identity. One-use random secrets are stored hashed, links use fragments, access expires (default 7, maximum 30 days), and admins can revoke it immediately for subsequent requests.
- Separate customer request page at `/bugs/review`, showing only the reporter's own feedback, screenshots, developer updates, and review controls; technical context and invitation management remain in the developer view.
- Reviewed, in-progress, ready-for-review, adjustment-requested, and customer-approved statuses with a bounded progress history. Only the original reporter can approve a current delivery; stale or duplicate responses are refused.
- Local and remote `bugframe ready <id> --note "what changed"` commands. Coding worklists include content/review context and exclude deliveries already waiting for customer review.

### Changed / upgrade notes
- Upgrade server and widget together. Old report files and `open`/`fixed`/`wontfix` remain compatible; update custom status consumers/adapters for the expanded statuses and retain the new fields. `fixed` remains a developer resolution, not customer approval.
- Default type chips are replaced by the four feedback kinds; `types` still supplies optional extra tags. Existing text overrides remain available.
- Invitations are opt-in and use the website's existing verified sign-in system; they do not supply accounts, email delivery, or password recovery. Use `role: 'user'` for invitation-only customers. Existing `client` permissions remain controlled by the host.
- Invitation consumption and review updates require one API process/writer per project, including custom stores. Multi-replica mutation coordination is not supplied in this version; use shared gateway limits where appropriate.

### Security
- Recheck invitation membership, expiry, and the host login on each API request. Deny unverified/mismatched emails, replayed invitation secrets, and unauthorized invitation management or review actions.
- Serialize review mutations within an instance and require the delivered review version. Clear private browser previews after authorization failures/page exit and ignore stale list responses.
- Same-origin checks now compare the full origin, including its scheme.

## [0.3.0] - 2026-10-23

### Added
- Supported `allowDownloadFallback: false` widget policy and script-tag attributes for server-only reporting. Failed/offline
  requests retain the report for retry; explicit ZIP download workflows and default fallback behavior remain available.
- Optional `createInbox` administrator interface with configurable paths/name/labels, private screenshots, safe report rendering,
  status notes, and existing-session authorization. `GET /access` checks the current verified role without creating a session.
- Explicit remote CLI mode for list/show/close/reopen, private environment/file credentials, verified HTTPS, redirect refusal,
  bounded responses and request timeouts. Local CLI behavior remains supported.
- Portable persistent-hosting example with deployment-independent storage, optional single-owner sessions, private key files,
  metadata-only report-created events, and guidance for backups, key rotation, proxy trust, and integration migration.

### Fixed
- Explicit server mode rejects missing/blank endpoints instead of silently producing local ZIP files.
- New filesystem report directories/files use private 0700/0600 permissions, including atomic JSON replacement files.
- Node adapters honor forwarded IP/protocol only with explicit proxy trust and handle comma-separated protocol headers.

### Security / development
- Upgrade the development-only Vitest runner to patched 4.1.12, removing vulnerable mocker/worker-pool dependencies. Runtime
  support stays Node 18.17+; development/widget tests require Node 20+. CI retains native server/CLI checks on Node 18.
- Existing server-verified account permissions, admin restrictions, ownership, and authorization-failure ZIP protections remain enforced.

## [0.2.0] - 2026-10-17

### Security / breaking changes
- Close all report APIs by default. Require a server-verified `{ id, role }` principal or admin credential; public widget
  tokens and legacy string/boolean authorization results no longer grant access.
- Derive report ownership from verified account identity and apply separate account/IP rate limits. Browser reporter ids
  cannot claim another account's reports or reset the account quota. Require JSON content type and disable screenshot caching.
- Add a local sign-in demo with expiring HttpOnly sessions and server-side logout/revocation; include session integration
  and migration guidance for existing websites. The CLI supports `--auth-module` and rejects public-token configurations.
- Explain denied access in English, Spanish, and Portuguese, keep descriptions for retry, and suppress ZIP fallback on 401/403.
- Preserve report-button and menu-action DOM nodes during background report refreshes so taps are not lost on mobile.
- Add regression coverage for unauthenticated/unauthorized access, forged identities, revocation, ownership isolation,
  account/IP limits, strict content types, and real browser sign-in/logout.

## [0.1.1] - 2026-10-17

### Fixed
- Select explicit server and CLI test files so the test command works on Node.js 18, 20, and 22.

## [0.1.0] - 2026-10-17

First public release.

### Added
- Public community repository, MIT licensing, illustrated usage guide, contribution and issue links, and downloadable
  browser bundle and package through GitHub Releases.
- Widget: Shadow DOM floating button, drag/touch/keyboard region selection or whole screen, description and type chips,
  region and full screenshots (html-to-image), viewport, URL (secrets redacted), element path under the box, optional
  console errors, custom metadata hook, input/password/`data-bug-mask` masking, "My reports" with status and fix note,
  English/Spanish/Portuguese strings, backend-less download mode (.zip), script-tag and npm use.
- Server: fetch-style handler plus Node/Express and route-handler adapters; token auth, CORS allowlist, body and image
  limits, PNG verification, rate limit, per-reporter lists, webhook with HMAC signature, storage adapter interface, filesystem
  and in-memory storage.
- CLI: `list`, `show`, `export` (grouped `WORKLIST.md`), `close`, `reopen`, `import`, `serve`.
- `prompts/FIX_BUGS.md` and a short variant for AI coding agents.
- Examples for plain HTML, React, Vue/Svelte, Next.js, Express, static sites.
