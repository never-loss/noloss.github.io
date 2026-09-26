// Public Bybit leverage range for one linear USDT symbol (instruments-info leverageFilter).
// GET ?symbol=BTCUSDT — no keys. Viewing only; stake fixa no app (não multiplica stake).

const BASES = ["https://api.bybit.com", "https://api.bytick.com"];
const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "never-loss/0.1 (bybit-leverage; paper)",
};

function isUsdt(sym) {
  return /^[A-Z0-9]{2,20}USDT$/.test(sym);
}

function num(v) {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

async function fetchInstrument(symbol) {
  const path = `/v5/market/instruments-info?category=linear&symbol=${encodeURIComponent(symbol)}`;
  let lastErr;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}${path}`, { headers: FETCH_HEADERS });
      const text = await res.text();
      if (res.ok && text && text.length > 20) return text;
      if (res.status === 403 || res.status === 418 || res.status === 429 || res.status === 451) {
        lastErr = new Error(`${base} HTTP ${res.status}`);
        continue;
      }
      throw new Error(`${base} HTTP ${res.status}: ${text.slice(0, 180)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Bybit inacessível");
}

function parseLeverage(raw, symbol) {
  const data = JSON.parse(raw);
  if (typeof data.retCode === "number" && data.retCode !== 0) {
    throw new Error(`Bybit retCode ${data.retCode}: ${data.retMsg || ""}`);
  }
  const list = data.result && Array.isArray(data.result.list) ? data.result.list : null;
  if (!list || !list.length) throw new Error("Instrumento não encontrado");
  let entry = list.find((e) => e && e.symbol === symbol) || list[0];
  if (!entry || !entry.leverageFilter) throw new Error("leverageFilter em falta");
  const f = entry.leverageFilter;
  const minLeverage = num(f.minLeverage);
  const maxLeverage = num(f.maxLeverage);
  const leverageStep = num(f.leverageStep);
  if (minLeverage == null || maxLeverage == null || leverageStep == null) {
    throw new Error("leverageFilter inválido");
  }
  if (minLeverage <= 0 || maxLeverage < minLeverage || leverageStep <= 0) {
    throw new Error("limites de alavancagem incoerentes");
  }
  // Prefer 1x when allowed, else min (conservative).
  let defaultLeverage = Math.max(minLeverage, Math.min(1, maxLeverage));
  if (defaultLeverage < minLeverage) defaultLeverage = minLeverage;
  if (defaultLeverage > maxLeverage) defaultLeverage = maxLeverage;
  return {
    symbol: entry.symbol || symbol,
    minLeverage,
    maxLeverage,
    leverageStep,
    defaultLeverage,
    contractType: entry.contractType || null,
    status: entry.status || null,
    note:
      "Alavancagem disponível no par. NEVER LOSS usa stake fixa em USDT (não multiplica stake). Predefinição conservadora = 1x (ou mínimo do par).",
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

  const rawSym = typeof req.query?.symbol === "string" ? req.query.symbol.trim().toUpperCase() : "";
  if (!isUsdt(rawSym)) {
    return res.status(400).json({
      error: "invalid_symbol",
      error_description: "symbol obrigatório (ex.: BTCUSDT)",
    });
  }

  try {
    const text = await fetchInstrument(rawSym);
    const info = parseLeverage(text, rawSym);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      ok: true,
      exchange: "bybit",
      source: "bybit_instruments_leverage",
      ...info,
    });
  } catch (error) {
    return res.status(502).json({
      error: "bybit_leverage_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
      symbol: rawSym,
    });
  }
}
