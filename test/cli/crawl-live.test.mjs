import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crawlSite } from '../../src/cli/crawl/index.mjs';
import { summarize } from '../../src/cli/crawl/summary.mjs';
import { startCrawlSite } from '../e2e/fixtures/crawl-site/server.mjs';
import { cleanup, tmpDir } from '../helpers.mjs';

// Live check of `bugframe crawl --summarize` with the real Claude Code CLI (uses the signed-in account; about 6k input
// tokens with haiku). Run with: BUGFRAME_LIVE_AGENT=1 node --test test/cli/crawl-live.test.mjs  [BUGFRAME_LIVE_MODEL=sonnet]
test('a real crawl of the fixture site, summarised by a small model, gives a valid fix plan citing only real findings', { skip: process.env.BUGFRAME_LIVE_AGENT !== '1' && 'set BUGFRAME_LIVE_AGENT=1 to run against the real claude CLI', timeout: 900_000 }, async () => {
  const site = await startCrawlSite(), out = await tmpDir();
  try {
    const crawl = await crawlSite({ startUrl: `${site.base}/`, out, log: () => {} });
    const res = await summarize({ crawl, out, model: process.env.BUGFRAME_LIVE_MODEL || 'haiku', log: m => console.log(m) });
    const md = await readFile(join(out, 'SUMMARY.md'), 'utf8');
    console.log(`summary: ${res.model}, ~${res.estTokens} input tokens of data, ${res.seconds} s, degraded=${res.degraded}\n${md}`);
    assert.equal(res.degraded, false, res.errors.join('\n'));
  } finally { await site.close(); await cleanup(out); }
});
