// Deterministic local MCP server for governance tests. Reads are pure functions of
// their input; every write is appended to PROBE_LOG so tests can prove what ran.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const LOG = process.env.PROBE_LOG ?? 'probe-writes.log';
const OWNERS = ['ana', 'ben', 'chen', 'dara', 'eli'];
const STATUSES = ['open', 'in_review', 'blocked', 'done'];
const FILLER = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(18);

const item = (id) => ({
  id,
  name: `item-${id}`,
  owner: OWNERS[id % OWNERS.length],
  status: STATUSES[(id * 7) % STATUSES.length],
  points: (id * 13) % 21,
  tags: [`team-${id % 3}`, `prio-${id % 4}`],
});

const TOOLS = [
  {
    name: 'list_items',
    description: 'List work items with id, name, owner, status, points and tags. Large mode adds long notes to each item.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 500, description: 'Number of items to return' },
        large: { type: 'boolean', description: 'Include long notes on every item' },
      },
      required: ['count'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_item',
    description: 'Get one work item with its full change history.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Item id' } },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_item',
    description: 'Update the value of a work item. Destructive: overwrites the stored value.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' }, value: { type: 'string' } },
      required: ['id', 'value'],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: 'echo_text',
    description: 'Return the given text verbatim. Test helper.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
];

const server = new Server({ name: 'probe', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
  if (name === 'list_items') {
    const n = Math.min(Math.max(Number(args.count) || 1, 1), 500);
    return text(Array.from({ length: n }, (_, i) => ({ ...item(i + 1), ...(args.large ? { notes: FILLER } : {}) })));
  }
  if (name === 'get_item') {
    const id = Number(args.id);
    const history = Array.from({ length: 12 }, (_, k) => ({ at: `2026-10-${String(k + 1).padStart(2, '0')}`, by: OWNERS[(id + k) % 5], note: FILLER.slice(0, 200) }));
    return text({ ...item(id), history });
  }
  if (name === 'write_item') {
    appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...args })}\n`);
    return text({ ok: true, id: args.id });
  }
  if (name === 'echo_text') return { content: [{ type: 'text', text: String(args.text ?? '') }] };
  return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
});
await server.connect(new StdioServerTransport());
