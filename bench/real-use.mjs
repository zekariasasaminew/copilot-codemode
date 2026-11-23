// Real-use comparison: installs the published plugin from its GitHub marketplace into a
// normal (unsandboxed) home, then runs everyday questions about public repos with the
// plugin enabled and disabled. gh and the network stay available, as they would for a
// real user, so this measures the plugin against every shortcut the agent can take.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOMES, SANDBOX, WORK } from '../harness/homes.mjs';
import { LOADER, runCopilot } from '../harness/runner.mjs';

const GH_MCP = fileURLToPath(new URL('../harness/gh-mcp.mjs', import.meta.url));
// REAL_MCP_ONLY=1 models a service with no CLI shortcut (Jira, Slack, databases): the
// shell has no network and no gh, so data can only come through MCP.
const MCP_ONLY = process.env.REAL_MCP_ONLY === '1';
const PATH_NO_GH = process.env.PATH.split(path.delimiter)
  .filter((p) => p && !existsSync(path.join(p, 'gh.exe')) && !existsSync(path.join(p, 'gh')))
  .join(path.delimiter);

const MODEL = process.env.REAL_MODEL ?? 'claude-opus-5.5';
const REPS = Number(process.env.REAL_REPS ?? 2);
const SOURCE = process.env.REAL_SOURCE ?? 'zekariasasaminew/copilot-codemode';
const outDir = path.join(WORK, 'real-use', `${MODEL}${MCP_ONLY ? '-mcp-only' : ''}`);
mkdirSync(outDir, { recursive: true });

const TASKS = {
  release: 'What is the latest release of github/github-mcp-server, and when was it published?',
  issues: 'In modelcontextprotocol/typescript-sdk, which 5 open issues have the most comments, and what is each one about in one line?',
  churn: 'Look at the last 30 merged pull requests in modelcontextprotocol/typescript-sdk. What is the median number of changed files per PR, and which top-level directories were touched by the most of those PRs?',
  reviewers: 'For pull requests in cloudflare/workers-sdk merged between 2026-11-02 and 2026-11-08, who submitted the most reviews, how many reviews were there in total, and how many of those PRs were merged without any approving review?',
};

function makeHome(name, enabled) {
  const home = path.join(HOMES, name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ experimental: true, ...(MCP_ONLY ? { sandbox: SANDBOX } : {}) }));
  writeFileSync(
    path.join(home, 'mcp-config.json'),
    JSON.stringify({ mcpServers: { github: { type: 'local', command: 'node', args: [GH_MCP], tools: ['*'] } } }),
  );
  const copilot = (...args) => execFileSync(process.execPath, [LOADER, ...args], { env: { ...process.env, COPILOT_HOME: home }, encoding: 'utf8' });
  copilot('plugin', 'marketplace', 'add', SOURCE);
  copilot('plugin', 'install', 'copilot-codemode@copilot-codemode');
  if (!enabled) copilot('plugin', 'disable', 'copilot-codemode@copilot-codemode');
  return home;
}

const suffix = MCP_ONLY ? '-mcp' : '';
const homes = { plugin: makeHome(`real-plugin${suffix}`, true), stock: makeHome(`real-stock${suffix}`, false) };
const flags = ['--allow-all-tools', '--max-ai-credits', '200'];
const jobs = [];
for (let rep = 1; rep <= REPS; rep++) for (const task of Object.keys(TASKS)) for (const arm of rep % 2 ? ['plugin', 'stock'] : ['stock', 'plugin']) jobs.push({ task, arm, rep });

let next = 0;
await Promise.all(
  Array.from({ length: Number(process.env.REAL_CONCURRENCY ?? 2) }, async () => {
    while (next < jobs.length) {
      const { task, arm, rep } = jobs[next++];
      const run = await runCopilot({ home: homes[arm], cwd: WORK, prompt: TASKS[task], model: MODEL, flags, env: MCP_ONLY ? { PATH: PATH_NO_GH } : {}, outPrefix: path.join(outDir, `${task}-${arm}-r${rep}`) });
      const tools = {};
      for (const c of run.toolCalls) tools[c.name] = (tools[c.name] ?? 0) + 1;
      const row = { task, arm, rep, model: MODEL, credits: run.nanoAiu / 1e9, tokens: run.tokens, modelCalls: run.modelCalls, wallMs: run.ms, tools, answer: run.answer.slice(-1500) };
      appendFileSync(path.join(outDir, 'runs.jsonl'), `${JSON.stringify(row)}\n`);
      console.log(`${task.padEnd(9)} ${arm.padEnd(6)} r${rep} credits=${row.credits.toFixed(2)} in=${run.tokens?.input} calls=${row.modelCalls} ${Math.round(run.ms / 1000)}s ${JSON.stringify(tools)}`);
    }
  }),
);
