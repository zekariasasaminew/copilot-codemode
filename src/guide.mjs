// Steers the model toward run_code when a request turns into a fan-out of MCP calls.
// Hooks need an eagerly started extension, so this lives apart from the lazily started
// code-mode extension. It only adds context; it never blocks or rewrites a call.
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let sdk;
try {
  sdk = await import('@microsoft/copilot-sdk/extension');
} catch {
  sdk = await import('@github/copilot-sdk/extension');
}

const DATA = process.env.CODEMODE_DATA_DIR || path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'codemode');
mkdirSync(DATA, { recursive: true });
const note = (event) => appendFileSync(path.join(DATA, 'guide.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), session: session?.sessionId, ...event })}\n`);

const SAME_TOOL = Number(process.env.CODEMODE_NUDGE_SAME) || 3;
const ANY_TOOL = Number(process.env.CODEMODE_NUDGE_ANY) || 4;
const OFF = process.env.CODEMODE_GUIDE === 'off';

const INTRO =
  'Code mode is available. When answering needs several MCP tool calls (one call per item, pagination, or counting, grouping or ranking across results), ' +
  'call search_functions, then do all of it in one run_code script: fetch with Promise.all, aggregate in code, and return only the answer. ' +
  'This is cheaper, faster and more accurate than calling tools one by one or looping in a shell. For a single lookup, call the tool directly.';

let session;
let mcpNames = null;
let introduced = false;
let inRunCode = 0;
const turns = new Map();

async function isMcp(name) {
  if (!mcpNames || !mcpNames.has(name)) {
    try {
      const tools = (await session.rpc.tools.getCurrentMetadata())?.tools ?? [];
      mcpNames = new Map(tools.map((t) => [t.name, t.mcpServerName ? `${t.mcpServerName}.${t.mcpToolName ?? t.name}` : null]));
    } catch {
      mcpNames = new Map();
    }
  }
  return mcpNames.get(name) ?? null;
}

const turnOf = (input) => {
  const key = input.agentId ?? 'root';
  if (!turns.has(key)) turns.set(key, { counts: new Map(), total: 0, nudged: false });
  return turns.get(key);
};

const hooks = {
  onUserPromptSubmitted: async (input) => {
    turns.delete(input.agentId ?? 'root');
    if (OFF || introduced) return;
    introduced = true;
    note({ event: 'intro' });
    return { additionalContext: INTRO };
  },
  onPreToolUse: async (input) => {
    if (input.toolName === 'run_code') {
      inRunCode++;
      return;
    }
    if (OFF || inRunCode > 0) return;
    const fn = await isMcp(input.toolName);
    if (!fn) return;
    const turn = turnOf(input);
    const n = (turn.counts.get(fn) ?? 0) + 1;
    turn.counts.set(fn, n);
    turn.total++;
    if (turn.nudged || (n < SAME_TOOL && turn.total < ANY_TOOL)) return;
    turn.nudged = true;
    const what = n >= SAME_TOOL ? `${n} calls to ${fn}` : `${turn.total} MCP calls`;
    note({ event: 'nudge', what });
    return {
      additionalContext:
        `This is turning into a fan-out (${what} so far). Do the remaining calls in one run_code script instead: ` +
        `call search_functions for the exact signature, fetch the rest with Promise.all, aggregate in code, and return only the answer.`,
    };
  },
  onPostToolUse: async (input) => {
    if (input.toolName === 'run_code' && inRunCode > 0) inRunCode--;
  },
  onPostToolUseFailure: async (input) => {
    if (input.toolName === 'run_code' && inRunCode > 0) inRunCode--;
  },
};

session = await sdk.joinSession({ hooks });
