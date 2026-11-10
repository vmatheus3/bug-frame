# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project
uses [Semantic Versioning](https://semver.org/).

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
