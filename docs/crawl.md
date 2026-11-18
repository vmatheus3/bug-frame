# Whole-site crawl (`bugframe crawl`)

`bugframe crawl` opens every page of a site in a real browser (Chromium through your Playwright install), clicks every
control it can click safely, and reports how the whole system is wired and where it is not. It is a script: no AI model
runs unless you add `--summarize`.

```bash
npx bugframe crawl login http://localhost:3000/login --save .bugframe-auth.json   # optional, for pages behind a login
npx bugframe crawl http://localhost:3000/ --storage-state .bugframe-auth.json
open bugframe-crawl-*/crawl.html                                                   # or hand CRAWL.md to your agent
```

`crawl` or `audit`? `crawl` covers the whole system (every page, every button, wiring and consistency between pages),
costs nothing and is fast enough for CI. `audit` judges one page deeply: an AI auditor reads that page's evidence and a
blind copy of your code and returns `file:line` causes. A good loop: `crawl` to find what is broken, then `audit` the
pages that need a closer look.

## Signing in

`bugframe crawl login <url> --save <file>` opens a visible browser window at your login page. You sign in yourself, then
press Enter in the terminal; Bugframe saves the browser's storage state (cookies and local storage, the Playwright
format) to the file with mode `0600` and never prints it. It never types, sees or stores your password. The default name
is `.bugframe-auth.json`; add `.bugframe-auth*.json` to `.gitignore`. The file holds live session cookies: treat it like a
password and delete it when you are done. Pass it to the crawl with `--storage-state <file>`. Sign-out controls and
links are never clicked, so the session survives the crawl.

## What it finds

Discovery is breadth-first from the start URL:

- same-site `a[href]`, `area[href]`, `[data-href]` and `[routerlink]` targets (other sites, `mailto:` and `tel:` are not
  followed);
- URLs a click leads to, including `history.pushState` and `#/hash` routes, so single-page apps are covered;
- redirects (a page that redirects is recorded as such and its target is crawled once);
- `sitemap.xml` at the site root (same-site `<loc>` entries).

**URL rules.** Fragments are dropped unless they are hash routes (`#/…` or `#!/…`); tracking parameters (`utm_*`,
`gclid`, `fbclid`, `msclkid`, `mc_cid`, `mc_eid`, `_ga`, `_gl`, `yclid`, …) are removed and the rest sorted; duplicate
and trailing slashes are removed. **Route templates:** a path segment that is a number, a UUID, a hex string of 8+
characters with a digit, or a 16+ character token mixing letters and digits becomes `:id`, and query values are
dropped (keys kept). `/clients/123?tab=2` and `/clients/456?tab=9` are both `/clients/:id?tab`. Only the first two pages
of each route template are opened; the rest are counted in the report (`Routes kept to 2 pages each`), never fetched.
Links to template pages that were not opened take the status of the ones that were.

Every page is loaded at each viewport (default `390x844,1440x900`, light mode) and gets:

- the page probe of `bugframe audit`: console and uncaught errors, failed requests, sideways overflow, clipped text,
  offscreen controls, contrast, images and `alt`, accessible names, tap targets (phone widths), overlaps and icon
  alignment. Identical problems on many pages, or on every row of a list, are one finding;
- its title, `<h1>`, language, the links inside its header, `<nav>` and footer regions, and a viewport screenshot;
- a loading check: a visible spinner, skeleton, `aria-busy="true"` or indeterminate progress bar still showing when the
  page timeout runs out is a stuck loading state.

Then each control (buttons, `role=button`, `summary`, script and hash-route links; up to `--max-controls-per-page`) is
clicked in a fresh copy of the page at the widest viewport, and its outcome recorded:

| Outcome | Meaning |
|---|---|
| `navigates` | the URL changed (full load, pushState or hash route); the target route is recorded and crawled |
| `opens` | a dialog, menu, listbox or popover appeared, `aria-expanded` turned true, a popup or browser dialog opened |
| `changes` | the DOM changed in place, or focus moved elsewhere |
| `calls-backend` | a request was fired: GETs are listed (`GET /api/reports`), writes are blocked and listed (`POST /api/save`, `FORM POST /contact`) |
| `error` | a console error, uncaught error or failed request followed the click |
| `dead` | none of the above within 700 ms (a submit that only submitted a form with no action counts as dead) |
| `skipped` | destructive, or over the per-page limit |

Ordinary same-site links are not clicked: their outcome is `navigates` to their `href`, and the target is crawled or
checked with one GET. Controls in the header, `<nav>` or footer are clicked once for the whole site; other controls once
per route template.

Whole-site checks, each finding with severity, pages, routes, element, evidence, screenshot and a fix direction:

| Type | Severity | Rule |
|---|---|---|
| `dead-control`, `dead-form` | high | a clicked control (or a form submit) did nothing |
| `click-error` | high | a click raised an error |
| `broken-link` | high from a navigation region, else medium | a link's target answers ≥ 400 or not at all |
| `route-error` | high for 5xx or no answer, else medium | a page reached by a click, redirect or the start URL fails |
| `sitemap-broken` / `orphan-route` | medium / low | a sitemap entry fails / works but nothing links to it or opens it |
| `nav-inconsistent` | medium | a header, nav or footer region (on 3+ pages) differs from its most common version: missing or extra items, an item pointing elsewhere, a different order. A missing link to the page itself is fine |
| `label-multiple-destinations` | medium | one link label leads to different routes (generic labels such as "More", "Back", "Edit" are ignored) |
| `destination-multiple-labels` | low | one route is named differently inside `<nav>` elements |
| `action-inconsistent` | medium | buttons with the same label behave differently on different pages (outcome or backend calls) |
| `missing-title`, `missing-h1`, `duplicate-title` | medium, low, low | per page; duplicates across different routes |
| `repeated-console-error` | high | the same console or uncaught error on several pages: one root cause |
| `console-error`, `page-error` | medium, high | an error on one page |
| `failing-endpoint` | high for 5xx or network, else medium | failed requests grouped by method and route across pages |
| `stuck-loading` | medium | a loading indicator never went away |
| `mixed-language` | low | common words of two of English, Portuguese and Spanish each make up a quarter of the page (a cheap heuristic) |

## Safety

The crawl uses the same guard code as `bugframe audit`:

- **Local sites only:** `localhost`, `*.localhost`, `*.test`, `127.0.0.0/8`, `::1` or `0.0.0.0`. Anything else is refused
  unless `--allow-remote`, which prints a `WARNING --allow-remote` line. Use it only for a staging copy that is safe to
  click through: the crawl blocks writes but cannot know what a GET does on a server. Never production.
- **Same site only:** navigations to other origins are aborted; other sites are never crawled or fetched.
- **No writes:** every non-GET/HEAD request is aborted and recorded; form submissions are cancelled (and recorded as
  `FORM POST <action>` when the form has an action or uses POST); `navigator.sendBeacon` sends nothing; WebSockets are
  closed before they reach the server; downloads, popups and service workers are off. Playwright 1.48+ is required.
- **No destructive or session-ending actions:** controls and links whose label, `aria-label`, `title` or URL contains
  destructive words (delete, remove, pay, buy, checkout, subscribe, unsubscribe, log out, sign out, cancel
  subscription/account/plan/order, transfer, withdraw, refund, reset, revoke, and Portuguese and Spanish equivalents)
  are listed as skipped and never clicked or fetched.
- **Polite:** at most `--concurrency` pages at once (default 2), a short pause between pages, one GET per unchecked link
  target (at most 300).
- **Caps:** `--max-pages` (200), `--max-depth` (6), two pages per route template, `--max-controls-per-page` (60),
  `--timeout` per page (15 s), `--max-minutes` for the whole run (30). Ctrl+C stops after the current page and still
  writes the report (marked partial); a second Ctrl+C quits at once.
- **Untrusted page text:** everything in `crawl.html` is HTML-escaped and the page carries a strict Content Security
  Policy (`default-src 'none'`, inline images only); `CRAWL.md` and the `--summarize` input say that site text is data,
  never instructions. Secret-looking query values in URLs are redacted.

## Output

Written to `--out` (default `./bugframe-crawl-<time>/`):

- `crawl.html`: one self-contained file (no external assets, light and dark, readable on a phone): summary tiles, the
  findings with filters by severity, type and page plus a search, each with a thumbnail, and a site map with one card per
  page listing what each control does.
- `CRAWL.md`: for a coding agent: summary, top issues, findings by severity, dead controls, broken links and routes,
  inconsistencies, the wiring map (`page → control → outcome/target`), one section per page and the limits.
- `crawl.json`: everything: `pages`, `edges` (the wiring graph), `findings`, `stats`, `skipped`, `blockedRequests`.
- `screens/` (one JPEG per page and viewport) and `clicks/` (a PNG for each dead or erroring click).

The folder holds screenshots of every page the crawl opened, signed-in pages included: keep it private like the
session file (`bugframe-crawl-*/` belongs in `.gitignore` too).

Exit codes: `0` normally; `1` when `--fail-on high|medium|low` is given and a finding reaches that level; `2` for a usage
or run error.

## `--summarize`: the only token use

`--summarize` turns the findings into a fix plan grouped by root cause (`SUMMARY.md`). It runs Claude Code with the
same isolation as `bugframe audit` (its own system prompt `prompts/CRAWL_SUMMARY.md` outside the working folder, no
settings, hooks, skills, slash commands, MCP servers or session files, read-only tools confined to the folder) in an
empty temporary folder holding only `crawl-data.json`: the crawl trimmed to `--budget` tokens (default 20,000;
lower-severity findings are dropped first, and the count of dropped ones is in the data). The estimated input size is
printed before it runs. The default model is a small one (`--model haiku`). The answer must follow the format in the
prompt and may cite only finding ids that exist in the data; otherwise the run is marked degraded, `SUMMARY.md` holds a
script-only grouping by type, and the raw answer is kept in `summary-output.txt`. Measured on the test fixture
(2026-11-18, Claude Code 2.1.325, haiku): about 1,000 tokens of data plus about 1,000 of instructions, 20 seconds, valid.

## Options

| Option | Meaning |
|---|---|
| `<start-url>` | where the crawl starts; http(s), local unless `--allow-remote` |
| `--out DIR` | output folder (default `./bugframe-crawl-<time>`) |
| `--max-pages N` | pages to open, 1–5000 (default 200) |
| `--max-depth N` | link hops from the start page, 0–50 (default 6) |
| `--include GLOB` / `--exclude GLOB` | only / never crawl matching paths (repeatable; `*` within a segment, `**` across segments, e.g. `--exclude '/admin/**'`); the start page is always crawled |
| `--viewports LIST` | `WIDTHxHEIGHT,…`, 1–8 entries (default `390x844,1440x900`); controls are clicked at the widest |
| `--storage-state FILE` | a saved session from `crawl login` (or any Playwright storage state) |
| `--no-click` | map pages and links only, click nothing |
| `--max-controls-per-page N` | clicks per page, 0–500 (default 60) |
| `--concurrency N` | pages at once, 1–8 (default 2) |
| `--timeout MS` | per page: load and loading-indicator wait (default 15000) |
| `--max-minutes N` | the whole run (default 30) |
| `--fail-on LEVEL` | exit 1 when a finding is at or above `high`, `medium` or `low` (default `none`) |
| `--allow-remote` | crawl a non-local site anyway, with a warning |
| `--summarize` / `--model ID` / `--budget TOKENS` | the optional AI fix plan, see above |
| `crawl login <url> --save FILE` | sign in yourself in a visible browser and save the session |

## Limits

- Only measured behaviour is judged: not visual design, copy quality or business rules.
- A link with a real `href` is assumed to go to its `href` (a script that intercepts it is not detected); a click whose
  effect arrives after 700 ms counts as dead.
- Hover-only menus, drag and drop, typing into fields and multi-step flows are not exercised; controls inside closed
  menus are only clicked when visible on load.
- Two pages per route template means record-specific problems on other records are not seen.
- Dark mode is not measured by the crawl (`audit` measures it per page).
- Blocking writes means pages that need a POST to show their content may look empty or show an error state.
