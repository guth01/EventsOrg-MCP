/**
 * Quick smoke test — sends a real SMS to yourself.
 * Run with:  npx tsx src/test-sms.ts
 */

import "dotenv/config";
import { initDb } from "./db.js";
import { sendSms } from "./integrations/twilio.js";

initDb();

const TO = "+91"; // ← put your personal mobile number here (the one that receives the SMS)
const BODY = "[GRID 7.0] Twilio integration test — if you got this it works! 🎉";

console.log(`Sending test SMS to ${TO}...`);

sendSms(TO, BODY)
  .then((sid) => {
    console.log(`✅ SMS sent successfully! SID: ${sid}`);
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("❌ SMS failed:", err);
    process.exit(1);
  });
