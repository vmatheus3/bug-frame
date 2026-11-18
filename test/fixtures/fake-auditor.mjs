// A stand-in auditor for tests: reads the task on stdin, inspects its working folder, prints a report.
import { existsSync, readdirSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const mode = process.argv[2] ?? 'good';
if (mode === 'bad') { console.log('Sure! The page looks great overall.'); process.exit(0); }
if (mode === 'crash') { console.error('agent exploded'); process.exit(3); }
if (mode === 'hang') {
  // Never finishes, and starts a grandchild, so tests can prove the whole process group is killed.
  const { spawn } = await import('node:child_process'), { writeFileSync } = await import('node:fs');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.HANG_PID_FILE, JSON.stringify([process.pid, grandchild.pid]));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const leaked = readdirSync('.').some(n => /^(agents|claude|gemini)\.md$/i.test(n)) || existsSync('.claude');
const sawTask = input.includes('Audit the page') && existsSync('_bugframe_audit/AUDIT_TASK.md') && existsSync('_bugframe_audit/probe.json');
console.log(`\`\`\`markdown
# Page audit: http://localhost:4320/settings

Verdict: ${leaked ? 'CANARY LEAK' : 'Not ready: the save button is dead.'}

## Summary

| # | Severity | Area | Viewport | Finding | Status |
|---|----------|------|----------|---------|--------|
| F1 | high | behaviour | 1280x800 | Save does nothing | verified |
| F2 | low | visual | 390x844 | Icon off by 3px | suspected |

## Findings

### High

#### F1. Save does nothing
- Severity: high
- Status: verified
- Area: behaviour
- Where: 1280x800 light · \`#save\` · \`_bugframe_audit/clicks/c1.png\`
- Evidence: ${sawTask ? 'probe P1 click caused no change' : 'TASK MISSING'}
- Root cause: \`src/app.js:1\` — no click handler
- Fix: add the handler

### Low

#### F2. Icon off by 3px
- Severity: low
- Status: suspected
- Area: visual
- Where: 390x844 light · \`svg.a\` · \`_bugframe_audit/screens/390x844-light.png\`
- Evidence: centre 3px lower
- Root cause: \`src/app.css:4\` — vertical-align baseline
- Fix: align-items: center

## Fix list

1. F1 — wire the save handler
2. F2 — center the icon row

## Not checked

- nothing
\`\`\``);
