// ─── Types ────────────────────────────────────────────────────────────────────

interface OWMCurrentResponse {
  weather: Array<{ description: string; main: string }>;
  main: { temp: number; feels_like: number; humidity: number };
  wind: { speed: number };
  name: string;
  rain?: { "1h"?: number };
}

interface OWMForecastItem {
  dt: number;
  weather: Array<{ main: string; description: string }>;
  main: { temp: number };
  rain?: { "3h"?: number };
  pop: number; // probability of precipitation 0-1
}

interface OWMForecastResponse {
  list: OWMForecastItem[];
}

export interface WeatherReport {
  location: string;
  condition: string;
  tempC: number;
  feelsLikeC: number;
  humidity: number;
  windKph: number;
  rainExpectedSoon: boolean;
  rainProbabilityPct: number;
  summary: string;
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Fetches current weather + 2-hour rain forecast for a location string.
 * Uses OpenWeatherMap free-tier endpoints (current + 3-hour forecast).
 *
 * @param location  City name or "lat,lon" string, e.g. "Kochi" or "9.93,76.26"
 */
export async function getWeather(location: string): Promise<WeatherReport> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) throw new Error("[weather] OPENWEATHER_API_KEY is missing from env.");

  const base = "https://api.openweathermap.org/data/2.5";
  const units = "metric";

  // Build query param — lat,lon or city name
  const isLatLon = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(location.trim());
  const locationParam = isLatLon
    ? (() => {
        const [lat, lon] = location.split(",");
        return `lat=${lat}&lon=${lon}`;
      })()
    : `q=${encodeURIComponent(location)}`;

  // Fetch current + forecast in parallel
  const [currentRes, forecastRes] = await Promise.all([
    fetch(`${base}/weather?${locationParam}&units=${units}&appid=${apiKey}`),
    fetch(`${base}/forecast?${locationParam}&units=${units}&cnt=2&appid=${apiKey}`),
  ]);

  if (!currentRes.ok) {
    throw new Error(`[weather] Current weather request failed: ${currentRes.status} ${currentRes.statusText}`);
  }

  const current = (await currentRes.json()) as OWMCurrentResponse;
  const forecast = forecastRes.ok
    ? ((await forecastRes.json()) as OWMForecastResponse)
    : null;

  // Current conditions
  const tempC = Math.round(current.main.temp);
  const feelsLikeC = Math.round(current.main.feels_like);
  const humidity = current.main.humidity;
  const windKph = Math.round(current.wind.speed * 3.6); // m/s → km/h
  const condition = current.weather[0]?.description ?? "unknown";

  // Rain in next 2 hours — check the next 2 forecast slots (each = 3h window)
  let rainExpectedSoon = false;
  let maxPop = 0;

  if (forecast?.list) {
    const next2 = forecast.list.slice(0, 2);
    for (const slot of next2) {
      if (slot.pop > maxPop) maxPop = slot.pop;
      const isRain =
        slot.weather[0]?.main === "Rain" ||
        slot.weather[0]?.main === "Thunderstorm" ||
        (slot.rain?.["3h"] ?? 0) > 0;
      if (isRain || slot.pop > 0.4) rainExpectedSoon = true;
    }
  }

  const rainProbabilityPct = Math.round(maxPop * 100);

  // Build a compact summary string for MCP tool output
  const rainNote = rainExpectedSoon
    ? `🌧️ Rain likely in next 2h (${rainProbabilityPct}% chance).`
    : `☀️ No rain expected soon (${rainProbabilityPct}% chance).`;

  const summary =
    `📍 ${current.name} | ${condition} | 🌡️ ${tempC}°C (feels ${feelsLikeC}°C) | ` +
    `💧 ${humidity}% humidity | 💨 ${windKph} km/h wind | ${rainNote}`;

  return {
    location: current.name,
    condition,
    tempC,
    feelsLikeC,
    humidity,
    windKph,
    rainExpectedSoon,
    rainProbabilityPct,
    summary,
  };
}
