import twilio from "twilio";
import { startTunnel } from "untun";

// ─── Twilio helper (update phone number webhook URL) ──────────────────────────

async function updateTwilioWebhook(webhookUrl: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!sid || !token || !phoneNumber) {
    console.error(
      "[tunnel] Twilio env vars missing — skipping webhook registration."
    );
    return;
  }

  const client = twilio(sid, token);

  // Look up the phone number SID
  const [record] = await client.incomingPhoneNumbers.list({
    phoneNumber,
    limit: 1,
  });

  if (!record) {
    console.error(
      `[tunnel] Could not find Twilio phone number ${phoneNumber} in account.`
    );
    return;
  }

  await client.incomingPhoneNumbers(record.sid).update({
    smsUrl: webhookUrl,
    smsMethod: "POST",
  });

  console.error(`[tunnel] ✅ Twilio webhook registered → ${webhookUrl}`);
}

// ─── Main exported function ───────────────────────────────────────────────────

/**
 * Set up a public URL for the inbound SMS webhook.
 *
 * - If PUBLIC_URL is set in env (production / deployed server), return it as-is.
 * - Otherwise, spin up a Cloudflare Quick Tunnel via `untun`, then automatically
 *   register the live URL with the Twilio phone number so no manual config is needed.
 *
 * @param localPort  The port your local webhook HTTP server is listening on.
 * @returns          The fully-qualified public HTTPS URL (no trailing slash).
 */
export async function setupTunnel(localPort: number): Promise<string> {
  // ── Case 1: Already deployed ──────────────────────────────────────────────
  const existing = process.env.PUBLIC_URL?.trim();
  if (existing) {
    const url = existing.replace(/\/$/, ""); // strip trailing slash
    console.error(`[tunnel] Using PUBLIC_URL from env: ${url}`);
    return url;
  }

  // ── Case 2: Local dev — start a Cloudflare Quick Tunnel ──────────────────
  console.error(
    `[tunnel] No PUBLIC_URL set. Starting Cloudflare Quick Tunnel on port ${localPort}...`
  );

  const tunnel = await startTunnel({
    port: localPort,
    acceptCloudflareNotice: true, // suppress cloudflared's License/Terms/Privacy notices
  });
  if (!tunnel) {
    throw new Error("[tunnel] startTunnel() returned no tunnel object.");
  }

  const tunnelUrl = await tunnel.getURL();

  if (!tunnelUrl) {
    throw new Error("[tunnel] Cloudflare tunnel started but returned no URL.");
  }

  const publicUrl = tunnelUrl.replace(/\/$/, "");
  const webhookEndpoint = `${publicUrl}/webhook/sms`;

  console.error(`[tunnel] 🌐 Public URL: ${publicUrl}`);
  console.error(`[tunnel] 📲 Webhook endpoint: ${webhookEndpoint}`);

  // Register with Twilio automatically
  await updateTwilioWebhook(webhookEndpoint);

  return publicUrl;
}
