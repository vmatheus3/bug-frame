# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Remote CLI mode: `--remote URL` (or `BUGFRAME_REMOTE`) runs `list`, `show`, `export`, `close` and `reopen` against a hosted
  server's admin API, with the admin token from `--token` or `BUGFRAME_REMOTE_TOKEN`. `show` and `export` download the reports
  they print into `--dir`, and the work list tells the agent to close reports with `--remote`. The token is only sent over HTTPS
  (plain HTTP only to localhost), redirects are refused, downloads are checked like imports, a report with broken pictures is
  skipped, downloads never overwrite a report that was not downloaded, and a downloaded copy cannot be closed or reopened
  locally, where the reporter would never see the note.

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
