import twilio from "twilio";
import { getDb } from "../db.js";

// ─── Lazy client (only constructed on first use) ──────────────────────────────
let _client: ReturnType<typeof twilio> | null = null;

function getClient(): ReturnType<typeof twilio> {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error(
        "[twilio] TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is missing from env."
      );
    }
    _client = twilio(sid, token);
  }
  return _client;
}

// ─── Core send function ───────────────────────────────────────────────────────

/**
 * Send an outbound SMS via Twilio and log it to sms_log.
 *
 * @param to   E.164 phone number, e.g. "+919400722621"
 * @param body SMS text content
 * @returns    Twilio message SID on success
 */
export async function sendSms(to: string, body: string): Promise<string> {
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) {
    throw new Error("[twilio] TWILIO_PHONE_NUMBER is missing from env.");
  }

  const client = getClient();

  // Fire the message
  const message = await client.messages.create({ to, from, body });

  // Persist to sms_log
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO sms_log (phone, direction, body, intent, created_at)
     VALUES (?, 'outbound', ?, NULL, ?)`
  ).run(to, body, now);

  console.error(`[twilio] SMS sent → ${to} | SID: ${message.sid}`);
  return message.sid;
}
