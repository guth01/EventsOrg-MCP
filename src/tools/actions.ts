import { z } from "zod";
import nodemailer from "nodemailer";
import { getDb } from "../db.js";
import { sendSms } from "../integrations/twilio.js";
import { getDirections } from "../integrations/maps.js";
import { syncToSheets } from "../integrations/sheets.js";
import { getWeather } from "../integrations/weather.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Volunteer {
  id: number;
  name: string;
  phone: string;
  current_zone: string | null;
  status: string;
}

interface Zone {
  id: number;
  name: string;
  type: string;
}

interface Incident {
  id: number;
  description: string;
  zone_id: number | null;
  zone_name: string | null;
  severity: string;
  status: string;
  created_at: number;
  resolution_note: string | null;
}

interface Vendor {
  id: number;
  name: string;
  phone: string;
  status: string;
  category: string;
  assigned_zone: string | null;
  notes: string | null;
}

interface SmsLog {
  id: number;
  direction: string;
  body: string;
  intent: string | null;
  created_at: number;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const actionToolDefinitions = [
  {
    name: "reassign_volunteer",
    description:
      "Move a volunteer to a different zone. Updates the DB, sends an SMS notification, then sends a follow-up SMS with Google Maps walking directions.",
    inputSchema: {
      type: "object",
      properties: {
        volunteer_id: { type: "number", description: "The numeric ID of the volunteer to reassign." },
        new_zone_id: { type: "number", description: "The numeric ID of the destination zone." },
      },
      required: ["volunteer_id", "new_zone_id"],
    },
  },
  {
    name: "mark_incident_resolved",
    description: "Close an open incident by marking it as resolved.",
    inputSchema: {
      type: "object",
      properties: {
        incident_id: { type: "number", description: "The numeric ID of the incident." },
        resolution_note: { type: "string", description: "How was it resolved?" },
      },
      required: ["incident_id", "resolution_note"],
    },
  },
  {
    name: "acknowledge_vendor_delay",
    description:
      "Mark a vendor as delay-acknowledged and suppress escalation alerts for a set period.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_id: { type: "number", description: "The numeric ID of the vendor." },
        delay_minutes: {
          type: "number",
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
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Phone number in E.164 format, e.g. +919400722621." },
      },
      required: ["phone"],
    },
  },
  {
    name: "get_weather",
    description:
      "Get current weather conditions and 2-hour rain forecast for a location. Use this to assess if outdoor zones need to be evacuated.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
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
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "move_zone_indoors",
    description:
      "Rain response tool. Moves ALL active volunteers from an outdoor zone to an indoor zone. Sends SMS + walking directions to each volunteer automatically. Updates zone records.",
    inputSchema: {
      type: "object",
      properties: {
        outdoor_zone_id: { type: "number", description: "The ID of the outdoor zone to evacuate." },
        indoor_zone_id: { type: "number", description: "The ID of the indoor zone to move volunteers into." },
      },
      required: ["outdoor_zone_id", "indoor_zone_id"],
    },
  },
  {
    name: "escalate_to_coordinator",
    description:
      "Send an email to the event coordinator with full incident details, what has already been attempted, and the current event snapshot. Use for high-severity incidents or situations requiring human judgment.",
    inputSchema: {
      type: "object",
      properties: {
        incident_id: { type: "number", description: "The ID of the incident to escalate." },
        message: {
          type: "string",
          description:
            "A summary of what the agent has already tried and why human intervention is needed.",
        },
      },
      required: ["incident_id", "message"],
    },
  },
  {
    name: "cancel_vendor_slot",
    description:
      "Cancel a vendor and mark them no-show. Logs the reason, notifies the coordinator by email, and returns a list of resources that need redistribution.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_id: { type: "number", description: "The ID of the vendor to cancel." },
        reason: { type: "string", description: "Why the vendor slot is being cancelled." },
      },
      required: ["vendor_id", "reason"],
    },
  },
  {
    name: "query_db",
    description: "Execute a read-only SQL SELECT query on the local SQLite database. Useful for answering ad-hoc questions about the event state.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The SQL SELECT statement to execute." },
      },
      required: ["query"],
    },
  },
  {
    name: "add_vendor",
    description: "Add a new vendor to the database.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        category: { type: "string", description: "Must be one of: food, sound, security, logistics" },
        phone: { type: "string" },
        expected_checkin: { type: "number", description: "Unix timestamp of expected check-in" },
        assigned_zone: { type: "string", description: "Optional zone name" },
      },
      required: ["name", "category", "phone", "expected_checkin"],
    },
  },
  {
    name: "add_volunteer",
    description: "Add a new volunteer to the database.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        phone: { type: "string" },
        role: { type: "string" },
        current_zone: { type: "string", description: "Optional starting zone name" },
        shift_start: { type: "number", description: "Unix timestamp of shift start" },
        shift_end: { type: "number", description: "Unix timestamp of shift end" },
      },
      required: ["name", "phone", "role", "shift_start", "shift_end"],
    },
  },
];

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const ReassignVolunteerInput = z.object({
  volunteer_id: z.number().int().positive(),
  new_zone_id: z.number().int().positive(),
});
const MarkIncidentResolvedInput = z.object({
  incident_id: z.number().int().positive(),
  resolution_note: z.string().min(1),
});
const AcknowledgeVendorDelayInput = z.object({
  vendor_id: z.number().int().positive(),
  delay_minutes: z.number().int().min(1).max(480),
});
const GetSmsHistoryInput = z.object({ phone: z.string().min(1) });
const GetWeatherInput = z.object({ location: z.string().min(1) });
const MoveZoneIndoorsInput = z.object({
  outdoor_zone_id: z.number().int().positive(),
  indoor_zone_id: z.number().int().positive(),
});
const EscalateToCoordinatorInput = z.object({
  incident_id: z.number().int().positive(),
  message: z.string().min(1),
});
const CancelVendorSlotInput = z.object({
  vendor_id: z.number().int().positive(),
  reason: z.string().min(1),
});
const QueryDbInput = z.object({
  query: z.string().min(1),
});
const AddVendorInput = z.object({
  name: z.string().min(1),
  category: z.enum(["food", "sound", "security", "logistics"]),
  phone: z.string().min(1),
  expected_checkin: z.number().int(),
  assigned_zone: z.string().optional().nullable(),
});
const AddVolunteerInput = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  role: z.string().min(1),
  current_zone: z.string().optional().nullable(),
  shift_start: z.number().int(),
  shift_end: z.number().int(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(unixTs: number): string {
  return new Date(unixTs * 1000).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function getMailTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function getEventSummaryText(): string {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 15 * 60;

  const vendorCount = db.prepare("SELECT COUNT(*) AS c FROM vendors").get() as { c: number };
  const checkedIn = db
    .prepare("SELECT COUNT(*) AS c FROM vendors WHERE status = 'checked_in'")
    .get() as { c: number };
  const overdue = db
    .prepare(
      "SELECT COUNT(*) AS c FROM vendors WHERE status IN ('pending','late') AND expected_checkin < ? AND (delay_until IS NULL OR delay_until < ?)"
    )
    .get(cutoff, now) as { c: number };
  const openIncidents = db
    .prepare("SELECT COUNT(*) AS c FROM incidents WHERE status = 'open'")
    .get() as { c: number };
  const highIncidents = db
    .prepare("SELECT COUNT(*) AS c FROM incidents WHERE status = 'open' AND severity = 'high'")
    .get() as { c: number };

  return (
    `Vendors: ${checkedIn.c}/${vendorCount.c} checked in | ${overdue.c} overdue\n` +
    `Open incidents: ${openIncidents.c} (${highIncidents.c} HIGH severity)`
  );
}

// ─── Tool Implementations ────────────────────────────────────────────────────

async function reassignVolunteer(rawArgs: unknown): Promise<string> {
  const { volunteer_id, new_zone_id } = ReassignVolunteerInput.parse(rawArgs);
  const db = getDb();

  const volunteer = db
    .prepare("SELECT id, name, phone, current_zone, status FROM volunteers WHERE id = ?")
    .get(volunteer_id) as Volunteer | undefined;

  if (!volunteer) return `❌ No volunteer found with ID ${volunteer_id}.`;
  if (volunteer.status === "absent")
    return `❌ ${volunteer.name} is marked absent and cannot be reassigned.`;

  const zone = db
    .prepare("SELECT id, name, type FROM zones WHERE id = ?")
    .get(new_zone_id) as Zone | undefined;

  if (!zone) return `❌ No zone found with ID ${new_zone_id}.`;

  const previousZone = volunteer.current_zone ?? "your current position";

  db.prepare(
    "UPDATE volunteers SET current_zone = ?, status = 'reassigned' WHERE id = ?"
  ).run(zone.name, volunteer_id);

  const log: string[] = [];

  // SMS 1 — Reassignment notice
  try {
    await sendSms(
      volunteer.phone,
      `[GRID] Hi ${volunteer.name}, you've been reassigned to "${zone.name}". Head there now. Directions follow.`
    );
    log.push("📲 Notice SMS sent.");
  } catch (e) {
    log.push(`⚠️ Notice SMS failed: ${(e as Error).message}`);
  }

  // SMS 2 — Walking directions via maps integration
  try {
    const dirs = await getDirections(previousZone, zone.name);
    await sendSms(volunteer.phone, dirs.smsText);
    log.push(`🗺️ Directions SMS sent (~${dirs.durationMinutes} min walk).`);
  } catch (e) {
    log.push(`⚠️ Directions SMS failed: ${(e as Error).message}`);
  }

  return (
    `✅ ${volunteer.name} reassigned from "${previousZone}" → "${zone.name}".\n` +
    log.join("\n")
  );
}

function markIncidentResolved(rawArgs: unknown): string {
  const { incident_id, resolution_note } = MarkIncidentResolvedInput.parse(rawArgs);
  const db = getDb();

  const incident = db
    .prepare("SELECT id, description, status FROM incidents WHERE id = ?")
    .get(incident_id) as Incident | undefined;

  if (!incident) return `❌ No incident found with ID ${incident_id}.`;
  if (incident.status === "resolved") return `ℹ️ Incident #${incident_id} is already resolved.`;

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE incidents SET status = 'resolved', resolved_at = ?, resolution_note = ? WHERE id = ?"
  ).run(now, resolution_note, incident_id);

  const preview =
    incident.description.length > 60
      ? incident.description.slice(0, 57) + "..."
      : incident.description;

  return (
    `✅ Incident #${incident_id} resolved at ${formatTime(now)}.\n` +
    `Description: "${preview}"\nResolution: "${resolution_note}"`
  );
}

function acknowledgeVendorDelay(rawArgs: unknown): string {
  const { vendor_id, delay_minutes } = AcknowledgeVendorDelayInput.parse(rawArgs);
  const db = getDb();

  const vendor = db
    .prepare("SELECT id, name, phone, status, assigned_zone FROM vendors WHERE id = ?")
    .get(vendor_id) as Vendor | undefined;

  if (!vendor) return `❌ No vendor found with ID ${vendor_id}.`;
  if (vendor.status === "checked_in")
    return `ℹ️ ${vendor.name} has already checked in.`;
  if (vendor.status === "no_show")
    return `⚠️ ${vendor.name} is no-show. Use check-in if they arrive.`;

  const now = Math.floor(Date.now() / 1000);
  const delayUntil = now + delay_minutes * 60;

  db.prepare(
    "UPDATE vendors SET status = 'delay_acknowledged', delay_until = ? WHERE id = ?"
  ).run(delayUntil, vendor_id);

  return (
    `🕒 Delay acknowledged for "${vendor.name}" (${vendor.assigned_zone ?? "unassigned"}).\n` +
    `Expected by: ${formatTime(delayUntil)} (+${delay_minutes} min).`
  );
}

function getSmsHistory(rawArgs: unknown): string {
  const { phone } = GetSmsHistoryInput.parse(rawArgs);
  const db = getDb();

  const rows = db
    .prepare(
      "SELECT id, direction, body, intent, created_at FROM sms_log WHERE phone = ? ORDER BY created_at ASC"
    )
    .all(phone) as SmsLog[];

  if (rows.length === 0) return `ℹ️ No SMS history found for ${phone}.`;

  const lines = [`📱 SMS history for ${phone} (${rows.length} message(s)):`];
  for (const row of rows) {
    const dir = row.direction === "outbound" ? "→ OUT" : "← IN ";
    const intent = row.intent ? ` [${row.intent}]` : "";
    lines.push(`  ${dir} ${formatTime(row.created_at)}${intent}: ${row.body}`);
  }
  return lines.join("\n");
}

async function getWeatherTool(rawArgs: unknown): Promise<string> {
  const { location } = GetWeatherInput.parse(rawArgs);
  const report = await getWeather(location);
  return report.summary;
}

async function moveZoneIndoors(rawArgs: unknown): Promise<string> {
  const { outdoor_zone_id, indoor_zone_id } = MoveZoneIndoorsInput.parse(rawArgs);
  const db = getDb();

  const outdoorZone = db
    .prepare("SELECT id, name, type FROM zones WHERE id = ?")
    .get(outdoor_zone_id) as Zone | undefined;

  const indoorZone = db
    .prepare("SELECT id, name, type FROM zones WHERE id = ?")
    .get(indoor_zone_id) as Zone | undefined;

  if (!outdoorZone) return `❌ Outdoor zone ID ${outdoor_zone_id} not found.`;
  if (!indoorZone) return `❌ Indoor zone ID ${indoor_zone_id} not found.`;

  // Get all active volunteers in the outdoor zone
  const volunteers = db
    .prepare(
      "SELECT id, name, phone, current_zone, status FROM volunteers WHERE current_zone = ? AND status IN ('active', 'reassigned')"
    )
    .all(outdoorZone.name) as Volunteer[];

  if (volunteers.length === 0) {
    return `ℹ️ No active volunteers found in "${outdoorZone.name}". Nothing to move.`;
  }

  const results: string[] = [
    `🌧️ Moving ${volunteers.length} volunteer(s) from "${outdoorZone.name}" → "${indoorZone.name}":`,
  ];

  // Reassign each volunteer (triggers DB update + 2× SMS)
  for (const vol of volunteers) {
    const result = await reassignVolunteer({
      volunteer_id: vol.id,
      new_zone_id: indoor_zone_id,
    });
    results.push(`  • ${vol.name}: ${result.split("\n")[0]}`);
  }

  // Update zone type record (mark outdoor zone as evacuated via headcount)
  db.prepare("UPDATE zones SET current_headcount = 0 WHERE id = ?").run(outdoor_zone_id);

  results.push(`\n✅ "${outdoorZone.name}" evacuated. All volunteers redirected to "${indoorZone.name}".`);

  return results.join("\n");
}

async function escalateToCoordinator(rawArgs: unknown): Promise<string> {
  const { incident_id, message } = EscalateToCoordinatorInput.parse(rawArgs);
  const db = getDb();

  const incident = db
    .prepare(
      `SELECT i.id, i.description, z.name AS zone_name, i.severity, i.status, i.created_at, i.resolution_note
       FROM incidents i LEFT JOIN zones z ON z.id = i.zone_id
       WHERE i.id = ?`
    )
    .get(incident_id) as Incident | undefined;

  if (!incident) return `❌ No incident found with ID ${incident_id}.`;

  const to = process.env.COORDINATOR_EMAIL;
  if (!to) return "❌ COORDINATOR_EMAIL not set in env.";

  const eventSummary = getEventSummaryText();
  const severity = incident.severity.toUpperCase();
  const zone = incident.zone_name ?? "Unknown";

  const subject = `[GRID 🚨] ${severity} Incident #${incident_id} — ${zone} — Escalation Required`;

  const body = `
INCIDENT ESCALATION — GRID 7.0 Event Management
================================================

Incident ID:  #${incident_id}
Zone:         ${zone}
Severity:     ${severity}
Reported At:  ${formatTime(incident.created_at)}
Status:       ${incident.status.toUpperCase()}

Description:
${incident.description}

─────────────────────────────────────────────────
AGENT MESSAGE (what was attempted before escalation):
${message}

─────────────────────────────────────────────────
CURRENT EVENT SNAPSHOT:
${eventSummary}

─────────────────────────────────────────────────
This email was generated automatically by the GRID 7.0 autonomous event manager.
  `.trim();

  const transporter = getMailTransporter();
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject,
    text: body,
  });

  return (
    `📧 Escalation email sent to ${to}.\n` +
    `Subject: "${subject}"\n` +
    `Incident #${incident_id} | Zone: ${zone} | Severity: ${severity}`
  );
}

async function cancelVendorSlot(rawArgs: unknown): Promise<string> {
  const { vendor_id, reason } = CancelVendorSlotInput.parse(rawArgs);
  const db = getDb();

  const vendor = db
    .prepare("SELECT id, name, phone, category, status, assigned_zone, notes FROM vendors WHERE id = ?")
    .get(vendor_id) as Vendor | undefined;

  if (!vendor) return `❌ No vendor found with ID ${vendor_id}.`;
  if (vendor.status === "no_show")
    return `ℹ️ Vendor "${vendor.name}" is already marked no-show.`;

  // Update DB
  const cancelNote = `[CANCELLED] ${reason}`;
  db.prepare(
    "UPDATE vendors SET status = 'no_show', notes = ? WHERE id = ?"
  ).run(cancelNote, vendor_id);

  // Determine what resources were assigned (zone impact)
  const zone = vendor.assigned_zone ?? "unassigned";
  const volunteersInZone = vendor.assigned_zone
    ? (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM volunteers WHERE current_zone = ? AND status IN ('active','reassigned')"
          )
          .get(vendor.assigned_zone) as { c: number }
      ).c
    : 0;

  // Notify coordinator by email
  const to = process.env.COORDINATOR_EMAIL;
  const emailResult: string[] = [];

  if (to) {
    const subject = `[GRID] Vendor Cancelled — ${vendor.name} (${vendor.category})`;
    const body = `
VENDOR CANCELLATION — GRID 7.0
===============================

Vendor:    ${vendor.name}
Category:  ${vendor.category}
Zone:      ${zone}
Reason:    ${reason}
Cancelled: ${formatTime(Math.floor(Date.now() / 1000))}

RESOURCES REQUIRING REDISTRIBUTION:
• Zone "${zone}" had ${volunteersInZone} active volunteer(s).
• Review whether this zone now needs to be repurposed or volunteers reassigned.

This notification was generated automatically by GRID 7.0.
    `.trim();

    try {
      const transporter = getMailTransporter();
      await transporter.sendMail({ from: process.env.SMTP_USER, to, subject, text: body });
      emailResult.push(`📧 Coordinator notified at ${to}.`);
    } catch (e) {
      emailResult.push(`⚠️ Email failed: ${(e as Error).message}`);
    }
  } else {
    emailResult.push("⚠️ COORDINATOR_EMAIL not set — email skipped.");
  }

  return (
    `❌ Vendor "${vendor.name}" (${vendor.category}) cancelled.\n` +
    `Reason: ${reason}\n` +
    `Zone: ${zone} | Volunteers in zone: ${volunteersInZone}\n` +
    `${emailResult.join("\n")}\n` +
    `\n📋 Redistribution needed:\n` +
    `  • Zone "${zone}" — check if vendor equipment/space needs reassignment.\n` +
    `  • ${volunteersInZone} volunteer(s) may need to be redeployed.`
  );
}

function queryDb(rawArgs: unknown): string {
  const { query } = QueryDbInput.parse(rawArgs);
  const db = getDb();

  const upperQuery = query.trim().toUpperCase();
  if (!upperQuery.startsWith("SELECT") && !upperQuery.startsWith("PRAGMA")) {
    return "❌ Only SELECT or PRAGMA queries are allowed.";
  }

  try {
    const rows = db.prepare(query).all();
    return JSON.stringify(rows, null, 2);
  } catch (e) {
    return `❌ Query failed: ${(e as Error).message}`;
  }
}

function addVendor(rawArgs: unknown): string {
  const args = AddVendorInput.parse(rawArgs);
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      INSERT INTO vendors (name, category, phone, expected_checkin, assigned_zone)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(args.name, args.category, args.phone, args.expected_checkin, args.assigned_zone ?? null);
    return `✅ Vendor "${args.name}" added successfully with ID ${result.lastInsertRowid}.`;
  } catch (e) {
    return `❌ Failed to add vendor: ${(e as Error).message}`;
  }
}

function addVolunteer(rawArgs: unknown): string {
  const args = AddVolunteerInput.parse(rawArgs);
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      INSERT INTO volunteers (name, phone, role, current_zone, shift_start, shift_end)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(args.name, args.phone, args.role, args.current_zone ?? null, args.shift_start, args.shift_end);
    return `✅ Volunteer "${args.name}" added successfully with ID ${result.lastInsertRowid}.`;
  } catch (e) {
    return `❌ Failed to add volunteer: ${(e as Error).message}`;
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export async function handleActionTool(
  name: string,
  args: unknown
): Promise<string | null> {
  switch (name) {
    case "reassign_volunteer":
      return reassignVolunteer(args);
    case "mark_incident_resolved":
      return markIncidentResolved(args);
    case "acknowledge_vendor_delay":
      return acknowledgeVendorDelay(args);
    case "get_sms_history":
      return getSmsHistory(args);
    case "get_weather":
      return getWeatherTool(args);
    case "sync_to_sheets":
      return syncToSheets();
    case "move_zone_indoors":
      return moveZoneIndoors(args);
    case "escalate_to_coordinator":
      return escalateToCoordinator(args);
    case "cancel_vendor_slot":
      return cancelVendorSlot(args);
    case "query_db":
      return queryDb(args);
    case "add_vendor":
      return addVendor(args);
    case "add_volunteer":
      return addVolunteer(args);
    default:
      return null;
  }
}
