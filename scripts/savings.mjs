// Summarizes the code-mode ledger: how much tool output stayed in the sandbox instead of
// the model's context.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dir = arg('--dir') || process.env.CODEMODE_DATA_DIR || path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'codemode');
const since = arg('--since');
const file = path.join(dir, 'ledger.jsonl');
if (!existsSync(file)) {
  console.log(`No ledger at ${file} yet. Run something with run_code first.`);
  process.exit(0);
}

const runs = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !since || r.at >= since);
const sum = (k) => runs.reduce((n, r) => n + (r[k] ?? 0), 0);
const kept = sum('keptChars');
const returned = sum('returnedChars');
const tokens = (c) => Math.round(c / 4).toLocaleString();

console.log(`runs            ${runs.length} (${runs.filter((r) => !r.ok).length} failed) in ${new Set(runs.map((r) => r.session)).size} sessions`);
console.log(`tool calls      ${sum('calls')} made inside the sandbox`);
console.log(`tool output     ${kept.toLocaleString()} chars (~${tokens(kept)} tokens)`);
console.log(`sent to model   ${returned.toLocaleString()} chars (~${tokens(returned)} tokens)`);
console.log(`sandbox kept    ~${tokens(Math.max(kept - returned, 0))} tokens of tool output out of context (upper bound)`);
console.log(`round trips     ~${Math.max(sum('calls') - runs.length, 0)} model turns avoided`);
