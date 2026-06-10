import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

// Resolve paths dynamically relative to this script's directory in the SOP database repository
const BASE_SOP_DIR = path.resolve(__dirname, '..', '..');
const PENDING_DIR = path.join(BASE_SOP_DIR, 'raw', '!待整理');
const RAW_DIR = path.join(BASE_SOP_DIR, 'raw');

class ArchitectKbServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'taiwan-architect-kb',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_pending_sop_files',
          description: "List all pending markdown/document files in the SOP database's '!待整理' folder.",
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'organize_sop_file',
          description: "Move a pending document from '!待整理' to its target category folder in the SOP database. Creates the category folder if it does not exist.",
          inputSchema: {
            type: 'object',
            properties: {
              fileName: {
                type: 'string',
                description: 'The name of the file to move (e.g., "BIM規範.md").',
              },
              category: {
                type: 'string',
                description: 'The target category folder name (e.g., "公共工程", "專案管理").',
              },
            },
            required: ['fileName', 'category'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (request.params.name === 'list_pending_sop_files') {
          try {
            await fs.mkdir(PENDING_DIR, { recursive: true });
            const files = await fs.readdir(PENDING_DIR);
            const docFiles = files.filter(f => !f.startsWith('.'));
            if (docFiles.length === 0) {
              return {
                content: [{ type: 'text', text: '目前「!待整理」資料夾中沒有任何檔案。' }],
              };
            }
            return {
              content: [{ type: 'text', text: `找到以下待整理的檔案：\n\n${docFiles.map(f => `- ${f}`).join('\n')}` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `讀取待整理檔案時發生錯誤: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        } else if (request.params.name === 'organize_sop_file') {
          const { fileName, category } = z
            .object({
              fileName: z.string().min(1, '檔案名稱不能為空'),
              category: z.string().min(1, '分類名稱不能為空'),
            })
            .parse(request.params.arguments);

          const sourcePath = path.join(PENDING_DIR, fileName);
          const targetDir = path.join(RAW_DIR, category);
          const targetPath = path.join(targetDir, fileName);

          try {
            const fileExists = await fs.access(sourcePath).then(() => true).catch(() => false);
            if (!fileExists) {
              return {
                content: [{ type: 'text', text: `錯誤：在「!待整理」資料夾中找不到檔案「${fileName}」。` }],
                isError: true,
              };
            }

            await fs.mkdir(targetDir, { recursive: true });
            await fs.rename(sourcePath, targetPath);

            return {
              content: [{ type: 'text', text: `成功將檔案「${fileName}」分類歸檔至資料夾「${category}」！` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `移動檔案時發生錯誤: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        } else {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          return {
            content: [{ type: 'text', text: `參數錯誤: ${error.issues.map((i) => i.message).join(', ')}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: `發生錯誤: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Taiwan Architect KB MCP server running on stdio');
  }
}

const server = new ArchitectKbServer();
server.run().catch(console.error);
