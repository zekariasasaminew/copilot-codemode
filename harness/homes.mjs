// Builds isolated COPILOT_HOME folders so runs see none of your own extensions,
// instructions or MCP servers. The classic and codemode homes differ only in the
// extension. The -sbx variants run shell commands with no outbound network, so data
// can only arrive through MCP.
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const WORK = path.join(ROOT, 'work');
export const HOMES = path.join(ROOT, 'homes');
const EXT = path.join(ROOT, 'extensions', 'codemode');

const SANDBOX = {
  enabled: true,
  userPolicy: { network: { allowOutbound: false, allowLocalNetwork: true } },
  sandboxMcpServers: false,
  sandboxExtensions: false,
  allowBypass: false,
  auth: { gh: false, git: false },
};

const servers = {
  github: { type: 'local', command: 'node', args: [path.join(here, 'gh-mcp.mjs')], tools: ['*'] },
  probe: {
    type: 'local',
    command: 'node',
    args: [path.join(here, 'probe-server.mjs')],
    env: { PROBE_LOG: path.join(WORK, 'probe-writes.log') },
    tools: ['*'],
  },
};

function makeHome(name, { extension, sandbox }) {
  const home = path.join(HOMES, name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ experimental: true, ...(sandbox ? { sandbox: SANDBOX } : {}) }, null, 2));
  writeFileSync(path.join(home, 'mcp-config.json'), JSON.stringify({ mcpServers: servers }, null, 2));
  if (extension) {
    mkdirSync(path.join(home, 'extensions'), { recursive: true });
    symlinkSync(EXT, path.join(home, 'extensions', 'codemode'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return home;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(WORK, { recursive: true });
  const homes = {
    test: { extension: true },
    classic: { extension: false },
    codemode: { extension: true },
    'classic-sbx': { extension: false, sandbox: true },
    'codemode-sbx': { extension: true, sandbox: true },
  };
  for (const [name, opts] of Object.entries(homes)) {
    const home = makeHome(name, opts);
    console.log(home, opts.extension ? existsSync(path.join(home, 'extensions', 'codemode', 'extension.mjs')) : '');
  }
}
