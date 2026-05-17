/**
 * src/agent.ts
 *
 * Autonomous event-operations agent — runs as a standalone interval loop.
 * Shares the same SQLite database as the MCP server but operates independently.
 *
 * Usage:
 *   NODE_ENV=agent npx ts-node src/agent.ts
 *   — or —
 *   NODE_ENV=agent npx tsx src/agent.ts
 *
 * The MCP server (src/index.ts) runs separately and always.
 * Do NOT import this file from the MCP server.
 */

import "dotenv/config";
import { GoogleGenAI, Type } from "@google/genai";
import type { FunctionDeclaration, Schema } from "@google/genai";
import { initDb } from "./db.js";
import { handleQueryTool } from "./tools/query.js";
import { handleActionTool } from "./tools/actions.js";
import { getWeather } from "./integrations/weather.js";

// ─── Guard: only run when explicitly started as the agent ────────────────────

if (process.env.NODE_ENV !== "agent") {
  console.error(
    "[agent] This script must be started with NODE_ENV=agent.\n" +
    "  Example: NODE_ENV=agent npx tsx src/agent.ts"
  );
  process.exit(1);
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** How often the agent loop fires (milliseconds). */
const LOOP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Location used for the weather call.
 * Matches the event city — change as needed or pull from env.
 */
const EVENT_LOCATION = process.env.EVENT_LOCATION ?? "Kochi";

/** Maximum Gemini agentic turns per loop to prevent runaway tool calls. */
const MAX_TURNS = 20;

// ─── Gemini client ────────────────────────────────────────────────────────────

function getGemini(): GoogleGenAI {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("[agent] GOOGLE_API_KEY is missing from env.");
  return new GoogleGenAI({ apiKey });
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an autonomous event operations agent. You are given the current state of a live event. Your job is to identify problems and resolve them using your tools. Follow these priorities in order: 1) safety incidents are always first, 2) check-in escalations for vendors with no response, 3) understaffed zones, 4) weather risks to outdoor zones. Never escalate a vendor who has acknowledged their delay and whose delay_until time has not passed. Always send SMS notifications when reassigning people. Always sync to sheets after taking any action. Be concise in your reasoning.`;

// ─── Tool schemas for Gemini function-calling ─────────────────────────────────
// These mirror the MCP tool definitions but are expressed in the Gemini SDK
// FunctionDeclaration format. All action + query tools are available so the
// agent can both read state and take action within the same conversation turn.

const GEMINI_TOOLS: FunctionDeclaration[] = [
  // ── Query tools ────────────────────────────────────────────────────────────
  {
    name: "get_event_summary",
    description:
      "Master status tool. Returns a full snapshot of the event: vendor check-in counts, understaffed zones, overdue vendors, and active incidents. Call this at the start of any status check.",
    parameters: { type: Type.OBJECT, properties: {} as Record<string, Schema>, required: [] },
  },
  {
    name: "get_overdue_vendors",
    description:
      "Returns all vendors who were expected to check in more than 15 minutes ago and still haven't, excluding those who have sent a delay notice that's still valid.",
    parameters: { type: Type.OBJECT, properties: {} as Record<string, Schema>, required: [] },
  },
  {
    name: "get_understaffed_zones",
    description:
      "Returns all zones where the number of currently active volunteers is below the minimum required.",
    parameters: { type: Type.OBJECT, properties: {} as Record<string, Schema>, required: [] },
  },
  {
    name: "get_active_incidents",
    description:
      "Returns all currently open (unresolved) incidents, ordered by severity (high first) then by time reported (oldest first).",
    parameters: { type: Type.OBJECT, properties: {} as Record<string, Schema>, required: [] },
  },
  {
    name: "get_volunteer_availability",
    description:
      "Returns active volunteers. Optionally filter by role. Useful for finding someone to reassign.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        role: {
          type: Type.STRING,
          description: "Optional role filter (e.g. 'Runner', 'Crowd Control'). Leave blank for all.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_vendor_status",
    description:
      "Returns the full record for a specific vendor, including their complete SMS history.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        vendor_id: { type: Type.NUMBER, description: "The numeric ID of the vendor." },
      },
      required: ["vendor_id"],
    },
  },
  // ── Action tools ───────────────────────────────────────────────────────────
  {
    name: "reassign_volunteer",
    description:
      "Move a volunteer to a different zone. Updates the DB, sends an SMS notification, then sends a follow-up SMS with Google Maps walking directions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        volunteer_id: { type: Type.NUMBER, description: "The numeric ID of the volunteer to reassign." },
        new_zone_id: { type: Type.NUMBER, description: "The numeric ID of the destination zone." },
      },
      required: ["volunteer_id", "new_zone_id"],
    },
  },
  {
    name: "mark_incident_resolved",
    description: "Close an open incident by marking it as resolved.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        incident_id: { type: Type.NUMBER, description: "The numeric ID of the incident." },
        resolution_note: { type: Type.STRING, description: "How was it resolved?" },
      },
      required: ["incident_id", "resolution_note"],
    },
  },
  {
    name: "acknowledge_vendor_delay",
    description:
      "Mark a vendor as delay-acknowledged and suppress escalation alerts for a set period.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        vendor_id: { type: Type.NUMBER, description: "The numeric ID of the vendor." },
        delay_minutes: {
          type: Type.NUMBER,
          description: "Minutes from now before the vendor is expected. Alerts suppressed until then.",
        },
      },
      required: ["vendor_id", "delay_minutes"],
    },
  },
  {
    name: "get_sms_history",
    description:
      "Returns the full SMS conversation thread for a given phone number, sorted chronologically.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone: { type: Type.STRING, description: "Phone number in E.164 format, e.g. +919400722621." },
      },
      required: ["phone"],
    },
  },
  {
    name: "get_weather",
    description:
      "Get current weather conditions and 2-hour rain forecast for a location. Use this to assess if outdoor zones need to be evacuated.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: {
          type: Type.STRING,
          description: "City name (e.g. 'Kochi') or 'lat,lon' (e.g. '9.93,76.26').",
        },
      },
      required: ["location"],
    },
  },
  {
    name: "sync_to_sheets",
    description:
      "Push the current vendor statuses, zone headcounts/volunteers, and open incidents to the Google Sheet dashboard. Call this after any major status change.",
    parameters: { type: Type.OBJECT, properties: {} as Record<string, Schema>, required: [] },
  },
  {
    name: "move_zone_indoors",
    description:
      "Rain response tool. Moves ALL active volunteers from an outdoor zone to an indoor zone. Sends SMS + walking directions to each volunteer automatically. Updates zone records.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        outdoor_zone_id: { type: Type.NUMBER, description: "The ID of the outdoor zone to evacuate." },
        indoor_zone_id: { type: Type.NUMBER, description: "The ID of the indoor zone to move volunteers into." },
      },
      required: ["outdoor_zone_id", "indoor_zone_id"],
    },
  },
  {
    name: "escalate_to_coordinator",
    description:
      "Send an email to the event coordinator with full incident details, what has already been attempted, and the current event snapshot. Use for high-severity incidents or situations requiring human judgment.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        incident_id: { type: Type.NUMBER, description: "The ID of the incident to escalate." },
        message: {
          type: Type.STRING,
          description: "A summary of what the agent has already tried and why human intervention is needed.",
        },
      },
      required: ["incident_id", "message"],
    },
  },
  {
    name: "cancel_vendor_slot",
    description:
      "Cancel a vendor and mark them no-show. Logs the reason, notifies the coordinator by email, and returns a list of resources that need redistribution.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        vendor_id: { type: Type.NUMBER, description: "The ID of the vendor to cancel." },
        reason: { type: Type.STRING, description: "Why the vendor slot is being cancelled." },
      },
      required: ["vendor_id", "reason"],
    },
  },
  {
    name: "query_db",
    description:
      "Execute a read-only SQL SELECT query on the local SQLite database. Useful for answering ad-hoc questions about the event state.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "The SQL SELECT statement to execute." },
      },
      required: ["query"],
    },
  },
];

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

/**
 * Execute a single tool call requested by Gemini and return its string result.
 * Routes to either the query handler or the action handler, matching the same
 * logic used in the MCP server (src/index.ts).
 */
async function dispatchTool(name: string, args: unknown): Promise<string> {
  // Try query tools first (synchronous)
  const queryResult = handleQueryTool(name, args);
  if (queryResult !== null) return queryResult;

  // Try action tools (async, includes SMS, email, sheets, weather)
  const actionResult = await handleActionTool(name, args);
  if (actionResult !== null) return actionResult;

  return `❌ Unknown tool: ${name}`;
}

// ─── Core agent loop ──────────────────────────────────────────────────────────

/**
 * Gathers the initial event context (summary + weather), sends it to Gemini
 * with all tools available, then drives the agentic tool-call loop until the
 * model stops requesting tool calls or MAX_TURNS is reached.
 */
async function runAgentLoop(): Promise<void> {
  const loopStart = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`\n${"═".repeat(60)}`);
  console.log(`[agent] Loop started at ${loopStart}`);
  console.log(`${"═".repeat(60)}`);

  const ai = getGemini();

  // ── Step 1: Gather context directly from DB (no MCP) ──────────────────────
  let eventSummary: string;
  let weatherSummary: string;

  try {
    eventSummary = handleQueryTool("get_event_summary", {}) ?? "⚠️ Could not fetch event summary.";
  } catch (err) {
    eventSummary = `⚠️ Event summary error: ${(err as Error).message}`;
  }

  try {
    const weatherReport = await getWeather(EVENT_LOCATION);
    weatherSummary = weatherReport.summary;
  } catch (err) {
    weatherSummary = `⚠️ Weather fetch error: ${(err as Error).message}`;
  }

  const initialUserMessage =
    `[AGENT LOOP — ${loopStart}]\n\n` +
    `=== EVENT SUMMARY ===\n${eventSummary}\n\n` +
    `=== WEATHER (${EVENT_LOCATION}) ===\n${weatherSummary}\n\n` +
    `Analyse the above state. Identify any issues according to your priorities and resolve them using your tools. ` +
    `When you are done taking all necessary actions, provide a concise summary of what you did (or "No action required" if everything looks fine).`;

  console.log("[agent] Initial context gathered.");
  console.log("[agent] Event Summary:\n", eventSummary);
  console.log("[agent] Weather:\n", weatherSummary);

  // ── Step 2: Agentic tool-call loop ────────────────────────────────────────
  // We use a manual multi-turn loop because Gemini's generateContent API
  // returns one response at a time; we feed tool results back as user turns.

  // Conversation history: alternating user / model messages
  // Using the @google/genai Content format
  const history: Array<{ role: string; parts: Array<{ text?: string; functionCall?: { name: string; args: unknown }; functionResponse?: { name: string; response: { content: string } } }> }> = [
    { role: "user", parts: [{ text: initialUserMessage }] },
  ];

  let turn = 0;

  while (turn < MAX_TURNS) {
    turn++;
    console.log(`\n[agent] ── Turn ${turn} ──`);

    let response: Awaited<ReturnType<typeof ai.models.generateContent>>;

    try {
      response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: history as Parameters<typeof ai.models.generateContent>[0]["contents"],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: GEMINI_TOOLS }],
          temperature: 0.2,
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("Quota exceeded")) {
        console.warn(`[agent] ⏳ Rate limit hit (Free Tier). Waiting 30 seconds before retrying turn ${turn}...`);
        await new Promise((r) => setTimeout(r, 30000));
        turn--; // Retry this turn
        continue;
      }
      console.error(`[agent] Gemini API error on turn ${turn}:`, msg);
      break;
    }

    // Check finish reason
    const candidate = response.candidates?.[0];
    if (!candidate) {
      console.warn("[agent] No candidates returned — stopping.");
      break;
    }

    // Extract text and function calls from the response parts
    const responseParts = candidate.content?.parts ?? [];
    const textParts = responseParts.filter((p) => p.text);
    const fnCallParts = responseParts.filter((p) => p.functionCall);

    // Log any text the model produced
    for (const part of textParts) {
      if (part.text) {
        console.log(`[agent] Gemini says:\n${part.text}`);
      }
    }

    // If no function calls, the model is done
    if (fnCallParts.length === 0) {
      console.log("[agent] No tool calls requested — model finished reasoning.");
      break;
    }

    // Append the model's response to history
    history.push({ role: "model", parts: responseParts as typeof history[0]["parts"] });

    // Execute all requested tool calls and collect results
    const toolResultParts: typeof history[0]["parts"] = [];

    for (const part of fnCallParts) {
      const fc = part.functionCall!;
      const toolName = fc.name ?? "(unnamed)";
      const toolArgs = fc.args ?? {};

      console.log(`[agent] ▶ Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);

      let result: string;
      try {
        result = await dispatchTool(toolName, toolArgs);
      } catch (err) {
        result = `❌ Tool execution error: ${(err as Error).message}`;
      }

      console.log(`[agent] ◀ Result: ${result.slice(0, 300)}${result.length > 300 ? "…" : ""}`);

      toolResultParts.push({
        functionResponse: {
          name: toolName,
          response: { content: result },
        },
      });
    }

    // Feed tool results back as a user turn
    history.push({ role: "user", parts: toolResultParts });
  }

  if (turn >= MAX_TURNS) {
    console.warn(`[agent] ⚠️ Reached MAX_TURNS (${MAX_TURNS}) — loop forcefully terminated.`);
  }

  const loopEnd = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`\n[agent] Loop completed at ${loopEnd} (${turn} turn(s) used).`);
  console.log(`${"═".repeat(60)}\n`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[agent] GRID 7.0 Autonomous Event Agent starting…");
  console.log(`[agent] Event location : ${EVENT_LOCATION}`);
  console.log(`[agent] Loop interval  : ${LOOP_INTERVAL_MS / 1000}s (${LOOP_INTERVAL_MS / 60000} min)`);
  console.log(`[agent] Max turns/loop : ${MAX_TURNS}`);

  // Initialise the shared database (idempotent — safe to call alongside MCP server)
  initDb();

  // Run once immediately so we don't have to wait 5 minutes for the first cycle
  await runAgentLoop().catch((err) => {
    console.error("[agent] Unhandled error in first loop run:", err);
  });

  // Then repeat on the configured interval
  setInterval(() => {
    runAgentLoop().catch((err) => {
      console.error("[agent] Unhandled error in scheduled loop run:", err);
    });
  }, LOOP_INTERVAL_MS);

  console.log(`[agent] Scheduler armed — next run in ${LOOP_INTERVAL_MS / 60000} minute(s).`);
}

main().catch((err) => {
  console.error("[agent] Fatal startup error:", err);
  process.exit(1);
});
