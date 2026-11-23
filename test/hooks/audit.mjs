// Test-only preToolUse hook: logs every tool call it sees and denies probe get_item for
// id 666, to prove hooks govern calls made from inside run_code.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const payload = JSON.parse(readFileSync(0, 'utf8'));
let args = payload.toolArgs;
if (typeof args === 'string') {
  try {
    args = JSON.parse(args);
  } catch {}
}
appendFileSync(path.join(process.env.COPILOT_HOOK_DIR, 'audit.log'), `${new Date().toISOString()}\t${payload.toolName}\t${JSON.stringify(args)}\n`);
if (/get_item/.test(payload.toolName) && args?.id === 666) {
  process.stdout.write(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: 'audit hook blocks item 666' }));
}
