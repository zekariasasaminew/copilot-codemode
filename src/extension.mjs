// Code mode for GitHub Copilot.
// The model writes one TypeScript snippet; it runs in a QuickJS (WASM) sandbox with no
// ambient authority. Every tool call the snippet makes goes back through Copilot's own
// invocation pipeline (session.rpc.tools.execute), so Copilot's permission rules, hooks,
// MCP connections and credentials apply to each inner call.
import * as nodeModule from 'node:module';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';

let sdk;
try {
  sdk = await import('@microsoft/copilot-sdk/extension');
} catch {
  sdk = await import('@github/copilot-sdk/extension');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.CODEMODE_DATA_DIR || path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'codemode');
mkdirSync(DATA, { recursive: true });
const SHAPES_FILE = path.join(DATA, 'shapes.json');
const LEDGER_FILE = path.join(DATA, 'ledger.jsonl');

const LIMITS = {
  wallMs: Number(process.env.CODEMODE_WALL_MS) || 180_000,
  callTimeoutMs: 120_000,
  maxCalls: Number(process.env.CODEMODE_MAX_CALLS) || 300,
  concurrency: 8,
  returnChars: Number(process.env.CODEMODE_RETURN_CHARS) || 24_000,
  logChars: 4_000,
  carryChars: 2_000_000,
  memoryBytes: 256 * 2 ** 20,
};
const SELF = new Set(['run_code', 'search_functions']);
const BUILTINS = new Set(['view', 'grep', 'glob', 'powershell', 'bash', 'web_fetch', 'edit', 'create']);
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await', 'implements', 'package', 'protected', 'interface', 'private', 'public']);

const log = (...parts) =>
  appendFileSync(path.join(DATA, 'extension.log'), `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const ident = (s) => {
  let id = String(s).replace(/[^A-Za-z0-9_$]/g, '_');
  if (/^[0-9]/.test(id)) id = `_${id}`;
  return RESERVED.has(id) ? `${id}_` : id;
};

// ---------------------------------------------------------------- catalog
let session;
let catalog = { fns: new Map(), at: 0 };

async function loadCatalog() {
  if (Date.now() - catalog.at < 15_000 && catalog.fns.size) return catalog.fns;
  let tools = null;
  for (let i = 0; i < 40 && !tools?.length; i++) {
    tools = (await session.rpc.tools.getCurrentMetadata())?.tools;
    if (!tools?.length) await sleep(250);
  }
  const fns = new Map();
  for (const t of tools ?? []) {
    if (SELF.has(t.name)) continue;
    let ns;
    let fn;
    if (t.mcpServerName) {
      ns = ident(t.mcpServerName);
      fn = ident(t.mcpToolName ?? t.name);
    } else if (BUILTINS.has(t.name)) {
      ns = 'builtin';
      fn = ident(t.name);
    } else continue;
    fns.set(`${ns}.${fn}`, { ns, fn, name: t.name, description: t.description ?? '', schema: t.input_schema ?? { type: 'object' }, deferred: !!t.deferLoading });
  }
  catalog = { fns, at: Date.now() };
  log('catalog', { tools: tools?.length ?? 0, exposed: fns.size, deferred: [...fns.values()].filter((f) => f.deferred).length });
  return fns;
}

// ---------------------------------------------------------------- learned output shapes
const shapes = existsSync(SHAPES_FILE) ? JSON.parse(readFileSync(SHAPES_FILE, 'utf8')) : {};
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function shapeOf(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return 'unknown[]';
    const inner = shapeOf(v[0], depth);
    return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
  }
  if (typeof v === 'object') {
    if (depth >= 2) return 'object';
    const keys = Object.keys(v);
    const parts = keys.slice(0, 24).map((k) => `${SAFE_KEY.test(k) ? k : JSON.stringify(k)}: ${shapeOf(v[k], depth + 1)}`);
    return `{ ${parts.join('; ')}${keys.length > 24 ? '; …' : ''} }`;
  }
  return typeof v;
}

function learnShape(key, value) {
  if (value === undefined || typeof value === 'string') return;
  const shape = shapeOf(value);
  if (shapes[key] === shape) return;
  shapes[key] = shape;
  writeFileSync(SHAPES_FILE, JSON.stringify(shapes, null, 1));
}

// ---------------------------------------------------------------- declarations
function tsType(schema, depth) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const union = schema.anyOf ?? schema.oneOf;
  if (union) return union.map((s) => tsType(s, depth)).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.map((t) => tsType({ ...schema, type: t }, depth)).join(' | ');
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const inner = tsType(schema.items, depth);
      return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
    }
    default: {
      const props = schema.properties ?? {};
      const keys = Object.keys(props);
      if (!keys.length) return 'Record<string, unknown>';
      const required = new Set(schema.required ?? []);
      const pad = '  '.repeat(depth);
      const lines = keys.map((k) => {
        const p = props[k] ?? {};
        const notes = [p.description && oneLine(p.description, 300), p.default !== undefined && `default ${JSON.stringify(p.default)}`].filter(Boolean).join('; ');
        const key = SAFE_KEY.test(k) ? k : JSON.stringify(k);
        return `${notes ? `${pad}/** ${notes} */\n` : ''}${pad}${key}${required.has(k) ? '' : '?'}: ${tsType(p, depth + 1)};`;
      });
      return `{\n${lines.join('\n')}\n${'  '.repeat(depth - 1)}}`;
    }
  }
}

function declaration(f) {
  const key = `${f.ns}.${f.fn}`;
  const byMethod = Object.entries(shapes).filter(([k]) => k.startsWith(`${key}#`));
  const returns = shapes[key] ?? (byMethod.length ? 'unknown' : 'unknown');
  const methodNotes = byMethod.map(([k, s]) => ` * returns when method=${k.split('#')[1]}: ${s}`).join('\n');
  const doc = `/**\n * ${oneLine(f.description, 400)}${methodNotes ? `\n${methodNotes}` : ''}${returns === 'unknown' && !byMethod.length ? '\n * Return shape not learned yet: inspect a small sample first.' : ''}\n */`;
  return `${doc}\n${key}(input: ${tsType(f.schema, 1)}): Promise<${returns}>;`;
}

const words = (s) =>
  String(s ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

async function searchFunctions({ query = '', limit = 6 } = {}) {
  const fns = [...(await loadCatalog()).values()];
  const counts = {};
  for (const f of fns) counts[f.ns] = (counts[f.ns] ?? 0) + 1;
  const header = `// Namespaces: ${Object.entries(counts).map(([ns, n]) => `${ns} (${n})`).join(', ')}`;
  const q = words(query);
  if (!q.length) return `${header}\n// Pass a query such as "list pull requests" to get signatures.`;
  const scored = fns
    .map((f) => {
      const name = new Set(words(`${f.ns} ${f.fn}`));
      const desc = new Set(words(f.description));
      const params = new Set(words(Object.keys(f.schema?.properties ?? {}).join(' ')));
      const score = q.reduce((s, w) => s + (name.has(w) ? 3 : 0) + (desc.has(w) ? 1 : 0) + (params.has(w) ? 0.5 : 0), 0);
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(Number(limit) || 6, 1), 20));
  if (!scored.length) return `${header}\n// No match for "${query}". Try other words.`;
  return `${header}\n\n${scored.map((x) => declaration(x.f)).join('\n\n')}`;
}

// ---------------------------------------------------------------- sandbox
const PRELUDE = `
const __mk = (ns) => new Proxy({}, { get: (_, fn) => (typeof fn !== 'string' || fn === 'then') ? undefined
  : async (input = {}) => JSON.parse(await __call(ns, fn, JSON.stringify(input ?? {}))) });
const __fmt = (a) => a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
globalThis.console = { log: (...a) => __log(__fmt(a)), info: (...a) => __log(__fmt(a)), warn: (...a) => __log(__fmt(a)), error: (...a) => __log(__fmt(a)) };
globalThis.callTool = async (name, input = {}) => JSON.parse(await __call('', String(name), JSON.stringify(input ?? {})));
`;

const quickjs = newQuickJSWASMModuleFromVariant(variant);
let carried = { state: '{}', last: 'null' };

function normalizeCode(raw) {
  let code = String(raw ?? '').trim();
  const fence = code.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence) code = fence[1].trim();
  // Some models emit literal "\n" sequences instead of newlines.
  if (!code.includes('\n') && code.length > 80 && code.includes('\\n')) code = code.replace(/\\n/g, '\n');
  if (/^async\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code) || /^async\s+function\b/.test(code)) code = `return await (${code})();`;
  return code;
}

function toJs(body) {
  const wrapped = `(async () => {\n${body}\n})`;
  return typeof nodeModule.stripTypeScriptTypes === 'function' ? nodeModule.stripTypeScriptTypes(wrapped) : wrapped;
}

// Copilot spills large tool output to a temp file and returns a notice instead. Read the
// file back, but only when it is one of Copilot's own spill files in the OS temp folder,
// so a hostile tool cannot fake the notice to make us read an arbitrary path.
const SPILL = /^Output too large to read at once \([^)]*\)\. Saved to: (.+?)\r?\n/;
const SPILL_NAME = /^\d+-copilot-tool-output-[0-9a-f]+\.txt$/;

function unspill(text) {
  const m = typeof text === 'string' ? text.match(SPILL) : null;
  if (!m) return { text, spilled: false };
  const file = path.resolve(m[1].trim());
  if (path.dirname(file).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !SPILL_NAME.test(path.basename(file))) {
    log('spill path rejected', file);
    return { text, spilled: false };
  }
  try {
    return { text: readFileSync(file, 'utf8'), spilled: true };
  } catch (err) {
    log('spill read failed', err.message);
    return { text, spilled: false };
  }
}

function normalizeResult(res) {
  if (typeof res === 'string') return { ok: true, ...unspill(res) };
  const raw = res?.textResultForLlm ?? (res?.contents ?? []).map((c) => c.text ?? '').join('\n');
  return { ok: res?.resultType === 'success', type: res?.resultType, error: res?.error, ...unspill(raw) };
}

async function runCode({ code }) {
  const started = Date.now();
  const fns = await loadCatalog();
  const trace = [];
  const logs = [];
  let logChars = 0;
  let active = 0;
  const waiting = [];
  const acquire = () => (active < LIMITS.concurrency ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
  const release = () => (waiting.length ? waiting.shift()() : active--);

  async function invoke(ns, fn, args) {
    const qualified = ns ? `${ns}.${fn}` : null;
    const entry = qualified ? fns.get(qualified) : [...fns.values()].find((f) => f.name === fn);
    if (!entry) {
      const same = [...fns.values()].filter((f) => f.ns === ns).map((f) => f.fn);
      throw new Error(`Unknown function ${qualified ?? fn}.${same.length ? ` ${ns} has: ${same.slice(0, 40).join(', ')}` : ` Namespaces: ${[...new Set([...fns.values()].map((f) => f.ns))].join(', ')}`}`);
    }
    if (trace.length >= LIMITS.maxCalls) throw new Error(`Call budget exhausted (${LIMITS.maxCalls} calls per run)`);
    const t = { fn: `${entry.ns}.${entry.fn}`, method: args?.method, ms: 0, chars: 0, ok: false };
    trace.push(t);
    await acquire();
    const t0 = Date.now();
    try {
      const res = await Promise.race([
        session.rpc.tools.execute({ name: entry.name, arguments: args ?? {} }),
        sleep(LIMITS.callTimeoutMs).then(() => {
          throw new Error(`timed out after ${LIMITS.callTimeoutMs} ms`);
        }),
      ]);
      const r = normalizeResult(res);
      t.chars = r.text?.length ?? 0;
      t.type = r.type ?? 'success';
      if (r.spilled) t.spilled = true;
      if (!r.ok) throw new Error(`${entry.ns}.${entry.fn} ${r.type ?? 'failed'}: ${oneLine(r.error || r.text, 1500)}`);
      t.ok = true;
      let value;
      try {
        value = JSON.parse(r.text);
      } catch {
        value = r.text;
      }
      learnShape(`${entry.ns}.${entry.fn}${typeof args?.method === 'string' ? `#${args.method}` : ''}`, value);
      return value;
    } finally {
      t.ms = Date.now() - t0;
      release();
    }
  }

  let body;
  let js;
  try {
    body = normalizeCode(code);
    js = toJs(body);
  } catch (err) {
    return fail(`Syntax error: ${err.message}`, { trace, logs, started });
  }

  const QuickJS = await quickjs;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(LIMITS.memoryBytes);
  runtime.setMaxStackSize(2 ** 20);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(started + LIMITS.wallMs));
  const vm = runtime.newContext();
  let alive = true;

  const callFn = vm.newFunction('__call', (nsH, fnH, argsH) => {
    const ns = vm.getString(nsH);
    const fn = vm.getString(fnH);
    const args = JSON.parse(vm.getString(argsH));
    const deferred = vm.newPromise();
    invoke(ns, fn, args)
      .then((value) => {
        if (!alive) return;
        const h = vm.newString(JSON.stringify(value === undefined ? null : value));
        deferred.resolve(h);
        h.dispose();
      })
      .catch((err) => {
        if (!alive) return;
        const h = vm.newError(err.message);
        deferred.reject(h);
        h.dispose();
      });
    deferred.settled.then(() => alive && runtime.executePendingJobs());
    return deferred.handle;
  });
  vm.setProp(vm.global, '__call', callFn);
  callFn.dispose();
  const logFn = vm.newFunction('__log', (h) => {
    const line = vm.getString(h);
    if (logChars < LIMITS.logChars) logs.push(line.slice(0, LIMITS.logChars - logChars));
    logChars += line.length;
  });
  vm.setProp(vm.global, '__log', logFn);
  logFn.dispose();

  let value;
  let error;
  try {
    vm.unwrapResult(vm.evalCode(PRELUDE)).dispose();
    const namespaces = [...new Set([...fns.values()].map((f) => f.ns))];
    const setup = namespaces.map((ns) => `globalThis[${JSON.stringify(ns)}] = __mk(${JSON.stringify(ns)});`).join('\n');
    vm.unwrapResult(vm.evalCode(`${setup}\nglobalThis.state = ${carried.state};\nglobalThis.$last = ${carried.last};`)).dispose();
    const program = `(async () => { const __r = await ${js}(); return JSON.stringify({ v: __r === undefined ? null : __r, s: globalThis.state ?? {} }); })()`;
    const promiseHandle = vm.unwrapResult(vm.evalCode(program, 'run_code.js'));
    const settled = vm.resolvePromise(promiseHandle);
    promiseHandle.dispose();
    runtime.executePendingJobs();
    const res = await Promise.race([settled, sleep(LIMITS.wallMs).then(() => ({ timeout: true }))]);
    if (res.timeout) error = `Wall-clock limit of ${LIMITS.wallMs / 1000} s reached`;
    else if (res.error) {
      const e = vm.dump(res.error);
      res.error.dispose();
      error = typeof e === 'object' && e ? `${e.name ?? 'Error'}: ${e.message}${e.stack ? `\n${String(e.stack).split('\n').slice(0, 4).join('\n')}` : ''}` : String(e);
    } else {
      const out = JSON.parse(vm.getString(res.value));
      res.value.dispose();
      value = out.v;
      const state = JSON.stringify(out.s ?? {});
      if (state.length <= LIMITS.carryChars) carried.state = state;
    }
  } catch (err) {
    error = err.message;
  } finally {
    alive = false;
    vm.dispose();
    runtime.dispose();
  }
  if (error) return fail(error, { trace, logs, started });

  const full = JSON.stringify(value);
  carried.last = full.length <= LIMITS.carryChars ? full : 'null';
  let result = value;
  let truncated;
  if (full.length > LIMITS.returnChars) {
    result = `${full.slice(0, LIMITS.returnChars)}…`;
    truncated = { totalChars: full.length, hint: 'Return a narrower projection; the full value is in $last for the next run.' };
  }
  const failed = trace.filter((t) => !t.ok).map((t) => `${t.fn}: ${t.type ?? 'error'}`);
  const text = JSON.stringify({ result, ...(logs.length ? { logs } : {}), calls: trace.length, ...(failed.length ? { failed } : {}), ...(truncated ? { truncated } : {}) });
  ledger({ ok: true, started, trace, returnedChars: text.length, returned: text });
  return text;
}

function fail(message, { trace, logs, started }) {
  const text = JSON.stringify({ error: message, ...(logs.length ? { logs } : {}), calls: trace.length, completed: trace.filter((t) => t.ok).map((t) => t.fn).slice(0, 20) });
  ledger({ ok: false, started, trace, returnedChars: text.length, error: message, returned: text });
  return { textResultForLlm: text, resultType: 'failure', error: message };
}

function ledger({ ok, started, trace, returnedChars, error, returned }) {
  const keptChars = trace.reduce((n, t) => n + t.chars, 0);
  appendFileSync(
    LEDGER_FILE,
    `${JSON.stringify({ at: new Date(started).toISOString(), session: session?.sessionId, ok, ms: Date.now() - started, calls: trace.length, keptChars, returnedChars, error, returned: returned?.slice(0, 4000), trace })}\n`,
  );
}

// ---------------------------------------------------------------- registration
// Declarations live in extension.json so Copilot can advertise the tools before this
// process starts; registering the same objects here keeps the two from drifting.
// run_code itself skips Copilot's prompt: it has no effects of its own, and every inner
// call it makes goes through Copilot's permission rules, prompts and hooks. Runs are
// serialized so parallel calls cannot race on `state` and `$last`.
let queue = Promise.resolve();
const serialized = (fn) => (args) => {
  const run = queue.then(() => fn(args));
  queue = run.catch(() => {});
  return run;
};

const manifest = JSON.parse(readFileSync(path.join(here, 'extension.json'), 'utf8'));
const handlers = {
  run_code: serialized(async (args) => runCode(args ?? {})),
  search_functions: async (args) => searchFunctions(args ?? {}),
};

session = await sdk.joinSession({
  tools: manifest.tools.map((t) => ({ ...t, handler: handlers[t.name] })),
});
log('joined', { node: process.version, strip: typeof nodeModule.stripTypeScriptTypes, session: session.sessionId });
