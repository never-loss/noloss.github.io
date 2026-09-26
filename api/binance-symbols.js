// Vercel serverless: lista compacta de pares USDT Spot (público, sem API keys).
// Filtra exchangeInfo no servidor para não mandar ~17 MB ao browser.

const BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
];

async function fetchExchangeInfo() {
  let lastErr;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/api/v3/exchangeInfo`);
      const text = await res.text();
      if (res.ok) return text;
      if (res.status === 451 || res.status === 403 || res.status === 418) {
        lastErr = new Error(`${base} HTTP ${res.status}`);
        continue;
      }
      throw new Error(`${base} HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Binance inacessível");
}

function filterUsdt(raw) {
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.symbols)) {
    throw new Error("exchangeInfo sem symbols");
  }
  const preferred = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT",
    "DOGEUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT", "LTCUSDT", "TRXUSDT",
  ];
  const rank = new Map(preferred.map((s, i) => [s, i]));
  const items = [];
  let skipped = 0;
  for (const e of data.symbols) {
    if (!e || typeof e.symbol !== "string" || e.quoteAsset !== "USDT") {
      skipped += 1;
      continue;
    }
    if (e.status !== "TRADING") {
      skipped += 1;
      continue;
    }
    if (e.isSpotTradingAllowed === false) {
      skipped += 1;
      continue;
    }
    if (Array.isArray(e.permissions) && e.permissions.length > 0 && !e.permissions.includes("SPOT")) {
      skipped += 1;
      continue;
    }
    if (!/^[A-Z0-9]{2,20}USDT$/.test(e.symbol)) {
      skipped += 1;
      continue;
    }
    items.push({
      symbol: e.symbol,
      displayName: `${e.baseAsset || e.symbol.replace(/USDT$/, "")}/USDT (Binance Spot)`,
      market: "cryptocurrency",
      submarket: "binance_usdt",
      open: true,
      suspended: false,
    });
  }
  items.sort((a, b) => {
    const ra = rank.has(a.symbol) ? rank.get(a.symbol) : 1000;
    const rb = rank.has(b.symbol) ? rank.get(b.symbol) : 1000;
    if (ra !== rb) return ra - rb;
    return a.symbol.localeCompare(b.symbol);
  });
  return { items, skipped, source: "binance_spot", paperOnly: true };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const raw = await fetchExchangeInfo();
    const payload = filterUsdt(raw);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(502).json({
      error: "binance_symbols_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
    });
  }
}
