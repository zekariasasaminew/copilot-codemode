// Launches the GitHub MCP server (read-only) with a token taken from gh at start-up, so
// no credential is written into an MCP config file. Set GITHUB_MCP_SERVER to the binary
// path, or put github-mcp-server on PATH.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const bin = process.env.GITHUB_MCP_SERVER || 'github-mcp-server';
// Benchmarks strip gh from PATH so the agent cannot bypass MCP; resolve it absolutely here.
const ghExe = [process.env.GH_BIN, 'C:\\Program Files\\GitHub CLI\\gh.exe', '/usr/bin/gh', '/opt/homebrew/bin/gh', 'gh'].find((p) => p && (p === 'gh' || existsSync(p)));
const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || execFileSync(ghExe, ['auth', 'token'], { encoding: 'utf8' }).trim();
const child = spawn(bin, ['stdio', '--toolsets=default', '--read-only'], {
  stdio: 'inherit',
  env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: token },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
