// Vercel serverless: lista compacta de perpetual USDT-M (público, sem API keys).
// Filtra exchangeInfo no servidor para não mandar o JSON completo ao browser.

const BASES = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
];

async function fetchExchangeInfo() {
  let lastErr;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/fapi/v1/exchangeInfo`);
      const text = await res.text();
      if (res.ok) return text;
      if (res.status === 451 || res.status === 403 || res.status === 418 || res.status === 429) {
        lastErr = new Error(`${base} HTTP ${res.status}`);
        continue;
      }
      throw new Error(`${base} HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Binance Futures inacessível");
}

function filterUsdtmPerp(raw) {
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
    if (e.contractType !== "PERPETUAL") {
      skipped += 1;
      continue;
    }
    if (e.status !== "TRADING") {
      skipped += 1;
      continue;
    }
    if (!/^[A-Z0-9]{2,20}USDT$/.test(e.symbol)) {
      skipped += 1;
      continue;
    }
    items.push({
      symbol: e.symbol,
      displayName: `${e.baseAsset || e.symbol.replace(/USDT$/, "")}/USDT (Binance Futures USDT-M)`,
      market: "cryptocurrency",
      submarket: "binance_usdtm",
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
  return {
    items,
    skipped,
    source: "binance_usdtm_futures",
    paperOnlyDefault: true,
    contractType: "PERPETUAL",
  };
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
    const payload = filterUsdtmPerp(raw);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(502).json({
      error: "binance_futures_symbols_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
    });
  }
}
