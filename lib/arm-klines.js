// Fetch Bybit linear klines (server-side) for cloud arm advance.
const BASES = ["https://api.bybit.com", "https://api.bytick.com"];
const FETCH_HEADERS = {
  Accept: "application/json",
  "User-Agent": "never-loss/0.1 (cloud-arm-paper)",
};

const GRAN_TO_INTERVAL = {
  60: "1",
  300: "5",
  900: "15",
  3600: "60",
};

function parseList(list) {
  // Bybit returns newest-first rows: [start, open, high, low, close, ...]
  const candles = [];
  for (const row of list || []) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const startMs = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    if (![startMs, open, high, low, close].every(Number.isFinite)) continue;
    candles.push({
      epoch: Math.floor(startMs / 1000),
      open,
      high,
      low,
      close,
    });
  }
  candles.sort((a, b) => a.epoch - b.epoch);
  return candles;
}

async function fetchPage(symbol, interval, limit, endMs) {
  let path =
    `/v5/market/kline?category=linear` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  if (endMs) path += `&end=${endMs}`;
  let lastErr;
  for (const base of BASES) {
    try {
      const upstream = await fetch(`${base}${path}`, { headers: FETCH_HEADERS });
      const text = await upstream.text();
      if (!upstream.ok) {
        lastErr = new Error(`${base} HTTP ${upstream.status}`);
        continue;
      }
      const json = JSON.parse(text);
      if (Number(json.retCode) !== 0) {
        lastErr = new Error(json.retMsg || "bybit_error");
        continue;
      }
      return parseList(json.result && json.result.list);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("bybit_klines_failed");
}

/** Oldest→newest, up to `target` candles. */
export async function fetchArmCandleHistory(symbol, granularitySec, target = 1500) {
  const interval = GRAN_TO_INTERVAL[granularitySec];
  if (!interval) throw new RangeError("intervalo inválido");
  const pages = [];
  let endMs = "";
  let guard = 0;
  while (guard++ < 8) {
    const page = await fetchPage(symbol, interval, Math.min(1000, target), endMs);
    if (!page.length) break;
    pages.push(page);
    const oldest = page.reduce((m, c) => Math.min(m, c.epoch), Infinity);
    endMs = String(oldest * 1000 - 1);
    const merged = mergeAsc(pages);
    if (merged.length >= target || page.length < 500) break;
  }
  return mergeAsc(pages).slice(-target);
}

function mergeAsc(pages) {
  const map = new Map();
  for (const page of pages) {
    for (const c of page) map.set(c.epoch, c);
  }
  return [...map.values()].sort((a, b) => a.epoch - b.epoch);
}
