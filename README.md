# copilot-codemode

Code mode for GitHub Copilot. Instead of calling MCP tools one turn at a time and reading every result, the model writes one TypeScript snippet. The snippet calls the tools inside a sandbox, filters and aggregates the data there, and returns only the answer.

Cloudflare ([Code Mode](https://blog.cloudflare.com/code-mode/)) and Anthropic ([code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)) showed the idea. This plugin brings it to Copilot CLI and the GitHub Copilot app, without giving up Copilot's permission rules, hooks or approvals.

## Results

On fan-out questions over the GitHub MCP server (one search, then a tool call per result; graded against ground truth, shell network blocked so data only comes through MCP), 14 model configurations were tested. Code mode answered **115/116** correctly against classic's 107/116. The heaviest task cost **66–91% less on every model**, and fan-out questions finished up to 4× faster.

| Model | reviews | areas | authors | fan-out time |
|---|---|---|---|---|
| Claude Opus 5.5 | 41.6 → 10.5 (−75%) | 77.8 → 10.1 (−87%) | 19.7 → 9.1 (−54%) | 53s → 21s |
| Claude Sonnet 5.5 | 16.3 → 4.9 (−70%) | 41.9 → 4.8 (−89%) | 9.5 → 4.2 (−56%) | 37s → 22s |
| GPT-6.1 Sol | 18.1 → 3.5 (−81%) | 39.3 → 3.5 (−91%) | 6.5 → 4.4 (−33%) | 116s → 26s |
| Gemini 4 Carbon | 19.5 → 9.8 (−50%) | 45.1 → 5.9 (−87%) | 6.7 → 4.4 (−34%) | 92s → 52s |
| Copilot Fusion | 0.4 → 0.4 (−12%) | 8.4 → 2.0 (−76%) | 2.4 → 1.6 (−33%) | 33s → 31s |

Median AI credits per run (1 credit = $0.01). Single lookups cost the same either way, because the model calls the tool directly. Every model, the method and caveats are in [docs/benchmarks.md](docs/benchmarks.md).

Real use, with the published plugin installed from this repo (Claude Opus 5.5, new questions on other repos):

| Setup | Credits | Input tokens | Time |
|---|---|---|---|
| MCP only (no CLI shortcut, like Jira or a database) | 321 → 77 (**−76%**) | 6.9M → 0.8M (**−89%**) | 817s → 196s (**−76%**) |
| `gh` CLI and network available | 63 → 67 (same) | | 233s → 174s |

When a CLI can answer in one shell command, models use it and code mode stays out of the way. The gain is for data that only MCP can reach.

## Install

```sh
copilot plugin marketplace add zekariasasaminew/copilot-codemode
copilot plugin install copilot-codemode@copilot-codemode
```

The GitHub Copilot app uses the same `~/.copilot` folder, so new app sessions pick it up. After adding the marketplace, the plugin also shows under **Customize**. The plugin ships a `codemode-setup` skill covering verification, configuration, troubleshooting and measuring savings: [skills/codemode-setup/SKILL.md](skills/codemode-setup/SKILL.md).

Requires Copilot CLI 1.0.100 or newer. Nothing to `npm install`: QuickJS is bundled into the extension.

## How it works

- **`search_functions`** turns Copilot's live tool list (MCP and allowed built-ins) into TypeScript declarations, including return shapes learned from earlier calls.
- **`run_code`** strips the TypeScript, then runs it in a fresh [QuickJS](https://github.com/justjake/quickjs-emscripten) WASM context with no network, filesystem, imports or Node APIs. Tools appear as `await github.list_pull_requests({...})` and `await builtin.view({...})`.
- Each inner call goes back through `session.rpc.tools.execute`, which is Copilot's own tool pipeline. Deny rules, `preToolUse` hooks, approval prompts and MCP credentials apply to every call exactly as if the model had made it.
- Large results that Copilot spills to temp files are read back, so the script sees the full data. The model sees only what the script returns, capped at 24K characters. `state` and `$last` carry values between runs.
- Every run is appended to `~/.copilot/codemode/ledger.jsonl`. `scripts/savings.mjs` summarizes it.
- A second, tiny extension (`codemode-guide`) helps the model pick code mode in busy setups with many tools and skills. It adds one short note about `run_code` at the start of a session, and a one-time hint when the model starts calling the same MCP tool over and over. It only adds context and never blocks a call. Set `CODEMODE_GUIDE=off` to disable it.

## Security

The sandbox holds no credentials and can reach nothing except the tools Copilot already lets the session use. `run_code` asks for the extension permission to skip its own prompt once, because it has no effects of its own: every tool call inside it is still checked, prompted and hooked individually. The e2e suite proves this, with deny rules, hook denials, out-of-workspace reads, runaway loops and spoofed spill paths among its 16 tests.

## Limits

- ACP sessions (`copilot --acp`) do not load extensions.
- Unattended `copilot -p` needs `--allow-all-tools`, because the one-time consent cannot be granted without a user.
- Tested on Windows 11. The harness is written to be cross-platform, but has not been run on macOS or Linux.

## Develop

```sh
npm install
npm run build        # bundles src/extension.mjs into extensions/codemode/extension.mjs
npm run homes        # isolated COPILOT_HOME folders under homes/
npm test             # 16 end-to-end tests against the real Copilot CLI
npm run bench        # graded benchmark, see docs/benchmarks.md
```

The tests and benchmark need a signed-in Copilot CLI, `gh`, and [github-mcp-server](https://github.com/github/github-mcp-server) on `PATH` (or `GITHUB_MCP_SERVER` set to the binary).

## License

MIT
