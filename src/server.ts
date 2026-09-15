import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openDatabase, databaseCapabilities } from './database.js';

export function createServer() {
  const server = new McpServer({ name: 'echo', version: '0.1.0' });
  server.registerTool(
    'echo_status',
    {
      description:
        'Echo local evidence retrieval status. This foundation build does not index or search notes yet.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const db = openDatabase(':memory:');
      try {
        const result = {
          phase: 'foundation',
          capabilities: databaseCapabilities(db),
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } finally {
        db.close();
      }
    },
  );
  return server;
}
