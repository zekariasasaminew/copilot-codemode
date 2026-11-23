// Benchmark: Copilot as it is today vs Copilot with the code-mode extension, on graded
// GitHub tasks over historical windows (stable answers). Both arms get identical
// prompts, tools, MCP servers and permissions; the only difference is the extension.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOMES, WORK as work } from '../harness/homes.mjs';
import { readLedger, runCopilot } from '../harness/runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(readFileSync(path.join(here, 'truth.json'), 'utf8'));
const MODEL = process.env.BENCH_MODEL ?? 'claude-sonnet-5.5';
const REPS = Number(process.env.BENCH_REPS ?? 3);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 2);
const TAG = process.env.BENCH_TAG ?? `${MODEL}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
const pick = (v) => (v ? new Set(v.split(',')) : null);
const TASKS_ONLY = pick(process.env.BENCH_TASKS);
const ARMS_ONLY = pick(process.env.BENCH_ARMS);
const benchData = path.join(work, 'bench-data');
const outDir = path.join(work, 'bench', TAG);
mkdirSync(outDir, { recursive: true });

// Simulate an MCP-only system: no gh CLI on PATH and no direct GitHub URLs from the
// shell or web fetch. The shell itself stays, as it does for every Copilot user.
const PATH_NO_GH = process.env.PATH.split(path.delimiter)
  .filter((p) => p && !existsSync(path.join(p, 'gh.exe')) && !existsSync(path.join(p, 'gh')))
  .join(path.delimiter);
const FLAGS = [
  '--allow-all-tools',
  '--deny-url', 'github.com',
  '--deny-url', 'api.github.com',
  '--deny-url', 'raw.githubusercontent.com',
  '--deny-url', 'codeload.github.com',
  '--max-ai-credits', process.env.BENCH_MAX_CREDITS ?? '250',
  ...(process.env.BENCH_EXTRA_FLAGS ? process.env.BENCH_EXTRA_FLAGS.split(' ').filter(Boolean) : []),
];
const SANDBOXED = process.env.BENCH_SANDBOX === '1';
const ARMS = {
  classic: { home: path.join(HOMES, SANDBOXED ? 'classic-sbx' : 'classic'), env: {} },
  codemode: { home: path.join(HOMES, SANDBOXED ? 'codemode-sbx' : 'codemode'), env: { CODEMODE_DATA_DIR: benchData } },
};

const answerOf = (text) => {
  const all = [...String(text).matchAll(/ANSWER:\s*(\{[\s\S]*?\})\s*(?:`{3})?\s*$/gm)];
  if (!all.length) return null;
  try {
    return JSON.parse(all[all.length - 1][1]);
  } catch {
    return null;
  }
};
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const topOk = (got, ranking, keyName, countName) => {
  if (!Array.isArray(got) || got.length !== 3) return false;
  const counts = Object.fromEntries(ranking);
  const third = ranking[2][1];
  return got.every((g) => counts[g[keyName]] === g[countName] && g[countName] >= third) && new Set(got.map((g) => g[keyName])).size === 3;
};

const TASKS = {
  single: {
    prompt:
      'In the GitHub repository cloudflare/agents, who authored pull request #2740, on what date (UTC) was it merged, and how many files did it change?\n\n' +
      'End your reply with one line: ANSWER: {"author": string, "merged_at": "YYYY-MM-DD", "changed_files": number}',
    grade: (a) => {
      const t = truth.single;
      const checks = [a?.author?.toLowerCase() === t.author.toLowerCase(), a?.merged_at === t.merged_at, a?.changed_files === t.changed_files];
      return { pass: checks.every(Boolean), score: checks.filter(Boolean).length / checks.length };
    },
  },
  reviews: {
    prompt:
      `Consider the pull requests returned by this GitHub search: \`${truth.reviews.query}\`. ` +
      'Which of them received at least one APPROVED review, and how many reviews (in any state) were submitted across all of them in total?\n\n' +
      'End your reply with one line: ANSWER: {"approved": [PR numbers], "total_reviews": number}',
    grade: (a) => {
      const checks = [Array.isArray(a?.approved) && sameSet(a.approved.map(Number), truth.reviews.approved), a?.total_reviews === truth.reviews.totalReviews];
      return { pass: checks.every(Boolean), score: checks.filter(Boolean).length / checks.length };
    },
  },
  areas: {
    prompt:
      `Consider the pull requests returned by this GitHub search: \`${truth.areas.query}\`. ` +
      'Group the files each PR changed by area: the first two segments of the file path when it has three or more segments, otherwise its first segment ' +
      '(packages/agents/src/x.ts -> packages/agents; .changeset/brave-cats.md -> .changeset; pnpm-lock.yaml -> pnpm-lock.yaml). ' +
      'Which 3 areas were changed by the most PRs? Count each PR at most once per area.\n\n' +
      'End your reply with one line: ANSWER: {"top": [{"area": string, "prs": number}]} (3 entries, most PRs first)',
    grade: (a) => {
      const ok = topOk(a?.top, truth.areas.ranking, 'area', 'prs');
      return { pass: ok, score: ok ? 1 : 0 };
    },
  },
  authors: {
    prompt:
      `How many pull requests were merged in cloudflare/agents during October 2026 (GitHub search: \`${truth.authors.query}\`), ` +
      'and which 3 authors merged the most of them?\n\n' +
      'End your reply with one line: ANSWER: {"merged": number, "top_authors": [{"login": string, "prs": number}]} (3 entries, most first)',
    grade: (a) => {
      const checks = [a?.merged === truth.authors.merged, topOk(a?.top_authors, truth.authors.ranking, 'login', 'prs')];
      return { pass: checks.every(Boolean), score: checks.filter(Boolean).length / checks.length };
    },
  },
};

// A run that never got a fair chance (network outage, policy server unreachable, MCP
// servers blocked) is infrastructure noise, not a result: retry it, never score it.
function infraError(run) {
  for (const e of run.events) {
    if (e.type === 'session.warning' && /blocked by policy|registry policy/i.test(e.data?.message ?? '')) return `mcp blocked: ${e.data.message}`;
    if (e.type === 'session.error' && /failed to get response|dns error|connect|ECONN|ETIMEDOUT|socket|rate limit|429|quota/i.test(e.data?.message ?? '')) return `model api: ${String(e.data.message).slice(0, 160)}`;
  }
  if (!run.tokens) return `no model call (exit ${run.code})`;
  return null;
}

// Shell commands that reached the network and got data: the agent routed around MCP.
const NET = /https?:\/\/|curl|wget|Invoke-(WebRequest|RestMethod)|urllib|requests\.|fetch\(|https?\.get|gh api/i;
const NET_FAILED = /denied|Failed to connect|Could not connect|could not resolve|blocked|Unable to connect|ConnectionRefused|getaddrinfo|ECONNREFUSED|WinError 10013|URLError/i;
function shellNetwork(run) {
  const cmds = new Map();
  let hits = 0;
  for (const e of run.events) {
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

async function runOne({ task, arm, rep }) {
  const a = ARMS[arm];
  const outPrefix = path.join(outDir, `${task}-${arm}-r${rep}`);
  let run;
  let infra;
  let attempts = 0;
  for (; attempts < 3; ) {
    attempts++;
    run = await runCopilot({
      home: a.home,
      cwd: work,
      prompt: TASKS[task].prompt,
      model: MODEL,
      flags: FLAGS,
      env: { PATH: PATH_NO_GH, ...a.env },
      outPrefix,
      timeoutMs: 20 * 60_000,
    });
    infra = infraError(run);
    if (!infra) break;
    console.log(`  infra failure on ${task} ${arm} r${rep} attempt ${attempts}: ${infra}${attempts < 3 ? '; retrying in 60 s' : ''}`);
    if (attempts < 3) await new Promise((r) => setTimeout(r, 60_000));
  }
  const sessionId = run.events.find((e) => e.type === 'result')?.sessionId;
  const ledger = arm === 'codemode' ? readLedger(benchData).filter((l) => l.session === sessionId) : [];
  const answer = answerOf(run.answer);
  const grade = answer ? TASKS[task].grade(answer) : { pass: false, score: 0 };
  const byName = {};
  for (const c of run.toolCalls) byName[c.name] = (byName[c.name] ?? 0) + 1;
  const spillsSeen = run.events.filter((e) => e.type === 'tool.execution_complete' && /^Output too large to read at once/.test(String(e.data?.result?.content ?? ''))).length;
  const row = {
    task,
    arm,
    rep,
    model: MODEL,
    models: run.models,
    version: run.events.find((e) => e.type === 'session.start')?.data?.copilotVersion,
    sessionId,
    exit: run.code,
    attempts,
    ...(infra ? { invalid: infra } : {}),
    pass: grade.pass,
    score: grade.score,
    answer,
    credits: run.nanoAiu != null ? run.nanoAiu / 1e9 : null,
    tokens: run.tokens,
    modelCalls: run.modelCalls,
    lastCallInput: run.lastCallInput,
    wallMs: run.ms,
    apiMs: run.apiMs,
    toolCalls: byName,
    shellNetwork: shellNetwork(run),
    spillsSeenByModel: spillsSeen,
    runCode: ledger.length,
    innerCalls: ledger.reduce((n, l) => n + l.calls, 0),
    innerSpills: ledger.reduce((n, l) => n + l.trace.filter((t) => t.spilled).length, 0),
    keptChars: ledger.reduce((n, l) => n + l.keptChars, 0),
    returnedChars: ledger.reduce((n, l) => n + l.returnedChars, 0),
  };
  appendFileSync(path.join(outDir, 'runs.jsonl'), `${JSON.stringify(row)}\n`);
  console.log(
    `${row.invalid ? 'INVALID' : row.pass ? 'PASS' : 'FAIL'} ${task.padEnd(7)} ${arm.padEnd(8)} r${rep} credits=${row.credits?.toFixed(2)} in=${run.tokens?.input} out=${run.tokens?.output} calls=${row.modelCalls} ctx=${row.lastCallInput} ${Math.round(row.wallMs / 1000)}s tools=${JSON.stringify(byName)} inner=${row.innerCalls}`,
  );
  return row;
}

async function warmup() {
  // Learn output shapes (keys and types only) on an unrelated window: the steady state
  // after a tool has been used once. No task data or answers are involved.
  const run = await runCopilot({
    home: ARMS.codemode.home,
    cwd: work,
    model: 'claude-haiku-5.5',
    flags: FLAGS,
    env: { PATH: PATH_NO_GH, ...ARMS.codemode.env },
    outPrefix: path.join(outDir, 'warmup'),
    prompt:
      "Use the run_code tool (call search_functions first for signatures). In one script: search GitHub pull requests with the query 'repo:cloudflare/agents is:pr is:merged merged:2026-09-01..2026-09-03', " +
      'then for the first result call pull_request_read with method get, then get_files, then get_reviews, and also list_pull_requests for cloudflare/agents with state closed and perPage 2. Return only the first PR number.',
  });
  const shapes = existsSync(path.join(benchData, 'shapes.json')) ? Object.keys(JSON.parse(readFileSync(path.join(benchData, 'shapes.json'), 'utf8'))) : [];
  console.log(`warmup exit=${run.code} ${Math.round(run.ms / 1000)}s shapes=${JSON.stringify(shapes)} answer=${JSON.stringify(run.answer).slice(0, 200)}`);
}

if (process.argv[2] === 'warmup') {
  await warmup();
} else {
  const jobs = [];
  const REP_START = Number(process.env.BENCH_REP_START ?? 1);
  if (process.env.BENCH_JOBS) {
    for (const spec of process.env.BENCH_JOBS.split(',')) {
      const [task, arm, rep] = spec.split(':');
      jobs.push({ task, arm, rep: Number(rep) });
    }
  }
  for (let rep = REP_START; !process.env.BENCH_JOBS && rep <= REPS; rep++) {
    for (const task of Object.keys(TASKS).filter((t) => !TASKS_ONLY || TASKS_ONLY.has(t))) {
      const arms = Object.keys(ARMS).filter((x) => !ARMS_ONLY || ARMS_ONLY.has(x));
      for (const arm of rep % 2 ? arms : [...arms].reverse()) jobs.push({ task, arm, rep });
    }
  }
  console.log(`${jobs.length} runs, model ${MODEL}, concurrency ${CONCURRENCY}, sandboxed ${SANDBOXED}, out ${outDir}`);
  writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({ MODEL, REPS, CONCURRENCY, SANDBOXED, FLAGS, tasks: Object.fromEntries(Object.entries(TASKS).map(([k, v]) => [k, v.prompt])) }, null, 2));
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) await runOne(jobs[next++]);
    }),
  );
  console.log('done');
}
