import { z } from "zod";
import { getDb } from "../db.js";

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
}

interface Incident {
  id: number;
  description: string;
  status: string;
}

interface Vendor {
  id: number;
  name: string;
  phone: string;
  status: string;
  assigned_zone: string | null;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const actionToolDefinitions = [
  {
    name: "reassign_volunteer",
    description:
      "Move a volunteer to a different zone. Updates their zone and status in the database. SMS notification with directions will be sent automatically (coming soon).",
    inputSchema: {
      type: "object",
      properties: {
        volunteer_id: {
          type: "number",
          description: "The numeric ID of the volunteer to reassign.",
        },
        new_zone_id: {
          type: "number",
          description: "The numeric ID of the zone to move the volunteer to.",
        },
      },
      required: ["volunteer_id", "new_zone_id"],
    },
  },
  {
    name: "mark_incident_resolved",
    description:
      "Close an open incident by marking it as resolved. Always include a brief note on how it was resolved.",
    inputSchema: {
      type: "object",
      properties: {
        incident_id: {
          type: "number",
          description: "The numeric ID of the incident to resolve.",
        },
        resolution_note: {
          type: "string",
          description: "A brief description of how the incident was resolved.",
        },
      },
      required: ["incident_id", "resolution_note"],
    },
  },
  {
    name: "acknowledge_vendor_delay",
    description:
      "Mark a vendor as delay-acknowledged and suppress escalation alerts for a set period. Use this when a vendor has contacted you to say they are running late. Prevents the agent from sending repeated SMS alerts for the same vendor.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_id: {
          type: "number",
          description: "The numeric ID of the vendor.",
        },
        delay_minutes: {
          type: "number",
          description:
            "How many minutes from now before the vendor is expected to arrive. Escalation will resume after this window if they still haven't checked in.",
        },
      },
      required: ["vendor_id", "delay_minutes"],
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
  delay_minutes: z.number().int().min(1).max(480), // max 8 hours
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

// ─── Action Implementations ──────────────────────────────────────────────────

function reassignVolunteer(rawArgs: unknown): string {
  const { volunteer_id, new_zone_id } = ReassignVolunteerInput.parse(rawArgs);
  const db = getDb();

  const volunteer = db
    .prepare("SELECT id, name, phone, current_zone, status FROM volunteers WHERE id = ?")
    .get(volunteer_id) as Volunteer | undefined;

  if (!volunteer) return `❌ No volunteer found with ID ${volunteer_id}.`;
  if (volunteer.status === "absent")
    return `❌ ${volunteer.name} is marked absent and cannot be reassigned.`;

  const zone = db
    .prepare("SELECT id, name FROM zones WHERE id = ?")
    .get(new_zone_id) as Zone | undefined;

  if (!zone) return `❌ No zone found with ID ${new_zone_id}.`;

  const previousZone = volunteer.current_zone ?? "no zone";

  db.prepare(
    "UPDATE volunteers SET current_zone = ?, status = 'reassigned' WHERE id = ?"
  ).run(zone.name, volunteer_id);

  // TODO (Day 2): Send Twilio SMS to volunteer.phone with:
  //   - Reassignment notification
  //   - Google Maps walking directions from previousZone to zone.name
  //   - Log the outbound SMS to sms_log table

  return (
    `✅ ${volunteer.name} reassigned from "${previousZone}" → "${zone.name}". ` +
    `DB updated. [SMS + directions pending — Day 2 feature]`
  );
}

function markIncidentResolved(rawArgs: unknown): string {
  const { incident_id, resolution_note } = MarkIncidentResolvedInput.parse(rawArgs);
  const db = getDb();

  const incident = db
    .prepare("SELECT id, description, status FROM incidents WHERE id = ?")
    .get(incident_id) as Incident | undefined;

  if (!incident) return `❌ No incident found with ID ${incident_id}.`;
  if (incident.status === "resolved")
    return `ℹ️ Incident #${incident_id} is already resolved.`;

  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `UPDATE incidents
     SET status = 'resolved', resolved_at = ?, resolution_note = ?
     WHERE id = ?`
  ).run(now, resolution_note, incident_id);

  const preview =
    incident.description.length > 60
      ? incident.description.slice(0, 57) + "..."
      : incident.description;

  return (
    `✅ Incident #${incident_id} marked resolved at ${formatTime(now)}.\n` +
    `Description: "${preview}"\n` +
    `Resolution: "${resolution_note}"`
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
    return `ℹ️ ${vendor.name} has already checked in — no delay to acknowledge.`;
  if (vendor.status === "no_show")
    return `⚠️ ${vendor.name} is marked as no-show. Use check-in tool if they arrive.`;

  const now = Math.floor(Date.now() / 1000);
  const delayUntil = now + delay_minutes * 60;

  db.prepare(
    `UPDATE vendors
     SET status = 'delay_acknowledged', delay_until = ?
     WHERE id = ?`
  ).run(delayUntil, vendor_id);

  const zone = vendor.assigned_zone ?? "unassigned zone";

  return (
    `🕒 Delay acknowledged for "${vendor.name}" (${zone}).\n` +
    `Expected arrival: ${formatTime(delayUntil)} (${delay_minutes} min from now).\n` +
    `Escalation alerts suppressed until then. If they don't check in by ${formatTime(delayUntil)}, alerts will resume automatically.`
  );
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export function handleActionTool(name: string, args: unknown): string | null {
  switch (name) {
    case "reassign_volunteer":
      return reassignVolunteer(args);
    case "mark_incident_resolved":
      return markIncidentResolved(args);
    case "acknowledge_vendor_delay":
      return acknowledgeVendorDelay(args);
    default:
      return null;
  }
}
