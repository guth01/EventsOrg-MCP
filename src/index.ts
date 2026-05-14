import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDb } from "./db.js";
import { checkinToolDefinitions, handleCheckinTool } from "./tools/checkin.js";
import { queryToolDefinitions, handleQueryTool } from "./tools/query.js";
import { actionToolDefinitions, handleActionTool } from "./tools/actions.js";

// ─── Initialise Database ──────────────────────────────────────────────────────
initDb();

// ─── Create MCP Server ───────────────────────────────────────────────────────
const server = new Server(
  {
    name: "grid-event-manager",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── All tool definitions merged ─────────────────────────────────────────────
const ALL_TOOLS = [
  // connectivity check
  {
    name: "ping",
    description: "Connectivity check. Returns 'pong'.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // check-in / write tools
  ...checkinToolDefinitions,
  // query / read tools
  ...queryToolDefinitions,
  // action tools
  ...actionToolDefinitions,
];

// ─── List Tools Handler ───────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

// ─── Call Tool Handler ────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let result: string | null = null;

  // ping
  if (name === "ping") {
    result = "pong";
  }

  // check-in tools
  if (result === null) result = handleCheckinTool(name, args);

  // query tools
  if (result === null) result = handleQueryTool(name, args);

  // action tools
  if (result === null) result = handleActionTool(name, args);

  if (result === null) {
    throw new Error(`Unknown tool: "${name}"`);
  }

  return {
    content: [{ type: "text", text: result }],
  };
});

// ─── Start Server ─────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[grid] MCP server started — ${ALL_TOOLS.length} tools registered`
  );
}

main().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
