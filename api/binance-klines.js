// Vercel serverless: proxy de klines Binance Spot (público, sem API keys).
// Útil quando o browser não alcança api.binance.com (geo). Paper only.

const BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
];

const INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d",
]);

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const url = new URL(req.url, "http://localhost");
    const symbol = String(url.searchParams.get("symbol") || "").toUpperCase();
    const interval = String(url.searchParams.get("interval") || "");
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || "500") || 500));
    const endTime = url.searchParams.get("endTime");

    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
      return res.status(400).json({ error: "invalid_symbol" });
    }
    if (!INTERVALS.has(interval)) {
      return res.status(400).json({ error: "invalid_interval" });
    }

    let path =
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    if (endTime && /^\d+$/.test(endTime)) path += `&endTime=${endTime}`;

    let lastErr;
    for (const base of BASES) {
      try {
        const upstream = await fetch(`${base}${path}`);
        const text = await upstream.text();
        if (upstream.ok) {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
          return res.status(200).send(text);
        }
        if (upstream.status === 451 || upstream.status === 403 || upstream.status === 418) {
          lastErr = new Error(`${base} HTTP ${upstream.status}`);
          continue;
        }
        return res.status(upstream.status).send(text);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Binance inacessível");
  } catch (error) {
    return res.status(502).json({
      error: "binance_klines_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
    });
  }
}
