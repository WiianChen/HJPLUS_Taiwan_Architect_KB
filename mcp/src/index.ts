import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Archive, Decision } from './archive';

const archive = new Archive();
const server = new Server({ name: 'taiwan-architect-kb', version: '1.1.0' }, { capabilities: { tools: {} } });
const decisionProperties = {
  fileName: { type: 'string', description: 'Direct pending item or intact attachment folder.' },
  category: { type: 'string', description: 'Existing relative category/subcategory under raw.' },
  expectedFingerprint: { type: 'string', description: 'Fingerprint from listing before reading content.' },
  reason: { type: 'string', description: 'Classification or hold reason.' },
  evidence: { type: 'string', description: 'Inspected content and page/slide references; never filenames alone.' },
  action: { type: 'string', enum: ['move', 'hold'] }
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'list_pending_sop_files', description: 'Read-only listing with actual root, fingerprints and eligibility; never creates pending.', inputSchema: { type: 'object', properties: {} } },
  { name: 'organize_sop_file', description: 'Verified no-overwrite move. Original fileName/category retained; fingerprint, reason and evidence needed to execute.', inputSchema: { type: 'object', properties: { ...decisionProperties, dryRun: { type: 'boolean' } }, required: ['fileName', 'category'] } },
  { name: 'organize_sop_batch', description: 'Preview or execute decisions with one run lock, journal and recovery checks.', inputSchema: { type: 'object', properties: { decisions: { type: 'array', items: { type: 'object', properties: decisionProperties, required: ['fileName', 'reason'] } }, dryRun: { type: 'boolean' } }, required: ['decisions'] } }
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const args = request.params.arguments || {};
    let result;
    if (request.params.name === 'list_pending_sop_files') result = archive.list();
    else if (request.params.name === 'organize_sop_file') result = archive.batch([args as Decision], args.dryRun === true);
    else if (request.params.name === 'organize_sop_batch') result = archive.batch(args.decisions as Decision[], args.dryRun === true);
    else throw new Error('Unknown tool');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], isError: 'results' in result && result.results.some(r => r.status === 'error') };
  } catch (e: any) { return { content: [{ type: 'text' as const, text: e.message }], isError: true }; }
});
server.onerror = e => console.error('[MCP Error]', e);
server.connect(new StdioServerTransport()).catch(e => { console.error(e); process.exitCode = 1; });
