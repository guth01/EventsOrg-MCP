import "./patch-stdout.js";
import * as dotenv from "dotenv";
import path from "path";
// Load .env from the root directory (one level up from build/ or src/)
dotenv.config({ path: path.join(__dirname, "../.env") });
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDb } from "./db.js";
import { checkinToolDefinitions, handleCheckinTool } from "./tools/checkin.js";
import { queryToolDefinitions, handleQueryTool } from "./tools/query.js";
import { actionToolDefinitions, handleActionTool } from "./tools/actions.js";
import { sendSms } from "./integrations/twilio.js";
import { getDirections } from "./integrations/maps.js";
import { startWebhookServer } from "./webhook.js";
import { setupTunnel } from "./tunnel.js";

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
  // action tools (includes get_sms_history)
  ...actionToolDefinitions,
  // sms
  {
    name: "send_sms",
    description:
      "Send an outbound SMS to a vendor or volunteer. Use this to notify them of reassignments, reminders, or any urgent update. The message is logged automatically.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient phone number in E.164 format, e.g. +919400722621" },
        body: { type: "string", description: "The SMS message text to send." },
      },
      required: ["to", "body"],
    },
  },
  // maps
  {
    name: "get_directions",
    description:
      "Get walking directions between two locations. Returns estimated time and turn-by-turn steps.",
    inputSchema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Starting point — place name, address, or lat,lon." },
        destination: { type: "string", description: "Destination — same formats accepted." },
      },
      required: ["origin", "destination"],
    },
  },
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

  // check-in tools (sync)
  if (result === null) result = handleCheckinTool(name, args);

  // query tools (sync)
  if (result === null) result = handleQueryTool(name, args);

  // action tools (async — reassign_volunteer sends real SMS)
  if (result === null) result = await handleActionTool(name, args);

  // sms tool (async)
  if (result === null && name === "send_sms") {
    const { to, body } = args as { to: string; body: string };
    if (!to || !body) throw new Error("send_sms requires 'to' and 'body'.");
    const sid = await sendSms(to, body);
    result = `✅ SMS sent to ${to}. Twilio SID: ${sid}`;
  }

  // maps tool (async)
  if (result === null && name === "get_directions") {
    const { origin, destination } = args as { origin: string; destination: string };
    const dirs = await getDirections(origin, destination);
    result =
      `🗺️ ${origin} → ${destination}\n` +
      `Distance: ${dirs.distance} | ~${dirs.durationMinutes} min walk\n` +
      dirs.steps.join("\n");
  }

  if (result === null) {
    throw new Error(`Unknown tool: "${name}"`);
  }

  return {
    content: [{ type: "text", text: result }],
  };
});

// ─── Start Server ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  let transportMode = "stdio";
  const transportArgIndex = args.indexOf("--transport");
  if (transportArgIndex !== -1 && args[transportArgIndex + 1]) {
    transportMode = args[transportArgIndex + 1];
  }

  const webhookPort = parseInt(process.env.WEBHOOK_PORT ?? "3000", 10);

  // 1. Start the inbound HTTP webhook server
  startWebhookServer(webhookPort);

  // 2. Set up Cloudflare tunnel (or use PUBLIC_URL if deployed)
  //    This also auto-registers the live URL with Twilio — zero manual steps.
  try {
    const publicUrl = await setupTunnel(webhookPort);
    console.error(`[grid] 🌐 Public webhook URL: ${publicUrl}/webhook/sms`);
  } catch (err) {
    console.error(
      "[grid] ⚠️ Tunnel setup failed — inbound SMS will not work until PUBLIC_URL is set.",
      err
    );
  }

  // 3. Start the MCP server based on transport mode
  if (transportMode === "http") {
    const port = parseInt(process.env.PORT || "3001", 10);
    const app = express();
    let sseTransport: SSEServerTransport | null = null;

    app.get("/sse", async (req, res) => {
      console.error("[grid] New SSE client connected");
      sseTransport = new SSEServerTransport("/message", res);
      await server.connect(sseTransport);
    });

    app.post("/message", async (req, res) => {
      if (!sseTransport) {
        res.status(400).send("No active SSE connection");
        return;
      }
      await sseTransport.handlePostMessage(req, res);
    });

    app.listen(port, () => {
      console.error(`[grid] MCP HTTP/SSE server listening on port ${port}`);
      console.error(`[grid] SSE endpoint: http://localhost:${port}/sse`);
      console.error(`[grid] Message endpoint: http://localhost:${port}/message`);
      console.error(`[grid] MCP server started — ${ALL_TOOLS.length} tools registered`);
    });
  } else {
    // default to stdio
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `[grid] MCP server started via stdio — ${ALL_TOOLS.length} tools registered`
    );
  }
}

main().catch((err) => {
  console.error("Fatal server error:", err);
  process.exit(1);
});
