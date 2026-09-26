// Vercel serverless: Bybit v5 linear USDT perpetual instruments (public, no API keys).
// Paginates instruments-info; filters LinearPerpetual USDT Trading.

const BASES = ["https://api.bybit.com", "https://api.bytick.com"];

const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "never-loss/0.1 (bybit-linear; paper)",
};

const PREFERRED = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT",
  "DOGEUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT", "LTCUSDT", "TRXUSDT",
];

async function fetchInstrumentsPage(cursor) {
  let path =
    "/v5/market/instruments-info?category=linear&status=Trading&limit=500";
  if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
  let lastErr;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}${path}`, { headers: FETCH_HEADERS });
      const text = await res.text();
      if (res.ok) {
        if (!text || text.length < 20) {
          lastErr = new Error(`${base} corpo vazio (${text.length} bytes)`);
          continue;
        }
        return text;
      }
      if (res.status === 403 || res.status === 418 || res.status === 429 || res.status === 451) {
        lastErr = new Error(`${base} HTTP ${res.status}`);
        continue;
      }
      throw new Error(`${base} HTTP ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Bybit inacessível");
}

function isLinearUsdtPerp(e) {
  if (!e || typeof e.symbol !== "string") return false;
  if (e.contractType !== "LinearPerpetual") return false;
  if (e.status !== "Trading") return false;
  if (e.quoteCoin !== "USDT") return false;
  if (e.settleCoin != null && e.settleCoin !== "USDT") return false;
  if (e.isPreListing === true) return false;
  if (!/^[A-Z0-9]{2,20}USDT$/.test(e.symbol)) return false;
  return true;
}

function filterPage(raw) {
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object") throw new Error("instruments JSON inválido");
  if (typeof data.retCode === "number" && data.retCode !== 0) {
    throw new Error(`Bybit retCode ${data.retCode}: ${data.retMsg || ""}`);
  }
  const list = data.result && Array.isArray(data.result.list) ? data.result.list : null;
  if (!list) throw new Error("instruments sem list");
  const items = [];
  let skipped = 0;
  for (const e of list) {
    if (!isLinearUsdtPerp(e)) {
      skipped += 1;
      continue;
    }
    const base = e.baseCoin || e.symbol.replace(/USDT$/, "");
    items.push({
      symbol: e.symbol,
      displayName: `${base}/USDT (Bybit Linear USDT)`,
      market: "cryptocurrency",
      submarket: "bybit_linear_usdt",
      open: true,
      suspended: false,
    });
  }
  const nextCursor =
    data.result && typeof data.result.nextPageCursor === "string" && data.result.nextPageCursor
      ? data.result.nextPageCursor
      : "";
  return { items, skipped, nextCursor };
}

async function loadAll() {
  const bySym = new Map();
  let skipped = 0;
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const raw = await fetchInstrumentsPage(cursor || undefined);
    const page = filterPage(raw);
    skipped += page.skipped;
    for (const it of page.items) bySym.set(it.symbol, it);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const rank = new Map(PREFERRED.map((s, i) => [s, i]));
  const items = [...bySym.values()].sort((a, b) => {
    const ra = rank.has(a.symbol) ? rank.get(a.symbol) : 1000;
    const rb = rank.has(b.symbol) ? rank.get(b.symbol) : 1000;
    if (ra !== rb) return ra - rb;
    return a.symbol.localeCompare(b.symbol);
  });
  return {
    items,
    skipped,
    source: "bybit_linear_usdt",
    paperOnlyDefault: true,
    contractType: "LinearPerpetual",
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
    const payload = await loadAll();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(502).json({
      error: "bybit_symbols_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
    });
  }
}
