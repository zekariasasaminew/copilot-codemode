// Summarizes benchmark runs: per task and arm, pass rate and medians of cost, tokens,
// model calls, final context and wall-clock; plus code mode's change vs classic.
// Runs whose shell reached the network are flagged: they routed around MCP, so the
// MCP-only comparison excludes them.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const NET = /https?:\/\/|curl|wget|Invoke-(WebRequest|RestMethod)|urllib|requests\.|fetch\(|https?\.get|gh api/i;
const NET_FAILED = /denied|Failed to connect|Could not connect|could not resolve|blocked|Unable to connect|ConnectionRefused|getaddrinfo|ECONNREFUSED|WinError 10013|URLError/i;

function shellNetwork(file) {
  if (!existsSync(file)) return null;
  const cmds = new Map();
  let hits = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.includes('tool.execution_')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'tool.execution_start' && /powershell|bash|shell/i.test(e.data?.toolName ?? '')) {
      const cmd = String(e.data.arguments?.command ?? '');
      if (NET.test(cmd)) cmds.set(e.data.toolCallId, cmd);
    } else if (e.type === 'tool.execution_complete' && cmds.has(e.data?.toolCallId)) {
      const out = String(e.data.result?.content ?? e.data.error?.message ?? '');
      if (e.data.success && !NET_FAILED.test(out)) hits++;
    }
  }
  return hits;
}

const rows = readFileSync(path.join(dir, 'runs.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((r) => !r.invalid)
  .map((r) => ({ ...r, shellNetwork: shellNetwork(path.join(dir, `${r.task}-${r.arm}-r${r.rep}.jsonl`)) }));
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

function summarize(rs) {
  return {
    runs: rs.length,
    pass: `${rs.filter((r) => r.pass).length}/${rs.length}`,
    credits: round(median(rs.map((r) => r.credits))),
    outputTokens: median(rs.map((r) => r.tokens?.output)),
    cacheWrite: median(rs.map((r) => r.tokens?.cacheWrite)),
    modelCalls: median(rs.map((r) => r.modelCalls)),
    finalContext: median(rs.map((r) => r.lastCallInput)),
    wallSec: round(median(rs.map((r) => r.wallMs / 1000)), 1),
    usedRunCode: rs.filter((r) => r.runCode > 0).length,
    shellNet: rs.filter((r) => r.shellNetwork > 0).length,
    totalCredits: round(sum(rs.map((r) => r.credits))),
  };
}

const tasks = [...new Set(rows.map((r) => r.task))];
const out = [];
for (const task of tasks) {
  const t = { task };
  for (const arm of ['classic', 'codemode']) {
    const rs = rows.filter((r) => r.task === task && r.arm === arm);
    if (rs.length) t[arm] = summarize(rs);
  }
  const delta = (k) => (t.classic?.[k] && t.codemode?.[k] != null ? round(((t.codemode[k] - t.classic[k]) / t.classic[k]) * 100, 1) : null);
  t.change = { credits: delta('credits'), wallSec: delta('wallSec'), outputTokens: delta('outputTokens') };
  out.push(t);
}
const totals = Object.fromEntries(
  ['classic', 'codemode'].map((arm) => {
    const rs = rows.filter((r) => r.arm === arm);
    return [arm, { credits: round(sum(rs.map((r) => r.credits))), pass: `${rs.filter((r) => r.pass).length}/${rs.length}`, shellNet: rs.filter((r) => r.shellNetwork > 0).length }];
  }),
);
writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ tasks: out, totals, rows: rows.map(({ task, arm, rep, pass, credits, shellNetwork, runCode }) => ({ task, arm, rep, pass, credits, shellNetwork, runCode })) }, null, 2));
for (const t of out) {
  console.log(`\n## ${t.task}  change: ${JSON.stringify(t.change)}`);
  console.table(Object.fromEntries(['classic', 'codemode'].filter((a) => t[a]).map((a) => [a, t[a]])));
}
console.log('\ntotals', JSON.stringify(totals));
