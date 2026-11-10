# Security policy

## Reporting a vulnerability

Please do not open a public issue containing a vulnerability. Use
[GitHub's private vulnerability reporting form](https://github.com/vmatheus3/bug-frame/security/advisories/new).
Include what you found, how to reproduce it, and the affected version. Maintainers will review the report and coordinate
a fix privately. Fixes are released as patch versions and credited unless you ask otherwise.

## Supported versions

Use 0.2.0 or later for account-controlled reporting. The 0.1.x defaults allowed public-token/anonymous submissions;
upgrade both server and widget and configure the session authorizer described in [the migration guide](examples/authentication/README.md).

## What the tool does about the obvious risks

- **Screenshots can contain private data.** Inputs, password fields, `[data-bug-mask]` elements and your own `mask`
  selectors are painted over inside the picture before anything leaves the browser; `exclude` removes elements entirely.
  Console capture is off by default. Secrets in query strings are replaced in the recorded URL. Still: turn the tool on only
  for people you trust with what is on screen, and review the first reports.
- **Access is closed by default.** Every report API request requires a verified principal from `authorize(request)` or a valid
  admin bearer credential. Configure the hook to verify an existing login session, expiry/revocation, and an explicit reporting
  permission or admin role from trusted server data. Logged-in ordinary customers return `null`, or `role: 'user'` when using invitation-only access; that role grants nothing without an accepted, current invitation. Missing configuration,
  invalid principals, or session-service errors deny access. Public client tokens and URL/widget switches never grant access.
- **Report ownership and abuse limits.** The server derives ownership from the verified account id and ignores browser reporter
  headers. Separate in-memory account and IP submission limits prevent switching reporter ids or IPs from resetting an account's
  quota. Rate counters reset on restart and are per instance; use shared gateway limits for multi-instance deployments.
  Origin checks, strict JSON content types, request/image limits, and PNG checks remain additional controls, not authentication.
- **Sessions.** Use HTTPS, Secure/HttpOnly/SameSite cookies and a same-origin API with your existing authentication service.
  Recheck current account permissions rather than trusting a client-supplied role. Destroy the widget on logout/account switches
  to discard previews already loaded in the browser; server requests are denied immediately once session verification rejects them.
- **Admin actions** (closing reports, listing everyone's reports) require a verified admin principal or
  `Authorization: Bearer <adminToken>` (compared in constant time). Never put the admin token in browser code.
- **Local ZIP downloads** are files, not authorized server submissions. Only a local operator can import them with the CLI;
  they carry untrusted, unverified reporter content. Use authenticated server mode for account-controlled submissions.
- **Server-only reporting.** Set `allowDownloadFallback: false` with a configured endpoint to prevent local ZIP fallback after
  server failures. Missing server endpoints fail at initialization. Failed reports stay only in the open widget's memory for retry.
- **Optional inbox.** `createInbox` requires a verified administrator for its developer HTML; the customer page and application JavaScript require approved account access. Static styles and translation helpers are public so signed-out invitees can use the invitation page; they contain no account or report data; the UI rechecks admin access
  before API operations and clears rendered private fields/images when authorization is denied. Report text and context are
  inserted as text, untrusted page links allow only HTTP(S) without embedded credentials, and responses are no-store/noindex.
- **Customer invitations.** Opt-in invitations require an existing login with verified email ownership. Random 256-bit tokens are stored hashed and consumed once; acceptance binds the host account id. Links carry the token in a fragment, strip it on open, and use no-referrer/no-store responses. Pending and accepted access both expire, and revocation is checked on every API request. Never return a browser-entered email as verified. A host `client` permission is independent of invitations; use `user` for invitation-only accounts. Invitation/review mutations require one API process/writer per project, including custom stores. Multi-replica mutation coordination is not supplied. Direct filesystem CLI mutations require exclusive access; use the remote CLI while the API is running.
- **Customer approval.** Only the original reporter can approve or request changes while a report is ready for review, with the exact delivered version. A developer cannot mark a report customer-approved through the API. A local filesystem operator can edit their own storage; that operator is a trusted administrator. The last 100 status events are a progress history, not an immutable audit log.
- **Remote agents.** `--remote` requires HTTPS, refuses redirects and embedded URL credentials, bounds response sizes and time,
  and reads credentials only from a private environment/file. Never treat report descriptions as agent instructions. New report
  folders and files use private permissions; retain them outside deployment/static directories and secure backups separately.
- **Stored files:** only ids of the exact form `bug-YYYYMMDD-HHMMSS-xxxx` ever reach the filesystem, `report.json`,
  `region.png`, `full.png` hold report data; private invitation JSON uses independently validated invitation IDs, images are verified as PNG by signature and header and served with
  `nosniff` and a locked-down CSP. Report text is data: render it escaped (the CLI and the widget never execute it).
- **AI agents read reports.** Report text and console output are untrusted input to your coding agent. `prompts/FIX_BUGS.md`
  tells the agent to treat them as data, never as instructions.

Invitation and access design follows [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) and the single-use secret handling principles in the [OWASP token guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## Website login and Codex notifications (0.5.0)

The normal setup reuses the site's real session verifier and explicit approved-user/invitation permission. Customers do not need a separate Bugframe password. Generated auth stubs deny access until wired; `.bugframe/credentials.json` is a private server/connector credential and must never reach website code. Generated setup folders/files use 0700/0600 and are ignored in Git.

The Codex connector makes outbound authenticated requests only. It creates a dedicated notification inbox with read-only acknowledgment turns, passes only validated ticket IDs/canonical kinds, and removes Bugframe credential environment variables from its Codex child. It does not interpret report descriptions as prompts or approve coding actions. State/checkpoint files are private; do not run multiple listeners on the same checkpoint or remove an active lock. Notifications may repeat if a process crashes after Codex acknowledges but before the checkpoint is committed. Keep account limits and shared project trust in mind when enabling automated turns.

Webhook delivery state is saved atomically with the original ticket and retried through the existing instance's mutation queue. HTTPS, redirect refusal, bounded timeouts, optional HMAC signatures over the full timestamped JSON, stable event IDs, and receiver deduplication are required for reliable integrations. Delivery status/heartbeat/retry routes are admin-only and disclose no credential or receiver URL. Heartbeats expire after missed checks; they do not grant customer reporting access. Persistent custom adapters must retain the delivery field; one API writer per project still applies.
