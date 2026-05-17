// ─── Types ────────────────────────────────────────────────────────────────────

export interface DirectionsResult {
  /** Short human-readable route summary, e.g. "via Main St" */
  summary: string;
  /** Total walking distance as a human string, e.g. "450 m" */
  distance: string;
  /** Estimated walking time in minutes (integer) */
  durationMinutes: number;
  /** Up to 5 turn-by-turn steps, HTML stripped, with distance */
  steps: string[];
  /** Full formatted string ready to paste into an SMS */
  smsText: string;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Get walking directions between two locations using the Google Maps Directions API.
 *
 * @param origin       Starting point — place name, address, or "lat,lon"
 * @param destination  End point — same formats accepted
 * @returns            Structured directions result including an SMS-ready string
 */
export async function getDirections(
  origin: string,
  destination: string
): Promise<DirectionsResult> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("[maps] GOOGLE_MAPS_API_KEY is missing from env.");

  const params = new URLSearchParams({
    origin,
    destination,
    mode: "walking",
    key: apiKey,
  });

  const res = await fetch(
    `https://maps.googleapis.com/maps/api/directions/json?${params}`
  );

  if (!res.ok) {
    throw new Error(`[maps] Directions API request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    status: string;
    routes: Array<{
      summary: string;
      legs: Array<{
        distance: { text: string };
        duration: { text: string; value: number };
        steps: Array<{
          html_instructions: string;
          distance: { text: string };
        }>;
      }>;
    }>;
  };

  if (data.status !== "OK" || !data.routes[0]) {
    throw new Error(`[maps] Directions unavailable — API status: ${data.status}`);
  }

  const route = data.routes[0];
  const leg = route.legs[0];
  const durationMinutes = Math.ceil(leg.duration.value / 60);

  const steps = leg.steps
    .slice(0, 5)
    .map(
      (step, i) =>
        `${i + 1}. ${stripHtml(step.html_instructions)} (${step.distance.text})`
    );

  const smsText =
    `🗺️ Walk to ${destination}\n` +
    `${leg.distance.text} · ~${durationMinutes} min\n` +
    steps.join("\n");

  return {
    summary: route.summary,
    distance: leg.distance.text,
    durationMinutes,
    steps,
    smsText,
  };
}
