import { GoogleGenAI } from "@google/genai";

// ─── Intent types ─────────────────────────────────────────────────────────────

export type SmsIntent =
  | "arrival_delay"
  | "checked_in"
  | "need_assistance"
  | "cancellation"
  | "unknown";

export interface ClassificationResult {
  intent: SmsIntent;
  delay_minutes: number | null;
}

// ─── Lazy client ──────────────────────────────────────────────────────────────

let _ai: GoogleGenAI | null = null;

function getAi(): GoogleGenAI {
  if (!_ai) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error("[gemini] GOOGLE_API_KEY is missing from env.");
    }
    _ai = new GoogleGenAI({ apiKey });
  }
  return _ai;
}

// ─── Classification prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are classifying an SMS reply from an event vendor or volunteer.
Classify the intent as one of: arrival_delay, checked_in, need_assistance, cancellation, unknown.
If arrival_delay, extract the number of minutes from the message (estimate if vague, e.g. "30 mins" = 30, "an hour" = 60, "soon" = 15).
Reply ONLY with valid JSON in exactly this format — no extra text, no markdown:
{"intent":"<intent>","delay_minutes":<number or null>}`;

// ─── Main classify function ───────────────────────────────────────────────────

/**
 * Classify the intent of an inbound SMS using Gemini.
 *
 * @param smsBody  The raw text body of the inbound SMS
 * @returns        Parsed classification result
 */
export async function classifySmsIntent(
  smsBody: string
): Promise<ClassificationResult> {
  const ai = getAi();

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash", // Fast and cost-efficient for classification
    contents: smsBody,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const raw = response.text;
  if (!raw) {
    return { intent: "unknown", delay_minutes: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("[gemini] Failed to parse JSON response:", raw);
    // Graceful fallback — don't crash the webhook
    return { intent: "unknown", delay_minutes: null };
  }

  const obj = parsed as Record<string, unknown>;
  const intent = (obj.intent as SmsIntent) ?? "unknown";
  const delay_minutes =
    typeof obj.delay_minutes === "number" ? obj.delay_minutes : null;

  return { intent, delay_minutes };
}
