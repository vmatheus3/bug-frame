# Bugframe interface screenshots

These images show the actual Bugframe 0.6.0 interface running in Chromium. They replace the earlier AI-generated mockups; no image generation or image editing is used for the current gallery. The Northstar Studio website, customer account, request, and developer notes are fictional demo content. No live accounts, credentials, invitation secrets, or customer reports appear in the images. Code, documentation, and images are available under the repository’s MIT license.

| File | What it shows |
| --- | --- |
| `images/simple-feedback.png` | The default one-message form, with an automatic screenshot and optional extra fields. |
| `images/mobile-feedback.png` | The same simple reporting flow on a phone-sized touch viewport. |
| `images/bugframe-overview.png` | Developer inbox with the customer’s content request, original screenshots, progress controls, and technical evidence. |
| `images/frame-the-problem.png` | A customer frames the homepage headline on the sample website. |
| `images/describe-and-send.png` | The four feedback kinds and a content request with current and proposed wording. |
| `images/customer-invitation.png` | Invitation acceptance through an existing verified account. The secret is removed from the browser URL and never rendered. |
| `images/customer-review.png` | English customer view: check the delivered page, approve, or request an adjustment. |
| `images/customer-review-es.png` | The same customer interface in Spanish. |
| `images/customer-review-pt.png` | The same customer interface in Portuguese. |
| `images/customer-approved.png` | Customer-approved result and progress history. |
| `images/analyze-page-menu.png` | A developer opens the Bugframe menu on a demo pricing page and sees **Analyze this page**. |
| `images/analyze-page-queued.png` | The confirmation after the analysis is queued. |
| `images/page-audit-report.png` | The private inbox with the page-analysis request and its rendered report (findings table, severity labels, copy button), from a real probe-only `bugframe audit --watch --once --agent none` run (no AI model) on the demo page with planted problems. |
| `images/crawl-report.png`, `images/crawl-sitemap.png`, `images/crawl-report-mobile.png` | `crawl.html` from a real `bugframe crawl` of the demo dashboard: findings, the site map of what each control does, and the report on a phone. |
| `images/crawl-baseline.png` | `crawl.html` of a second run with `--baseline`, on a second version of the demo dashboard with two regressions: the tiles, the *New* filter and the new findings. |
| `images/crawl-in-inbox.png` | The private inbox showing a crawl filed with `--dir`: a finished page analysis with the rendered short report. |
| `images/cli-doctor.png` | The output of `bugframe doctor` on the machine that made these pictures. |
| `images/remote-export.png` | The output of `bugframe --remote … export` against the demo server, and the top of the worklist it wrote. |
| `images/connect-agent.png` | The output of `bugframe connect agent … --once` against the demo server, and what the command received. |

## Reproduce

From the repository with Node.js 20+:

```bash
npm ci --ignore-scripts
npx playwright install chromium
npm run docs:images
```

The three terminal pictures are the real, unedited output of those commands, shown in a plain page that the script
screenshots; paths are relative because the commands run inside the disposable folder.

The capture script starts an isolated loopback demo with disposable accounts and report storage, signs in through real session flows, accepts an invitation, submits feedback through the real widget, and opens the developer inbox. It updates the fictional headline in a disposable source copy, requests customer review, changes the interface language, and records the approval. Signed in as the developer, it queues **Analyze this page** on the demo pricing page (`examples/plain-html/audit-demo.html`), runs `bugframe audit --watch --once --agent none` against the disposable reports folder, and opens the report in the inbox. It closes Chromium and removes its temporary data afterward. The repository’s demo source is not modified during capture.

The language screenshots intentionally keep the original English customer text and developer note: UI language changes do not translate or alter user-authored content. The example page is also available at `/review-demo?bugs=1` when running `npm run example`.

![Simple one-message reporting](images/simple-feedback.png)
![Mobile reporting](images/mobile-feedback.png)
![Developer inbox](images/bugframe-overview.png)
![Frame an area](images/frame-the-problem.png)
![Describe a change](images/describe-and-send.png)
![Accept an invitation](images/customer-invitation.png)
![Review the delivered change](images/customer-review.png)
![Spanish customer view](images/customer-review-es.png)
![Portuguese customer view](images/customer-review-pt.png)
![Analyze this page in the developer menu](images/analyze-page-menu.png)
![Analysis queued](images/analyze-page-queued.png)
![Page analysis report in the inbox](images/page-audit-report.png)
![Approved request](images/customer-approved.png)
![Crawl report](images/crawl-report.png)
![Crawl site map](images/crawl-sitemap.png)
![Crawl report on a phone](images/crawl-report-mobile.png)
![Crawl with a baseline](images/crawl-baseline.png)
![A crawl in the inbox](images/crawl-in-inbox.png)
![bugframe doctor](images/cli-doctor.png)
![Remote export](images/remote-export.png)
![connect agent](images/connect-agent.png)
