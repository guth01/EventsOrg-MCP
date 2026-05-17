import { google } from "googleapis";
import { getDb } from "../db.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface VendorRow {
  id: number;
  name: string;
  category: string;
  assigned_zone: string | null;
  status: string;
  expected_checkin: number;
  delay_until: number | null;
}

interface ZoneRow {
  id: number;
  name: string;
  type: string;
  capacity: number;
  current_headcount: number;
  volunteer_count: number;
  min_volunteers: number;
}

interface IncidentRow {
  id: number;
  description: string;
  zone_name: string | null;
  severity: string;
  status: string;
  created_at: number;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

function getAuth() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (credJson) {
    // Credentials passed as an inline JSON string in env
    const credentials = JSON.parse(credJson) as object;
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }

  if (keyFile) {
    return new google.auth.GoogleAuth({
      keyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }

  throw new Error(
    "[sheets] Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path) or GOOGLE_SERVICE_ACCOUNT_JSON (inline) in env."
  );
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function ts(unix: number): string {
  return new Date(unix * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true,
    dateStyle: "short",
    timeStyle: "short",
  });
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Writes three ranges to the configured Google Sheet:
 *   - Sheet1: Vendor statuses
 *   - Sheet2: Zone headcounts + volunteer counts
 *   - Sheet3: Open incidents
 *
 * The spreadsheet ID is read from GOOGLE_SHEET_ID env var.
 */
export async function syncToSheets(): Promise<string> {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error("[sheets] GOOGLE_SHEET_ID is missing from env.");
  }

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const db = getDb();
  const updatedAt = ts(Math.floor(Date.now() / 1000));

  // ── 1. Vendors ──────────────────────────────────────────────────────────────
  const vendors = db
    .prepare(
      `SELECT id, name, category, assigned_zone, status, expected_checkin, delay_until
       FROM vendors ORDER BY category, name`
    )
    .all() as VendorRow[];

  const vendorRows: (string | number)[][] = [
    ["VENDOR STATUS DASHBOARD — Updated: " + updatedAt],
    [],
    ["ID", "Name", "Category", "Zone", "Status", "Expected Check-in", "Delay Until"],
    ...vendors.map((v) => [
      v.id,
      v.name,
      v.category,
      v.assigned_zone ?? "—",
      v.status.toUpperCase(),
      ts(v.expected_checkin),
      v.delay_until ? ts(v.delay_until) : "—",
    ]),
  ];

  // ── 2. Zones ─────────────────────────────────────────────────────────────────
  const zones = db
    .prepare(
      `SELECT z.id, z.name, z.type, z.capacity, z.current_headcount, z.min_volunteers,
              COUNT(v.id) AS volunteer_count
       FROM zones z
       LEFT JOIN volunteers v ON v.current_zone = z.name AND v.status IN ('active','reassigned')
       GROUP BY z.id
       ORDER BY z.name`
    )
    .all() as ZoneRow[];

  const zoneRows: (string | number)[][] = [
    ["ZONE STATUS DASHBOARD — Updated: " + updatedAt],
    [],
    ["ID", "Zone", "Type", "Headcount", "Capacity", "% Full", "Volunteers", "Min Required", "Staffed?"],
    ...zones.map((z) => {
      const pct = z.capacity > 0 ? ((z.current_headcount / z.capacity) * 100).toFixed(0) + "%" : "—";
      const staffed = z.volunteer_count >= z.min_volunteers ? "✅ Yes" : "⚠️ No";
      return [z.id, z.name, z.type, z.current_headcount, z.capacity, pct, z.volunteer_count, z.min_volunteers, staffed];
    }),
  ];

  // ── 3. Incidents ─────────────────────────────────────────────────────────────
  const incidents = db
    .prepare(
      `SELECT i.id, i.description, z.name AS zone_name, i.severity, i.status, i.created_at
       FROM incidents i
       LEFT JOIN zones z ON z.id = i.zone_id
       ORDER BY CASE i.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.created_at`
    )
    .all() as IncidentRow[];

  const incidentRows: (string | number)[][] = [
    ["INCIDENT LOG — Updated: " + updatedAt],
    [],
    ["ID", "Description", "Zone", "Severity", "Status", "Reported At"],
    ...incidents.map((i) => [
      i.id,
      i.description,
      i.zone_name ?? "—",
      i.severity.toUpperCase(),
      i.status.toUpperCase(),
      ts(i.created_at),
    ]),
  ];

  // ── Batch write all three ranges ────────────────────────────────────────────
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: "Vendors!A1", values: vendorRows },
        { range: "Zones!A1",   values: zoneRows },
        { range: "Incidents!A1", values: incidentRows },
      ],
    },
  });

  return (
    `✅ Google Sheet synced at ${updatedAt}.\n` +
    `  • Vendors: ${vendors.length} rows\n` +
    `  • Zones:   ${zones.length} rows\n` +
    `  • Incidents: ${incidents.length} rows`
  );
}
