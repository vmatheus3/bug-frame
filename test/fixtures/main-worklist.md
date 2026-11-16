# Bug work list (2 open across 2 pages)

Generated 2026-02-01 00:00 by `bugframe export`. Each item is one person's own words with a picture of the area they marked (open the region picture first), the exact link and the state of the screen. Triage suggestions before implementing them; submission is not scope approval. Fix accepted work at its root cause, prove it with a before/after picture, then close it with `bugframe close <id> --note "what changed, in plain words"`.

## /invoices

### bug-20260101-000002-aaaa

> Save button broken, attempt 2. Lots of words from the reporter. Lots of words from the reporter. Lots of words from the reporter. Lots of words from the reporter.

- Feedback: bug; status: open
- Link: https://app.test/invoices
- Viewport: 1280x720 at 2x, scrolled to y=40
- Region picture: `bug-20260101-000002-aaaa/region.png`  (whole screen: `bug-20260101-000002-aaaa/full.png`)
- Marked area (viewport px): {"x":1,"y":2,"w":3,"h":4}
- Under the box: save `div#a > button.b` "Save"
- Browser: UA

## /settings

### bug-20260101-000001-aaaa

> Save button broken, attempt 1. Lots of words from the reporter. Lots of words from the reporter. Lots of words from the reporter. Lots of words from the reporter.

- Feedback: bug; status: open
- Link: https://app.test/settings
- Viewport: 1280x720 at 2x, scrolled to y=40
- Region picture: `bug-20260101-000001-aaaa/region.png`  (whole screen: `bug-20260101-000001-aaaa/full.png`)
- Marked area (viewport px): {"x":1,"y":2,"w":3,"h":4}
- Under the box: save `div#a > button.b` "Save"
- Console: TypeError: boom is not a function
    at save (https://app.test/assets/app.js:10:5)
    at node_modules/react-dom/x.js:5:1
    at onClick (https://app.test/assets/app.js:99:2)
    at node:internal/foo:1:1
- Browser: UA
