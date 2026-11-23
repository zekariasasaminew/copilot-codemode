// Spawns one headless Copilot CLI run in an isolated COPILOT_HOME and collects what it did:
// JSONL events, billed usage, wall-clock, tool calls and the final answer.
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function findLoader() {
  if (process.env.COPILOT_LOADER) return process.env.COPILOT_LOADER;
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return path.join(root, '@github', 'copilot', 'npm-loader.js');
}
export const LOADER = findLoader();

export function runCopilot({ home, cwd, prompt, model, flags = [], env = {}, outPrefix, timeoutMs = 900_000 }) {
  const usageFile = `${outPrefix}.usage.json`;
  const jsonlFile = `${outPrefix}.jsonl`;
  // Never let a previous attempt's usage file stand in for this run's.
  rmSync(usageFile, { force: true });
  const args = [
    LOADER,
    '-p',
    prompt,
    '--model',
    model,
    '--disable-builtin-mcps',
    '--no-custom-instructions',
    '--no-ask-user',
    '--output-format',
    'json',
    '--usage-output-file',
    usageFile,
    ...flags,
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, COPILOT_HOME: home, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(jsonlFile, out);
      const ms = Date.now() - started;
      const events = out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const usage = existsSync(usageFile) ? JSON.parse(readFileSync(usageFile, 'utf8')) : null;
      resolve({ code, ms, events, usage, stderr: err.slice(-2000), ...summarize(events, usage) });
    });
  });
}

export function summarize(events, usage) {
  const toolCalls = events
    .filter((e) => e.type === 'tool.execution_start')
    .map((e) => ({ id: e.data.toolCallId, name: e.data.toolName, args: e.data.arguments }));
  const results = new Map(
    events.filter((e) => e.type === 'tool.execution_complete').map((e) => [e.data.toolCallId, e.data]),
  );
  for (const c of toolCalls) {
    const r = results.get(c.id);
    c.ok = r?.success;
    c.resultChars = String(r?.result?.content ?? '').length;
  }
  const messages = events.filter((e) => e.type === 'assistant.message' && e.data?.content);
  const answer = messages.length ? messages[messages.length - 1].data.content : '';
  // Auto/Fusion routes across several models: sum every model's usage.
  const metrics = usage ? Object.values(usage.modelMetrics ?? {}) : [];
  const total = (pick) => metrics.reduce((n, m) => n + (pick(m) ?? 0), 0);
  return {
    answer,
    toolCalls,
    models: usage ? Object.keys(usage.modelMetrics ?? {}) : [],
    modelCalls: metrics.length ? total((m) => m.requests?.count) : null,
    tokens: metrics.length
      ? {
          input: total((m) => m.usage.inputTokens),
          cacheRead: total((m) => m.usage.cacheReadTokens),
          cacheWrite: total((m) => m.usage.cacheWriteTokens),
          uncached: total((m) => m.tokenDetails?.input?.tokenCount),
          output: total((m) => m.usage.outputTokens),
          reasoning: total((m) => m.usage.reasoningTokens),
        }
      : null,
    nanoAiu: usage?.totalNanoAiu ?? null,
    lastCallInput: usage?.lastCallInputTokens ?? null,
    apiMs: usage?.totalApiDurationMs ?? null,
  };
}

export const readLedger = (dir) => {
  const f = path.join(dir, 'ledger.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
};
