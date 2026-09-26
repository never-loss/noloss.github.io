// Vercel serverless: proxy Bybit v5 linear klines (public, no API keys).
// Accepts Bybit intervals ("1") or Binance-style ("1m"). Returns Bybit envelope
// (list newest-first); client/core reverses to oldest-first.

const BASES = ["https://api.bybit.com", "https://api.bytick.com"];

const LABEL_TO_BYBIT = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "2h": "120",
  "4h": "240",
  "6h": "360",
  "12h": "720",
  "1d": "D",
  D: "D",
  "1": "1",
  "3": "3",
  "5": "5",
  "15": "15",
  "30": "30",
  "60": "60",
  "120": "120",
  "240": "240",
  "360": "360",
  "720": "720",
};

const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "never-loss/0.1 (bybit-linear; paper)",
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
    const intervalRaw = String(url.searchParams.get("interval") || "");
    const interval = LABEL_TO_BYBIT[intervalRaw] || null;
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || "500") || 500));
    // Accept end (Bybit) or endTime (Binance-style rewrite from core).
    const end =
      url.searchParams.get("end") ||
      url.searchParams.get("endTime") ||
      "";

    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
      return res.status(400).json({ error: "invalid_symbol" });
    }
    if (!interval) {
      return res.status(400).json({ error: "invalid_interval" });
    }

    let path =
      `/v5/market/kline?category=linear` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    if (end && /^\d+$/.test(end)) path += `&end=${end}`;

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
        if (upstream.status === 403 || upstream.status === 418 || upstream.status === 429 || upstream.status === 451) {
          lastErr = new Error(`${base} HTTP ${upstream.status}`);
          continue;
        }
        return res.status(upstream.status).send(text);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Bybit inacessível");
  } catch (error) {
    return res.status(502).json({
      error: "bybit_klines_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
    });
  }
}
