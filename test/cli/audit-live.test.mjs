import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBlind } from '../../src/cli/audit/runner.mjs';

// Live check with the real Claude Code CLI (uses the signed-in account; costs a few cents with haiku).
// Run with: BUGFRAME_LIVE_AGENT=1 node --test test/cli/audit-live.test.mjs  [BUGFRAME_LIVE_MODEL=sonnet]
test('the auditor is blind (canary) and confined (outside reads refused) on this machine', { skip: process.env.BUGFRAME_LIVE_AGENT !== '1' && 'set BUGFRAME_LIVE_AGENT=1 to run against the real claude CLI', timeout: 600_000 }, async () => {
  const result = await checkBlind({ model: process.env.BUGFRAME_LIVE_MODEL || 'haiku' });
  assert.ok(result.ok, result.lines.join('\n'));
});
