# Benchmarks

Two arms, identical except for the plugin:

- **classic**: stock Copilot CLI with the GitHub MCP server (read-only).
- **code mode**: the same, plus this plugin.

Each arm runs in an isolated `COPILOT_HOME` with no user extensions, instructions or MCP servers, with `--allow-all-tools` and the same prompt. The shell has no outbound network (Copilot's OS sandbox) and `gh` is off `PATH`, so data can only come through MCP. Copilot CLI 1.0.115, November 2026.

## Tasks

Questions about [cloudflare/agents](https://github.com/cloudflare/agents) over closed historical windows, so the answers are fixed. Ground truth comes from `gh api` ([ground-truth.mjs](../bench/ground-truth.mjs), [truth.json](../bench/truth.json)), and answers are graded automatically.

| Task | Question | Shape |
|---|---|---|
| single | Who authored PR #2740, when was it merged, how many files changed? | 1 call |
| reviews | Which of a week's 30 merged PRs got an approval, and how many reviews in total? | 1 search + 30 calls |
| areas | Which 3 code areas were touched by the most of those PRs? | 1 search + 30 file lists |
| authors | How many PRs merged in October, and who are the top 3 authors? | paged search |

## Results

Median AI credits per run (1 credit = $0.01), classic → code mode. Two reps per arm (three for Sonnet). Fan-out time is the median wall-clock over the three multi-call tasks.

| Model | single | reviews | areas | authors | fan-out time | pass classic | pass code mode |
|---|---|---|---|---|---|---|---|
| Claude Opus 5.5 | 13.2 → 12.9 | 41.6 → 10.5 (−75%) | 77.8 → 10.1 (−87%) | 19.7 → 9.1 (−54%) | 53s → 21s | 8/8 | 8/8 |
| Claude Sonnet 5.5 | 4.0 → 8.6 | 16.3 → 4.9 (−70%) | 41.9 → 4.8 (−89%) | 9.5 → 4.2 (−56%) | 37s → 22s | 11/12 | 12/12 |
| Claude Haiku 5.5 | 0.4 → 0.4 | 1.0 → 0.4 (−60%) | 16.4 → 4.7 (−71%) | 0.4 → 0.5 (+17%) | 38s → 29s | 7/8 | 8/8 |
| GPT-6.2 Sol | 3.9 → 3.9 | 8.9 → 5.0 (−44%) | 12.1 → 4.2 (−66%) | 6.6 → 3.4 (−48%) | 55s → 38s | 8/8 | 8/8 |
| GPT-6.1 Sol | 4.1 → 4.1 | 18.1 → 3.5 (−81%) | 39.3 → 3.5 (−91%) | 6.5 → 4.4 (−33%) | 116s → 26s | 8/8 | 8/8 |
| GPT-6.1 Terra | 2.9 → 2.0 | 8.0 → 2.8 (−65%) | 16.1 → 3.1 (−81%) | 3.6 → 2.5 (−31%) | 63s → 29s | 8/8 | 8/8 |
| MAI Code 2 | 0.9 → 1.0 | 2.8 → 0.9 (−68%) | 10.1 → 1.2 (−88%) | 2.0 → 1.7 (−14%) | 58s → 39s | 6/8 | 8/8 |
| Gemini 4 Carbon | 8.4 → 4.3 | 19.5 → 9.8 (−50%) | 45.1 → 5.9 (−87%) | 6.7 → 4.4 (−34%) | 92s → 52s | 8/8 | 8/8 |
| Gemini 4 Argon | 8.2 → 4.2 | 8.5 → 6.6 (−23%) | 27.8 → 5.5 (−80%) | 7.6 → 3.3 (−56%) | 76s → 34s | 6/8 | 8/8 |
| Gemini 4 Neon | 6.6 → 6.7 | 22.5 → 9.9 (−56%) | 50.7 → 7.3 (−86%) | 12.3 → 6.1 (−50%) | 72s → 38s | 8/8 | 8/8 |
| Gemini 4 Hydrogen | 3.3 → 5.2 | 9.8 → 4.8 (−50%) | 21.3 → 3.2 (−85%) | 6.3 → 2.8 (−55%) | 49s → 27s | 8/8 | 8/8 |
| Gemini 3.8 Flash | 1.1 → 1.6 | 10.1 → 5.7 (−44%) | 21.3 → 5.6 (−73%) | 3.4 → 3.2 (−4%) | 111s → 64s | 8/8 | 8/8 |
| Copilot Fusion (standard) | 1.4 → 1.5 | 0.4 → 0.4 (−12%) | 8.4 → 2.0 (−76%) | 2.4 → 1.6 (−33%) | 33s → 31s | 8/8 | 8/8 |
| Auto (intelligence) | 0.1 → 0.1 | 0.4 → 0.3 (−41%) | 1.0 → 0.2 (−76%) | 0.3 → 1.2 | 55s → 29s | 5/8 | 7/8 |

Overall, code mode answered **115/116** correctly and classic **107/116**. Every classic miss was a count done in the model's head. The heaviest task, `areas`, fell **66–91%** on every model.

Notes:

- Single lookups vary up to 2× between runs because of prompt-cache timing, in both arms. The model calls the tool directly there, so read those cells as "no difference".
- Sonnet, Haiku and GPT-6.2 Sol ran in an earlier round that blocked GitHub URLs by command text instead of the OS sandbox. Runs where the shell still reached the network (`curl.exe`, Python) are excluded.
- Fusion routed these tasks to GPT-6 Luna and GPT-6.1 Terra, and Auto (intelligence) mostly to GPT-6 Luna. Both are cheap enough that most tasks cost under a credit either way. One Auto code-mode `authors` run skipped `run_code` and hit a cold cache.
- Fusion Max needs GPT-6 Astra, which the test account did not have, and Auto mode rejects `--reasoning-effort`, so Auto's `intelligence` tier stands in as the high tier.

## Real use

[real-use.mjs](../bench/real-use.mjs) installs the published plugin from this repository's marketplace and asks new, ungraded questions about other repositories (github-mcp-server, modelcontextprotocol/typescript-sdk, cloudflare/workers-sdk). Claude Opus 5.5, two reps, plugin enabled vs disabled. Medians:

**MCP only** (sandboxed shell, no `gh`; like Jira, Slack or a database):

| Task | Credits | Time |
|---|---|---|
| latest release (1 call) | 7.3 → 7.3 | 18s → 16s |
| top 5 most-commented issues | 12.9 → 9.3 (−28%) | 25s → 21s |
| median files and top directories over 30 PRs | 66.2 → 11.4 (−83%) | 126s → 32s |
| review stats for a week of PRs | 74.0 → 10.2 (−86%) | 240s → 30s |
| **all 16 runs** | **321 → 77 (−76%)** | **817s → 196s (−76%)** |

Input tokens fell from 6.9M to 0.8M (−89%).

**With `gh` and the network available**, all 16 runs cost 63 → 67 credits and took 233s → 174s. Opus answered every question with one or two `gh` shell commands in both arms and never called `run_code`. When a CLI can answer in one command, code mode stays out of the way: it neither helps nor costs.

## Reproduce

```sh
npm install && npm run homes
node bench/ground-truth.mjs                      # optional: recompute truth.json
BENCH_SANDBOX=1 BENCH_MODEL=claude-opus-5.5 BENCH_TAG=opus npm run bench
node bench/analyze.mjs work/bench/opus           # per-task medians
node bench/compare.mjs bench/results/*           # the table above
REAL_MCP_ONLY=1 node bench/real-use.mjs
```

Raw rows for every run are in [bench/results](../bench/results).
