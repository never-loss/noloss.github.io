// Vercel serverless: proxy de klines Binance USDⓈ-M Futures (público, sem API keys).
// Útil quando o browser não alcança fapi.binance.com (geo). Paper / dados.

const BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];

const INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d",
]);

const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "never-loss/0.1 (futures-usdtm; paper)",
};

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
      `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    if (endTime && /^\d+$/.test(endTime)) path += `&endTime=${endTime}`;

    let lastErr;
    for (const base of BASES) {
      try {
        const upstream = await fetch(`${base}${path}`, { headers: FETCH_HEADERS });
        const text = await upstream.text();
        if (upstream.ok) {
          if (!text || text.length < 2) {
            lastErr = new Error(`${base} corpo vazio`);
            continue;
          }
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
          return res.status(200).send(text);
        }
        if (upstream.status === 451 || upstream.status === 403 || upstream.status === 418 || upstream.status === 429) {
          lastErr = new Error(`${base} HTTP ${upstream.status}`);
          continue;
        }
        return res.status(upstream.status).send(text);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Binance Futures inacessível");
  } catch (error) {
    return res.status(502).json({
      error: "binance_futures_klines_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
    });
  }
}
