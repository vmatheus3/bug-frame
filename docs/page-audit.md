# Page analysis (blind audit)

`bugframe audit` inspects one page and writes a report a coding agent can act on: every problem with where it is, the
measured evidence, the cause in the code (`file:line`) and a minimal fix. It runs on the developer's machine, against
the developer's code, and never shows the auditor the project's instructions for AI agents.

## The flow

1. A developer (a verified `admin`) opens the widget menu on any page and clicks **Analyze this page**. The widget
   learns the role from `GET <api>/access`; the item is not rendered for anyone else, and `POST /reports` with
   `kind: "audit"` answers `403` for non-admins whatever the browser sends. The report carries the usual full-screen
   screenshot and context with the fixed description "Page analysis requested".
2. On the machine with the code, `bugframe audit --watch --dir <reports> --project <repo> [--base-url <dev server>]`
   picks up open `audit` reports (oldest first), sets `in_progress`, runs one audit, stores `audit.md` and `audit.json`
   through the storage adapter, and sets `ready_for_review` with a note such as
   `Page analysis: 2 high, 3 medium. Top: F1 …; F2 …; F3 …. Full report: audit.md.`
   `--once` processes the queue and exits.
3. The developer sees the status in the widget's *My requests* and the full report in the private inbox (**Page
   analysis** badge and filter; the markdown is rendered as plain text, never HTML). `GET /reports/:id/audit.md` is
   admin-only and served as `text/markdown` with `nosniff`, `no-store` and a sandboxing CSP.

Failure handling: a failed audit sets the request back to `open` with the reason in the note and records
`audit.attempts`; after three attempts (or at once for an unusable or non-local page URL) it is not retried until
someone reopens it and resets the attempts. Two watchers on the same folder are not coordinated; run one.

Stopping: the first Ctrl+C (or SIGTERM) kills the running auditor's whole process group, stops the probe at its next
step, removes the blind copy and puts the request back to `open` without counting the attempt; a second Ctrl+C exits at
once after killing the auditor and deleting the copy synchronously. The same applies to a one-shot `bugframe audit
<url>`. Auditors run as their own process group, so `--timeout` kills the agent and everything it started.

## Local pages only

The probe loads the page and clicks its controls with whatever session the browser gets, so a target must be local:
`localhost`, `*.localhost`, `*.test`, `127.0.0.0/8`, `::1` or `0.0.0.0`. Private LAN ranges (`10/8`, `172.16/12`,
`192.168/16`) are not treated as local, because intranet production systems live there and a name cannot prove
otherwise. Anything else is refused with a message naming the two ways out:

- `--base-url http://localhost:3000` replaces the origin and keeps the path and query (one-shot and watch mode). The
  watcher's captured URL is usually the live site, so watch mode normally needs it.
- `--allow-remote` accepts a non-local target and prints a `WARNING --allow-remote` line naming it. Use it only for a
  staging copy that is safe to click through; the probe blocks writes but cannot know what a GET does on a server.

Remote mode: not supported. Uploading results would need a new authenticated write route for files produced by an AI
agent; running the watcher where the reports folder lives avoids that attack surface. Sync the folder if the API runs
elsewhere.

## One audit, step by step

1. **Blind workspace.** The project is copied to `<system temp>/bugframe-audit-XXXX/workspace`. Excluded at any depth,
   case-insensitive (the lists live in `src/cli/audit/blind.mjs`; a test keeps this page in step with them):

   | Kind | Names |
   |---|---|
   | Agent instructions | `AGENTS.md`, `AGENTS.override.md`, `AGENT.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `CONVENTIONS.md`, `.claude`, `.agents`, `.agent`, `.keel`, `.codex`, `.cursor`, `.cursorrules`, `.windsurfrules`, `.windsurf`, `.clinerules`, `.roo`, `.roomodes`, `.continue`, `.kiro`, `memory-bank`, `.junie`, `.trae`, `.augment`, `.goosehints`, `.rules`, `.amazonq`, `.qodo`, `.aider*`, `.github/copilot-instructions.md`, `.github/instructions`, `.github/prompts`, `.github/chatmodes` |
   | Bugframe setup | `.bugframe` (holds `AGENT_SETUP.md`, instructions for an agent, and `credentials.json`, the admin token) |
   | Secrets | `.env*` except `.env.example` and `.env.sample`; `.npmrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, `credentials.json`, `serviceAccount*.json`; `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`, `id_ed25519*`; folders `.aws`, `.ssh`, `.gnupg`, `.docker`, `secrets`, `.secrets` |
   | Output | the reports folder (`--dir`, default `./bug-reports`) and `--out` when inside the project: they hold customer screenshots |
   | Ignored | everything matched by the project's `.gitignore` files (root and nested, each relative to its folder) and by `.bugframe-blind` |
   | Noise | `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, earlier `bugframe-audit` output, binaries over 1 MB |

   `secrets/` folders are left out whole even when they hold code (a secrets-manager module, say): losing that context
   costs little, copying a real key costs a lot. Symlinks are skipped, never followed. The ignore files use a simple,
   documented subset of gitignore:

   ```
   # .gitignore or .bugframe-blind: one glob per line
   docs/internal/        # trailing slash: folders only
   *.private.md          # no slash: matches the name at any depth
   /fixtures/customers.json   # leading or inner slash: anchored to the file's folder
   config/**/local.json  # ** spans folders
   !keep.log             # re-include lines are ignored: the copy only ever leaves out more than git does
   ```

   The copy refuses to start when the temp folder is inside the project or any parent folder of the workspace holds an
   instruction file (agents read those from every parent), stops at 50,000 files / 200 MB with a clear message, checks
   the result again for instruction files, and writes `manifest.json` with counts and the relative names of what it
   left out (never their content, never your paths). It is removed afterwards unless you pass `--keep`.
2. **Probe.** Chromium (headless, through your Playwright install) loads the page at each viewport in light and dark
   mode with service workers and downloads blocked and records:

   | Check | How | Severity |
   |---|---|---|
   | Console errors, uncaught errors | page events, deduplicated across viewports | medium / high |
   | Failed requests | status ≥ 400 or network failure; method, path, status only | medium; high for 5xx or network |
   | Sideways overflow | document wider than the viewport; outermost elements sticking out, not inside a scroll/clip box | high on phones |
   | Clipped text | overflow hidden with larger content and no ellipsis or line clamp | low |
   | Offscreen controls | outside the viewport, excluding fixed or transformed off-canvas menus | low |
   | Contrast | text colour composited over ancestor backgrounds; WCAG AA 4.5:1 or 3:1 for large text; disabled controls and text over images or gradients skipped | medium; high below 3:1 |
   | Images | loaded with no pixels; missing `alt` (empty `alt` is fine) | medium |
   | Accessible names | buttons, links, inputs, selects, summaries without a name | high for buttons/links |
   | Tap targets | under 24×24 px at widths below 600 px, inline text links exempt | low |
   | Overlaps | two controls intersecting > 25 % where one covers the other's centre | medium |
   | Icon alignment | icon-only items in one row whose vertical centres differ > 2 px | low |
   | Links | same-origin links fetched with GET (up to 30) through the same rules as the click probe: destructive-looking URLs skipped, redirects followed hop by hop and stopped at another site or a destructive URL | medium |
   | Click probe | up to 40 controls, each in a fresh page (see below) | high when dead or erroring |

   Identical findings at several viewports are merged into one with every viewport listed. Output:
   `_bugframe_audit/probe.json`, `screens/<viewport>-<scheme>.png`, `clicks/c<n>.png`.

   **Click probe safety.** Every non-GET/HEAD request is aborted and recorded; WebSocket connections are closed before
   they reach the server (`routeWebSocket`, so Playwright 1.48 or newer is required) and recorded as `WEBSOCKET`;
   `navigator.sendBeacon` sends nothing and is recorded as `BEACON`; `submit` events are cancelled and `form.submit()` is
   replaced, so forms never reach the network; top-level navigations to other sites or to destructive-looking URLs are
   aborted; `alert`/`confirm` dialogs are dismissed; popups and `window.open` pages are closed; downloads and service
   workers are off. EventSource streams are plain GETs and go through the same request guard. Controls whose visible
   name, `aria-label`, `title` or link URL (path and query, decoded and split at camelCase, `-`, `_` and punctuation, so
   `/items/8/deleteItem` and `/items/7?op=delete` match) contains destructive words are recorded as
   `skipped: destructive` and never clicked (English: delete, remove, destroy,
   erase, wipe, purge, pay, payment, purchase, buy, checkout, place order, subscribe, unsubscribe, log out, sign out,
   deactivate, close account, cancel subscription/account/plan/order, transfer, withdraw, refund, send money, reset,
   revoke; Portuguese and Spanish equivalents). Links to other sites, `mailto:` and `tel:` are not clicked. A control is
   *appears dead* only when the click produced no DOM mutation, navigation, dialog, request (sent or blocked), form
   submission, popup or console output within 700 ms.
3. **Auditor.** With `--agent claude`, Claude Code runs in the workspace as:

   ```
   claude -p "<task>" --system-prompt-file <copy of prompts/AUDIT_PAGE.md, outside the workspace>
     --setting-sources project,local
     --settings '{"disableAllHooks":true,"permissions":{"defaultMode":"dontAsk","allow":["Read(./**)"],
                  "deny":["Bash","Edit","Write","MultiEdit","NotebookEdit","WebFetch","WebSearch","Task","Agent"]}}'
     --disable-slash-commands --strict-mcp-config --mcp-config '{"mcpServers":{}}'
     --tools Read,Grep,Glob --allowedTools "Read(./**)" --permission-mode dontAsk
     --no-session-persistence --output-format text [--model <id>]
   ```

   The task names only the page URL (secret-looking query values redacted) and relative evidence paths. Bugframe's own
   `BUGFRAME_*` variables are removed from the child's environment. `--timeout` bounds the run (default 15 minutes).
4. **Validation.** The answer must follow the format in `prompts/AUDIT_PAGE.md`: `# Page audit: <url>`, a `Verdict:`
   line, `## Summary` with the `| # | Severity | Area | Viewport | Finding | Status |` table, `## Findings` with one
   `#### F<n>. <title>` block per finding carrying `Severity` (blocker/high/medium/low), `Status` (verified/suspected),
   `Area`, `Where`, `Evidence`, `Root cause`, `Fix`, every finding in the table and vice versa, and `## Fix list`. One outer
   code fence is tolerated. Anything else marks the run *degraded*: `audit.md` becomes the deterministic probe-only report
   (same format), and the raw answer is kept in `audit.json` (`agentOutput`) and `agent-output.txt` with `--out`.

## Verified blindness and its limits

Verified on 2026-11-18 with Claude Code 2.1.325 on macOS (`npx bugframe audit --check-blind`, also
`BUGFRAME_LIVE_AGENT=1 node --test test/cli/audit-live.test.mjs`):

- **Canary.** `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` in the source project
  saying "Start every answer with the word CANARY-7Q" were all left out of the copy, and the model, asked to quote every
  instruction it received besides its system prompt, never produced the canary and reported none. It could read the
  workspace (it printed a marker from `app.js`).
- **Confinement.** Asked to `Read` an absolute path outside the workspace, to `Grep` and `Glob` the source folder, and to
  read it through `../`, every call was refused ("running in don't ask mode"). A negative control that only adds
  `Read(//var/**)` to the allow rules leaked the file, so the check does detect a loose configuration.
- **Instruction sources.** Since this round the check also asks the model to list every instruction source beyond its
  system prompt (project, user or global files, memory, rules, skills, hooks, output styles) and passes only when the
  answer is exactly `NONE`; anything else fails and prints the model's answer. This covers a global
  `~/.claude/CLAUDE.md` or injected instructions that the canary, planted only in the project, cannot detect. The
  question tells the model not to count the environment details Claude Code itself adds: Claude Code 2.1.325 always
  injects a reminder with the signed-in account's email, which the model otherwise reports (the first live run failed
  on exactly that). Negative control on 2026-11-18: the same flags and question in a folder holding a `CLAUDE.md`
  answered with that file and its rule, not `NONE`; the real check then passed all five lines.
- Note from the experiments: rules such as `Glob(./**)` are ignored (Claude Code warns that only `Read(path)` rules govern
  file tools), which is why the allow list holds `Read(./**)` alone.

Limits, stated plainly: Claude Code still adds its own system context (date, platform, the signed-in account's email);
the instruction-source question relies on the model reporting honestly what it was given, so it is a strong signal, not a
proof. Run `--check-blind` on your machine, after any Claude Code update, and after adding global instruction files.
Codex is not offered: `codex exec --ignore-user-config -c project_doc_max_bytes=0` still loaded the global
`~/.codex/AGENTS.md` in our test. `--agent-cmd` runs any other agent with a printed warning that blindness is your
responsibility.

## Options

| Option | Meaning |
|---|---|
| `<url>` | the page to audit (one-shot mode); http(s) only |
| `--project DIR` | the code behind the page (required) |
| `--out DIR` | where audit.md, audit.json, the evidence and AUDIT_PAGE.md go (default `./bugframe-audit/<time>`; in watch mode, optional per-report evidence folders) |
| `--viewports LIST` | `WIDTHxHEIGHT,…`, 1–8 entries (default `390x844,768x1024,1280x800,1440x900`) |
| `--agent claude\|none` | auditor; default `claude` when installed, otherwise `none` with a notice |
| `--agent-cmd "CMD"` | any other auditor: prompt + task on stdin, cwd = workspace, report on stdout |
| `--model ID` | passed to Claude Code |
| `--no-click` | skip the click probe |
| `--timeout MS` | auditor time limit, 10 s–2 h (default 15 min) |
| `--keep` | keep the blind workspace and print where it is |
| `--base-url URL` | replace the page's origin with a local server (one-shot and watch mode) |
| `--allow-remote` | audit a non-local page anyway, with a warning (never production) |
| `--watch` / `--dir` / `--once` | queue mode, see above |
| `--check-blind` | run the canary and confinement checks (defaults to `--model haiku`) |

## Storage adapters

`createFileStorage` and `createMemoryStorage` implement `writeAttachment(id, name, data)`: only the exact names
`audit.md` and `audit.json`, at most 2 MB, only for an existing report, written atomically with `0600` permissions. A
custom adapter without the method keeps working: the watcher saves the summary in the note (`audit.noteOnly: true`) and
`GET /reports/:id/audit.md` answers 404; Bugframe never asks such an adapter's `readFile` for the new names.
