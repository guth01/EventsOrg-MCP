import http from "http";
import { getDb } from "./db.js";
import { classifySmsIntent } from "./integrations/gemini.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Vendor {
  id: number;
  name: string;
  phone: string;
  status: string;
}

// ─── DB helpers (mirror the logic from tools/ but callable directly) ──────────

function logInboundSms(phone: string, body: string): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(
      `INSERT INTO sms_log (phone, direction, body, intent, created_at)
       VALUES (?, 'inbound', ?, NULL, ?)`
    )
    .run(phone, body, now) as { lastInsertRowid: number };
  return result.lastInsertRowid;
}

function updateSmsLogIntent(rowId: number, intent: string): void {
  const db = getDb();
  db.prepare(`UPDATE sms_log SET intent = ? WHERE id = ?`).run(intent, rowId);
}

function findVendorByPhone(phone: string): Vendor | undefined {
  const db = getDb();
  return db
    .prepare(`SELECT id, name, phone, status FROM vendors WHERE phone = ?`)
    .get(phone) as Vendor | undefined;
}

function checkinVendorById(vendorId: number): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `UPDATE vendors SET status = 'checked_in', expected_checkin = ? WHERE id = ?`
  ).run(now, vendorId);
}

function acknowledgeDelayById(vendorId: number, delayMinutes: number): void {
  const db = getDb();
  const delayUntil = Math.floor(Date.now() / 1000) + delayMinutes * 60;
  db.prepare(
    `UPDATE vendors SET status = 'delay_acknowledged', delay_until = ? WHERE id = ?`
  ).run(delayUntil, vendorId);
}

function createIncidentFromSms(phone: string, body: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // Find the zone of the vendor/volunteer who sent this
  const vendor = findVendorByPhone(phone);
  const zoneId = vendor
    ? (db
        .prepare(`SELECT id FROM zones WHERE name = (SELECT assigned_zone FROM vendors WHERE id = ?)`)
        .get(vendor.id) as { id: number } | undefined)?.id ?? null
    : null;

  db.prepare(
    `INSERT INTO incidents (description, zone_id, severity, status, created_at)
     VALUES (?, ?, 'medium', 'open', ?)`
  ).run(`Inbound SMS assistance request: "${body}"`, zoneId, now);
}

// ─── Body parser ──────────────────────────────────────────────────────────────

function parseBody(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  // The safest way to parse x-www-form-urlencoded is using the built-in URLSearchParams
  const searchParams = new URLSearchParams(raw);
  for (const [k, v] of searchParams.entries()) {
    params[k] = v;
  }
  return params;
}

// ─── TwiML empty response ─────────────────────────────────────────────────────

function twimlEmpty(res: http.ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
}

// ─── Webhook handler ──────────────────────────────────────────────────────────

async function handleInboundSms(
  body: string,
  from: string
): Promise<void> {
  const smsBody = body.trim();
  const normalizedPhone = from.trim();

  console.error(`[webhook] Inbound SMS from ${normalizedPhone}: "${smsBody}"`);

  // 1. Log to DB immediately
  const rowId = logInboundSms(normalizedPhone, smsBody);

  // 2. Classify via Anthropic
  let classification;
  try {
    classification = await classifySmsIntent(smsBody);
  } catch (err) {
    console.error("[webhook] Gemini classification failed:", err);
    updateSmsLogIntent(rowId, "unknown");
    return;
  }

  const { intent, delay_minutes } = classification;
  console.error(`[webhook] Classified intent: ${intent} | delay_minutes: ${delay_minutes ?? "N/A"}`);

  // 3. Update the sms_log row with intent
  updateSmsLogIntent(rowId, intent);

  // 4. Act on the intent
  const vendor = findVendorByPhone(normalizedPhone);

  switch (intent) {
    case "arrival_delay": {
      if (vendor) {
        const mins = delay_minutes ?? 30; // default 30 if extraction failed
        acknowledgeDelayById(vendor.id, mins);
        console.error(`[webhook] Acknowledged delay for vendor "${vendor.name}" — ${mins} min`);
      } else {
        console.error(`[webhook] No vendor found for phone ${normalizedPhone}, skipping delay ack.`);
      }
      break;
    }

    case "checked_in": {
      if (vendor && vendor.status !== "checked_in") {
        checkinVendorById(vendor.id);
        console.error(`[webhook] Vendor "${vendor.name}" checked in via SMS.`);
      } else if (!vendor) {
        console.error(`[webhook] No vendor found for ${normalizedPhone}, skipping check-in.`);
      }
      break;
    }

    case "need_assistance": {
      createIncidentFromSms(normalizedPhone, smsBody);
      console.error(`[webhook] Incident created from SMS assistance request.`);
      break;
    }

    case "cancellation": {
      if (vendor) {
        // Mark as no_show is the closest status for a cancellation
        const db = getDb();
        db.prepare(`UPDATE vendors SET status = 'no_show' WHERE id = ?`).run(vendor.id);
        console.error(`[webhook] Vendor "${vendor.name}" marked no_show due to cancellation SMS.`);
      }
      break;
    }

    default:
      console.error(`[webhook] Unknown intent — no action taken.`);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

export function startWebhookServer(port: number = 3000): http.Server {
  const server = http.createServer((req, res) => {
    // Only handle POST /webhook/sms
    if (req.method === "POST" && req.url === "/webhook/sms") {
      let rawBody = "";

      req.on("data", (chunk: Buffer) => {
        rawBody += chunk.toString();
      });

      req.on("end", () => {
        const params = parseBody(rawBody);
        const from = params["From"] ?? "";
        const body = params["Body"] ?? "";

        if (!from || !body) {
          console.error("[webhook] Missing From or Body in Twilio payload.");
          twimlEmpty(res);
          return;
        }

        // Process async, but always return TwiML immediately so Twilio doesn't retry
        handleInboundSms(body, from).catch((err) => {
          console.error("[webhook] Unhandled error in handleInboundSms:", err);
        });

        // Return TwiML right away — do not await processing
        twimlEmpty(res);
      });

      req.on("error", (err) => {
        console.error("[webhook] Request error:", err);
        twimlEmpty(res);
      });

      return;
    }

    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "grid-webhook" }));
      return;
    }

    // 404 for everything else
    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, () => {
    console.error(`[webhook] HTTP server listening on port ${port}`);
    console.error(`[webhook] Twilio should POST to http://<your-ngrok-url>/webhook/sms`);
  });

  return server;
}
