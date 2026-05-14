import { z } from "zod";
import { getDb } from "../db.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OverdueVendor {
  id: number;
  name: string;
  category: string;
  phone: string;
  expected_checkin: number;
  assigned_zone: string | null;
  delay_until: number | null;
}

interface ZoneStaffRow {
  zone_id: number;
  zone_name: string;
  active_count: number;
  min_volunteers: number;
}

interface Incident {
  id: number;
  description: string;
  zone_name: string | null;
  severity: string;
  status: string;
  created_at: number;
}

interface Volunteer {
  id: number;
  name: string;
  phone: string;
  role: string;
  current_zone: string | null;
  status: string;
}

interface Vendor {
  id: number;
  name: string;
  category: string;
  phone: string;
  expected_checkin: number;
  status: string;
  assigned_zone: string | null;
  delay_until: number | null;
  notes: string | null;
}

interface SmsLog {
  id: number;
  direction: string;
  body: string;
  intent: string | null;
  created_at: number;
}

interface VendorCount {
  total: number;
  checked_in: number;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const queryToolDefinitions = [
  {
    name: "get_overdue_vendors",
    description:
      "Returns all vendors who were expected to check in more than 15 minutes ago and still haven't, excluding those who have sent a delay notice that's still valid.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_understaffed_zones",
    description:
      "Returns all zones where the number of currently active volunteers is below the minimum required. Includes how many more volunteers are needed.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_active_incidents",
    description:
      "Returns all currently open (unresolved) incidents, ordered by severity (high first) then by time reported (oldest first).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_volunteer_availability",
    description:
      "Returns active volunteers. Optionally filter by role. Useful for finding someone to reassign.",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description:
            "Optional role filter (e.g. 'Runner', 'Crowd Control'). Leave blank for all roles.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_event_summary",
    description:
      "Master status tool. Returns a full snapshot of the event: vendor check-in counts, understaffed zones, overdue vendors, and active incidents. Call this at the start of any status check.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_vendor_status",
    description:
      "Returns the full record for a specific vendor, including their complete SMS history.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_id: {
          type: "number",
          description: "The numeric ID of the vendor.",
        },
      },
      required: ["vendor_id"],
    },
  },
];

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const GetVolunteerAvailabilityInput = z.object({
  role: z.string().optional(),
});

const GetVendorStatusInput = z.object({
  vendor_id: z.number().int().positive(),
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

function minutesAgo(unixTs: number): number {
  return Math.floor((Math.floor(Date.now() / 1000) - unixTs) / 60);
}

const SEVERITY_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

// ─── Query Implementations ────────────────────────────────────────────────────

function getOverdueVendors(): string {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 15 * 60; // 15 minutes ago

  const rows = db
    .prepare(
      `SELECT id, name, category, phone, expected_checkin, assigned_zone, delay_until
       FROM vendors
       WHERE status IN ('pending', 'late')
         AND expected_checkin < ?
         AND (delay_until IS NULL OR delay_until < ?)
       ORDER BY expected_checkin ASC`
    )
    .all(cutoff, now) as OverdueVendor[];

  if (rows.length === 0) return "✅ No overdue vendors — everyone is checked in or has sent a delay notice.";

  const lines = rows.map((v) => {
    const minsLate = minutesAgo(v.expected_checkin);
    const zone = v.assigned_zone ?? "unassigned";
    return `• [ID ${v.id}] ${v.name} (${v.category}) — ${minsLate} min overdue | Zone: ${zone} | Phone: ${v.phone}`;
  });

  return `⚠️ ${rows.length} overdue vendor(s):\n${lines.join("\n")}`;
}

function getUnderstaffedZones(): string {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT
         z.id        AS zone_id,
         z.name      AS zone_name,
         z.min_volunteers,
         COUNT(v.id) AS active_count
       FROM zones z
       LEFT JOIN volunteers v
         ON v.current_zone = z.name AND v.status = 'active'
       GROUP BY z.id
       HAVING active_count < z.min_volunteers
       ORDER BY (z.min_volunteers - active_count) DESC`
    )
    .all() as ZoneStaffRow[];

  if (rows.length === 0)
    return "✅ All zones are adequately staffed.";

  const lines = rows.map((r) => {
    const deficit = r.min_volunteers - r.active_count;
    return `• [ID ${r.zone_id}] ${r.zone_name} — ${r.active_count}/${r.min_volunteers} active volunteers (needs ${deficit} more)`;
  });

  return `🔴 ${rows.length} understaffed zone(s):\n${lines.join("\n")}`;
}

function getActiveIncidents(): string {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT i.id, i.description, z.name AS zone_name, i.severity, i.status, i.created_at
       FROM incidents i
       LEFT JOIN zones z ON z.id = i.zone_id
       WHERE i.status = 'open'
       ORDER BY i.created_at ASC`
    )
    .all() as Incident[];

  if (rows.length === 0) return "✅ No active incidents.";

  // Sort by severity desc, then created_at asc (already asc from SQL, re-sort by severity)
  rows.sort(
    (a, b) =>
      (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0)
  );

  const emoji: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };

  const lines = rows.map((i) => {
    const zone = i.zone_name ?? "Unknown";
    const ago = minutesAgo(i.created_at);
    return `• ${emoji[i.severity] ?? "⚪"} [#${i.id}] ${i.severity.toUpperCase()} — ${i.description} | Zone: ${zone} | Reported ${ago} min ago`;
  });

  return `🚨 ${rows.length} active incident(s):\n${lines.join("\n")}`;
}

function getVolunteerAvailability(rawArgs: unknown): string {
  const { role } = GetVolunteerAvailabilityInput.parse(rawArgs);
  const db = getDb();

  let query = `SELECT id, name, phone, role, current_zone, status
               FROM volunteers
               WHERE status = 'active'`;
  const params: string[] = [];

  if (role) {
    query += ` AND LOWER(role) LIKE LOWER(?)`;
    params.push(`%${role}%`);
  }

  query += ` ORDER BY current_zone ASC, name ASC`;

  const rows = db.prepare(query).all(...params) as Volunteer[];

  if (rows.length === 0)
    return `ℹ️ No active volunteers found${role ? ` with role matching "${role}"` : ""}.`;

  const lines = rows.map((v) => {
    const zone = v.current_zone ?? "floating (no zone)";
    return `• [ID ${v.id}] ${v.name} | Role: ${v.role} | Zone: ${zone} | Phone: ${v.phone}`;
  });

  const filter = role ? ` (role: "${role}")` : "";
  return `👥 ${rows.length} available volunteer(s)${filter}:\n${lines.join("\n")}`;
}

function getEventSummary(): string {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Vendor counts
  const vendorCounts = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'checked_in' THEN 1 ELSE 0 END) AS checked_in
       FROM vendors`
    )
    .get() as VendorCount;

  // Overdue vendors
  const cutoff = now - 15 * 60;
  const overdueVendors = db
    .prepare(
      `SELECT id, name, category, expected_checkin
       FROM vendors
       WHERE status IN ('pending', 'late')
         AND expected_checkin < ?
         AND (delay_until IS NULL OR delay_until < ?)`
    )
    .all(cutoff, now) as OverdueVendor[];

  // Understaffed zones
  const understaffed = db
    .prepare(
      `SELECT z.name AS zone_name, z.min_volunteers, COUNT(v.id) AS active_count
       FROM zones z
       LEFT JOIN volunteers v ON v.current_zone = z.name AND v.status = 'active'
       GROUP BY z.id
       HAVING active_count < z.min_volunteers`
    )
    .all() as ZoneStaffRow[];

  // Active incidents
  const incidents = db
    .prepare(
      `SELECT id, description, severity FROM incidents WHERE status = 'open'`
    )
    .all() as Incident[];

  const highIncidents = incidents.filter((i) => i.severity === "high").length;

  // Build summary
  const sections: string[] = [];

  sections.push(
    `📊 EVENT SUMMARY — ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
  );
  sections.push(`─────────────────────────────────`);

  // Vendors
  sections.push(
    `📦 VENDORS: ${vendorCounts.checked_in}/${vendorCounts.total} checked in` +
      (overdueVendors.length > 0
        ? ` | ⚠️ ${overdueVendors.length} overdue`
        : " | ✅ None overdue")
  );

  if (overdueVendors.length > 0) {
    overdueVendors.forEach((v) => {
      sections.push(`   • [ID ${v.id}] ${v.name} — ${minutesAgo(v.expected_checkin)} min overdue`);
    });
  }

  // Zones
  sections.push(
    `🗺️  ZONES: ${understaffed.length > 0 ? `⚠️ ${understaffed.length} understaffed` : "✅ All adequately staffed"}`
  );

  if (understaffed.length > 0) {
    understaffed.forEach((z) => {
      const deficit = z.min_volunteers - z.active_count;
      sections.push(`   • ${z.zone_name} — needs ${deficit} more volunteer(s)`);
    });
  }

  // Incidents
  sections.push(
    `🚨 INCIDENTS: ${incidents.length} open` +
      (highIncidents > 0 ? ` | 🔴 ${highIncidents} HIGH severity` : "")
  );

  if (incidents.length > 0) {
    const emoji: Record<string, string> = { high: "🔴", medium: "🟡", low: "🟢" };
    incidents.forEach((i) => {
      sections.push(`   • ${emoji[i.severity] ?? "⚪"} [#${i.id}] ${i.description.slice(0, 60)}`);
    });
  }

  return sections.join("\n");
}

function getVendorStatus(rawArgs: unknown): string {
  const { vendor_id } = GetVendorStatusInput.parse(rawArgs);
  const db = getDb();

  const vendor = db
    .prepare("SELECT * FROM vendors WHERE id = ?")
    .get(vendor_id) as Vendor | undefined;

  if (!vendor) return `❌ No vendor found with ID ${vendor_id}.`;

  const smsHistory = db
    .prepare(
      `SELECT id, direction, body, intent, created_at
       FROM sms_log
       WHERE phone = ?
       ORDER BY created_at ASC`
    )
    .all(vendor.phone) as SmsLog[];

  const lines: string[] = [];

  lines.push(`📦 VENDOR RECORD — ${vendor.name}`);
  lines.push(`─────────────────────────────────`);
  lines.push(`ID:       ${vendor.id}`);
  lines.push(`Category: ${vendor.category}`);
  lines.push(`Phone:    ${vendor.phone}`);
  lines.push(`Zone:     ${vendor.assigned_zone ?? "unassigned"}`);
  lines.push(`Status:   ${vendor.status.toUpperCase()}`);
  lines.push(`Expected: ${formatTime(vendor.expected_checkin)}`);
  if (vendor.delay_until) {
    lines.push(`Delayed until: ${formatTime(vendor.delay_until)}`);
  }
  if (vendor.notes) {
    lines.push(`Notes:    ${vendor.notes}`);
  }

  if (smsHistory.length === 0) {
    lines.push(`\n📱 SMS History: None`);
  } else {
    lines.push(`\n📱 SMS History (${smsHistory.length} message(s)):`);
    smsHistory.forEach((s) => {
      const dir = s.direction === "outbound" ? "→ OUT" : "← IN ";
      const intent = s.intent ? ` [${s.intent}]` : "";
      lines.push(
        `  ${dir} ${formatTime(s.created_at)}${intent}: ${s.body}`
      );
    });
  }

  return lines.join("\n");
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export function handleQueryTool(name: string, args: unknown): string | null {
  switch (name) {
    case "get_overdue_vendors":
      return getOverdueVendors();
    case "get_understaffed_zones":
      return getUnderstaffedZones();
    case "get_active_incidents":
      return getActiveIncidents();
    case "get_volunteer_availability":
      return getVolunteerAvailability(args);
    case "get_event_summary":
      return getEventSummary();
    case "get_vendor_status":
      return getVendorStatus(args);
    default:
      return null;
  }
}
