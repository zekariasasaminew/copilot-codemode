---
name: codemode-setup
description: Install, verify, configure and troubleshoot the copilot-codemode plugin (run_code + search_functions) in GitHub Copilot CLI or the GitHub Copilot app, and report how many tokens it saved. Use when someone asks to set up code mode, check that run_code works, or measure its savings.
---

# Set up copilot-codemode

Code mode adds two tools to Copilot:

- `search_functions` returns TypeScript signatures for your MCP tools.
- `run_code` runs one TypeScript snippet in a QuickJS sandbox. The snippet calls those tools as `await server.tool(input)`, filters and aggregates the results in code, and returns only the answer.

Every inner call still goes through Copilot's permission rules, hooks and approvals.

## Requirements

- Copilot CLI 1.0.100 or newer (`copilot --version`).
- At least one MCP server configured. The gain is largest with servers that return bulk data (GitHub, Jira, databases).

## Install

### Copilot CLI

```sh
copilot plugin marketplace add zekariasasaminew/copilot-codemode
copilot plugin install copilot-codemode@copilot-codemode
copilot plugin list   # copilot-codemode should be listed and enabled
```

`copilot plugin install zekariasasaminew/copilot-codemode` also works, but Copilot is deprecating direct installs.

### GitHub Copilot app

The app runs the same Copilot runtime and reads the same `~/.copilot` folder, so a plugin installed with the CLI is available to new app sessions. Once the marketplace is added, the plugin also appears under **Customize** in the app sidebar, where you can install or turn it off. Start a new session afterwards.

### One-time consent

The first time `run_code` runs in an interactive session, Copilot asks to let the extension skip its own permission prompt. Allow it. `run_code` has no effects of its own, and each tool call it makes is still checked and prompted as usual.

Interactive sessions load extensions only in trusted folders. If the tools are missing, trust the folder or run `/env` to check that `codemode` is listed under extensions.

## Verify

Ask Copilot:

> Call search_functions with an empty query and tell me which namespaces it lists.

Then try a real fan-out question against one of your MCP servers, for example:

> Using run_code, list the last 20 closed pull requests in owner/repo and return how many each author merged.

The log at `~/.copilot/codemode/extension.log` shows a `joined` line and a `catalog` line once the extension is running.

## Use it well

- Best for questions that need 3 or more tool calls, loops over results, or bulk data of which only part is needed: "review stats for last week's PRs", "which areas changed most", "top authors this month".
- For a single small lookup the model should call the tool directly; code mode costs about the same there. The tool description already says so.
- Ask the model to aggregate in code: "count inside run_code and return only the numbers".

## Measure savings

Every run is recorded in `~/.copilot/codemode/ledger.jsonl`. Summarize it:

```sh
node "<plugin dir>/scripts/savings.mjs"
node "<plugin dir>/scripts/savings.mjs" --since 2026-11-01
```

`copilot plugin list --json` shows where the plugin is installed. The report shows how much tool output stayed in the sandbox versus what reached the model, as characters and estimated tokens (about 4 characters per token). That is an upper bound: without code mode the model would not read every byte either.

For the real billed difference, run the same prompt with the plugin enabled and disabled, adding `--usage-output-file usage.json`, and compare `totalNanoAiu` (1e9 nano AIU = 1 AI credit = $0.01).

## Configure

Environment variables read when the extension starts:

| Variable | Default | Meaning |
|---|---|---|
| `CODEMODE_DATA_DIR` | `~/.copilot/codemode` | Ledger, learned return shapes, log |
| `CODEMODE_WALL_MS` | `180000` | Wall-clock limit per run |
| `CODEMODE_MAX_CALLS` | `300` | Tool calls allowed per run |
| `CODEMODE_RETURN_CHARS` | `24000` | Result size before truncation (the full value stays in `$last`) |
| `CODEMODE_GUIDE` | on | `off` stops the guide from adding run_code hints |
| `CODEMODE_NUDGE_SAME` / `CODEMODE_NUDGE_ANY` | `3` / `4` | Direct calls to one MCP tool, or to any MCP tools, in one turn before the guide suggests run_code |

## The guide

The plugin also ships a small `codemode-guide` extension. It adds one short note about run_code to the first prompt of a session. If the model then starts calling MCP tools one by one in a turn, it adds a one-time hint to batch the rest in run_code. It only adds context: it never blocks or changes a call, and it ignores calls made from inside run_code. Hints are logged to `~/.copilot/codemode/guide.jsonl`.

## Troubleshoot

| Symptom | Fix |
|---|---|
| `did not become ready` with `copilot -p` | Unattended runs cannot grant the one-time consent. Add `--allow-all-tools`, or run one interactive session first. |
| Tools missing in `copilot --acp` | ACP does not load extensions. Use the CLI, the app, or an SDK host with `extensions: { enabled: true }`. |
| `Unknown function server.tool` | Call `search_functions` for exact names. MCP tools are `<server>.<tool>`; built-ins are `builtin.view`, `builtin.grep` and similar. |
| Result says `truncated` | Return a narrower projection, or read `$last` in the next run. |
| Turn it off | `copilot plugin disable copilot-codemode` (or `uninstall`). |
