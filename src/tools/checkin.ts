import { z } from "zod";
import { getDb } from "../db.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Vendor {
  id: number;
  name: string;
  status: string;
  assigned_zone: string | null;
}

interface Volunteer {
  id: number;
  name: string;
  current_zone: string | null;
}

interface Zone {
  id: number;
  name: string;
  capacity: number;
}

// ─── Tool Definitions (JSON Schema for MCP ListTools) ────────────────────────

export const checkinToolDefinitions = [
  {
    name: "checkin_vendor",
    description:
      "Mark a vendor as checked in. Call this when a vendor physically arrives at their assigned zone.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_id: {
          type: "number",
          description: "The numeric ID of the vendor to check in.",
        },
      },
      required: ["vendor_id"],
    },
  },
  {
    name: "report_volunteer_absent",
    description:
      "Mark a volunteer as absent. Use this when a volunteer calls in sick or doesn't show up for their shift.",
    inputSchema: {
      type: "object",
      properties: {
        volunteer_id: {
          type: "number",
          description: "The numeric ID of the volunteer.",
        },
        reason: {
          type: "string",
          description: "Brief reason for absence (e.g. 'called in sick', 'no show').",
        },
      },
      required: ["volunteer_id", "reason"],
    },
  },
  {
    name: "update_zone_headcount",
    description:
      "Update the current headcount of a zone. Returns a crowd warning if headcount exceeds 90% of zone capacity.",
    inputSchema: {
      type: "object",
      properties: {
        zone_id: {
          type: "number",
          description: "The numeric ID of the zone.",
        },
        count: {
          type: "number",
          description: "The new headcount value for the zone.",
        },
      },
      required: ["zone_id", "count"],
    },
  },
  {
    name: "report_incident",
    description:
      "Log a new incident at a zone. Use this whenever something goes wrong — medical, technical, crowd, or security.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A clear description of what happened.",
        },
        zone_id: {
          type: "number",
          description: "The ID of the zone where the incident occurred.",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Severity level of the incident.",
        },
      },
      required: ["description", "zone_id", "severity"],
    },
  },
];

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const CheckinVendorInput = z.object({
  vendor_id: z.number().int().positive(),
});

const ReportVolunteerAbsentInput = z.object({
  volunteer_id: z.number().int().positive(),
  reason: z.string().min(1),
});

const UpdateZoneHeadcountInput = z.object({
  zone_id: z.number().int().positive(),
  count: z.number().int().min(0),
});

const ReportIncidentInput = z.object({
  description: z.string().min(1),
  zone_id: z.number().int().positive(),
  severity: z.enum(["low", "medium", "high"]),
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

// ─── Tool Handlers ────────────────────────────────────────────────────────────

function checkinVendor(rawArgs: unknown): string {
  const { vendor_id } = CheckinVendorInput.parse(rawArgs);
  const db = getDb();

  const vendor = db
    .prepare("SELECT id, name, status FROM vendors WHERE id = ?")
    .get(vendor_id) as Vendor | undefined;

  if (!vendor) return `❌ No vendor found with ID ${vendor_id}.`;
  if (vendor.status === "checked_in")
    return `ℹ️ ${vendor.name} is already checked in.`;

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE vendors SET status = 'checked_in', expected_checkin = ? WHERE id = ?"
  ).run(now, vendor_id);

  return `✅ Vendor "${vendor.name}" checked in successfully at ${formatTime(now)}.`;
}

function reportVolunteerAbsent(rawArgs: unknown): string {
  const { volunteer_id, reason } = ReportVolunteerAbsentInput.parse(rawArgs);
  const db = getDb();

  const vol = db
    .prepare("SELECT id, name, current_zone FROM volunteers WHERE id = ?")
    .get(volunteer_id) as Volunteer | undefined;

  if (!vol) return `❌ No volunteer found with ID ${volunteer_id}.`;

  db.prepare("UPDATE volunteers SET status = 'absent' WHERE id = ?").run(
    volunteer_id
  );

  const zone = vol.current_zone ?? "unassigned";
  return (
    `⚠️ Volunteer "${vol.name}" marked absent (reason: ${reason}). ` +
    `They were assigned to ${zone}. That zone may now be short-staffed.`
  );
}

function updateZoneHeadcount(rawArgs: unknown): string {
  const { zone_id, count } = UpdateZoneHeadcountInput.parse(rawArgs);
  const db = getDb();

  const zone = db
    .prepare("SELECT id, name, capacity FROM zones WHERE id = ?")
    .get(zone_id) as Zone | undefined;

  if (!zone) return `❌ No zone found with ID ${zone_id}.`;

  db.prepare("UPDATE zones SET current_headcount = ? WHERE id = ?").run(
    count,
    zone_id
  );

  const pct = (count / zone.capacity) * 100;

  if (pct >= 100) {
    return (
      `🚨 CAPACITY EXCEEDED — ${zone.name} is at ${count}/${zone.capacity} people (${pct.toFixed(0)}%). ` +
      `Immediate crowd management action required.`
    );
  }
  if (pct >= 90) {
    return (
      `⚠️ CROWD WARNING — ${zone.name} headcount updated to ${count}/${zone.capacity} (${pct.toFixed(0)}%). ` +
      `Zone is approaching capacity. Consider restricting entry.`
    );
  }

  return `✅ ${zone.name} headcount updated to ${count}/${zone.capacity} (${pct.toFixed(0)}% capacity).`;
}

function reportIncident(rawArgs: unknown): string {
  const { description, zone_id, severity } = ReportIncidentInput.parse(rawArgs);
  const db = getDb();

  const zone = db
    .prepare("SELECT name FROM zones WHERE id = ?")
    .get(zone_id) as { name: string } | undefined;

  if (!zone) return `❌ No zone found with ID ${zone_id}.`;

  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT INTO incidents (description, zone_id, severity, status, created_at)
       VALUES (?, ?, ?, 'open', ?)`
    )
    .run(description, zone_id, severity, now) as { lastInsertRowid: number };

  const incidentId = result.lastInsertRowid;
  const severityEmoji = severity === "high" ? "🔴" : severity === "medium" ? "🟡" : "🟢";

  return (
    `${severityEmoji} Incident #${incidentId} logged at ${zone.name} — ` +
    `Severity: ${severity.toUpperCase()}. Description: "${description}". ` +
    `Status: OPEN. Created at ${formatTime(now)}.`
  );
}

// ─── Main Handler (called from index.ts) ─────────────────────────────────────

export function handleCheckinTool(name: string, args: unknown): string | null {
  switch (name) {
    case "checkin_vendor":
      return checkinVendor(args);
    case "report_volunteer_absent":
      return reportVolunteerAbsent(args);
    case "update_zone_headcount":
      return updateZoneHeadcount(args);
    case "report_incident":
      return reportIncident(args);
    default:
      return null; // not our tool
  }
}
