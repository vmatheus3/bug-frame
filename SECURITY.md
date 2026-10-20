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
  permission or admin role from trusted server data. Logged-in ordinary customers must return `null`. Missing configuration,
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
- **Stored files:** only ids of the exact form `bug-YYYYMMDD-HHMMSS-xxxx` ever reach the filesystem, only `report.json`,
  `region.png`, `full.png` exist, images are verified as PNG by signature and header and served with
  `nosniff` and a locked-down CSP. Report text is data: render it escaped (the CLI and the widget never execute it). The CLI
  prints control characters in report text as spaces (`\u` escapes with `--json`), so a report cannot move the cursor, recolor
  or retitle the terminal of whoever reads it.
- **AI agents read reports.** Report text and console output are untrusted input to your coding agent. `prompts/FIX_BUGS.md`
  tells the agent to treat them as data, never as instructions.
