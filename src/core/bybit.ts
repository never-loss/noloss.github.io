// NEVER LOSS — Bybit v5 linear USDT perpetual public market data.
// instruments-info / kline via api.bybit.com — no API keys in the browser. Paper by default;
// signed trading stays for a later PR (bybit-trading + api/bybit-order).

import type { Candle, SymbolInfo } from "./market-data.ts";

/** Public Bybit v5 bases (mainnet). Demo/testnet are NOT used with mainnet keys. */
export const BYBIT_PUBLIC_BASES: readonly string[] = [
  "https://api.bybit.com",
  "https://api.bytick.com",
] as const;

export const BYBIT_PATH_INSTRUMENTS = "/v5/market/instruments-info";
export const BYBIT_PATH_KLINE = "/v5/market/kline";

/** Bybit v5 kline interval strings for linear. */
export type BybitInterval =
  | "1"
  | "3"
  | "5"
  | "15"
  | "30"
  | "60"
  | "120"
  | "240"
  | "360"
  | "720"
  | "D";

const GRANULARITY_TO_INTERVAL: Readonly<Record<number, BybitInterval>> = {
  60: "1",
  180: "3",
  300: "5",
  900: "15",
  1800: "30",
  3600: "60",
  7200: "120",
  14400: "240",
  21600: "360",
  43200: "720",
  86400: "D",
};

/** App / Binance-style labels → Bybit interval. */
const LABEL_TO_BYBIT: Readonly<Record<string, BybitInterval>> = {
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

export function granularityToBybitInterval(seconds: number): BybitInterval | null {
  if (!Number.isInteger(seconds) || seconds < 60) return null;
  return GRANULARITY_TO_INTERVAL[seconds] ?? null;
}

export function bybitIntervalToSeconds(interval: string): number | null {
  for (const [sec, label] of Object.entries(GRANULARITY_TO_INTERVAL)) {
    if (label === interval) return Number(sec);
  }
  return null;
}

/** Accept Bybit ("1") or Binance-style ("1m") labels. */
export function toBybitInterval(label: string): BybitInterval | null {
  return LABEL_TO_BYBIT[label] ?? null;
}

/** USDT linear perpetual symbol (e.g. BTCUSDT). */
export function isBybitUsdtSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{2,20}USDT$/.test(symbol);
}

export function bybitBaseAsset(symbol: string): string {
  const m = /^([A-Z0-9]+)USDT$/.exec(symbol);
  return m ? m[1]! : symbol;
}

export type BybitSymbolsMessage =
  | { kind: "symbols"; items: SymbolInfo[]; skipped: number }
  | { kind: "error"; code: string; message: string }
  | { kind: "invalid"; reason: string };

export type BybitKlinesMessage =
  | { kind: "candles"; candles: Candle[] }
  | { kind: "error"; code: string; message: string }
  | { kind: "invalid"; reason: string };

function parseObject(raw: string): Record<string, unknown> | string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "JSON inválido";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "Mensagem não é um objeto";
  }
  return data as Record<string, unknown>;
}

function num(v: unknown): number | null {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

function bybitError(obj: Record<string, unknown>): { kind: "error"; code: string; message: string } | null {
  if (typeof obj.retCode === "number" && obj.retCode !== 0) {
    const msg = typeof obj.retMsg === "string" ? obj.retMsg : "Bybit error";
    return { kind: "error", code: String(obj.retCode), message: msg };
  }
  return null;
}

/**
 * Linear USDT perpetual, Trading, not pre-listing.
 * Matches plan filter: contractType LinearPerpetual, quoteCoin USDT, settleCoin USDT preferred.
 */
export function isLinearUsdtPerpetual(e: Record<string, unknown>): boolean {
  const symbol = typeof e.symbol === "string" ? e.symbol : null;
  if (!symbol || !isBybitUsdtSymbol(symbol)) return false;
  const contractType = typeof e.contractType === "string" ? e.contractType : null;
  if (contractType !== "LinearPerpetual") return false;
  const status = typeof e.status === "string" ? e.status : null;
  if (status !== "Trading") return false;
  const quote = typeof e.quoteCoin === "string" ? e.quoteCoin : null;
  if (quote !== "USDT") return false;
  const settle = typeof e.settleCoin === "string" ? e.settleCoin : null;
  if (settle != null && settle !== "USDT") return false;
  if (e.isPreListing === true) return false;
  return true;
}

/**
 * Parse one page of GET /v5/market/instruments-info (category=linear).
 * Expects Bybit envelope; list may be partial (caller paginates).
 */
export function parseBybitInstrumentsPage(raw: string): BybitSymbolsMessage & { nextCursor?: string } {
  const obj = parseObject(raw);
  if (typeof obj === "string") return { kind: "invalid", reason: obj };
  const err = bybitError(obj);
  if (err) return err;
  const result = obj.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { kind: "invalid", reason: "result em falta" };
  }
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.list)) return { kind: "invalid", reason: "list em falta" };

  const items: SymbolInfo[] = [];
  let skipped = 0;
  for (const entry of r.list) {
    if (typeof entry !== "object" || entry === null) {
      skipped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (!isLinearUsdtPerpetual(e)) {
      skipped += 1;
      continue;
    }
    const symbol = e.symbol as string;
    const base = typeof e.baseCoin === "string" ? e.baseCoin : bybitBaseAsset(symbol);
    items.push({
      symbol,
      displayName: `${base}/USDT (Bybit Linear USDT)`,
      market: "cryptocurrency",
      submarket: "bybit_linear_usdt",
      open: true,
      suspended: false,
    });
  }
  items.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const nextCursor = typeof r.nextPageCursor === "string" && r.nextPageCursor ? r.nextPageCursor : undefined;
  return { kind: "symbols", items, skipped, nextCursor };
}

/** Merge multiple instrument pages into one symbols message. */
export function mergeBybitInstrumentPages(
  pages: readonly (BybitSymbolsMessage & { nextCursor?: string })[],
): BybitSymbolsMessage {
  const bySym = new Map<string, SymbolInfo>();
  let skipped = 0;
  for (const page of pages) {
    if (page.kind === "error") return page;
    if (page.kind === "invalid") return page;
    skipped += page.skipped;
    for (const it of page.items) bySym.set(it.symbol, it);
  }
  const items = [...bySym.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { kind: "symbols", items, skipped };
}

/**
 * Parse GET /v5/market/kline — Bybit list is newest-first; we reverse to oldest-first
 * (same order Binance path / CandlePaperSession expect).
 * Also accepts a bare Binance-style array for compatibility.
 */
export function parseBybitKlines(raw: string): BybitKlinesMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "JSON inválido" };
  }

  // Bare array (normalized proxy or Binance-shaped) — assume oldest-first.
  if (Array.isArray(data)) {
    return parseKlineRows(data, /* alreadyOldestFirst */ true);
  }

  if (typeof data !== "object" || data === null) {
    return { kind: "invalid", reason: "klines não é um objeto" };
  }
  const obj = data as Record<string, unknown>;
  const err = bybitError(obj);
  if (err) return err;
  const result = obj.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { kind: "invalid", reason: "result em falta" };
  }
  const list = (result as Record<string, unknown>).list;
  if (!Array.isArray(list)) return { kind: "invalid", reason: "list em falta" };
  // Bybit: newest first → reverse for oldest-first
  return parseKlineRows([...list].reverse(), true);
}

function parseKlineRows(rows: unknown[], _oldestFirst: boolean): BybitKlinesMessage {
  const candles: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 5) {
      return { kind: "invalid", reason: "vela Bybit inválida" };
    }
    const openTimeMs = num(row[0]);
    const open = num(row[1]);
    const high = num(row[2]);
    const low = num(row[3]);
    const close = num(row[4]);
    if (openTimeMs === null || open === null || high === null || low === null || close === null) {
      return { kind: "invalid", reason: "vela Bybit com campos em falta ou inválidos" };
    }
    if (!Number.isInteger(openTimeMs) || openTimeMs < 0) {
      return { kind: "invalid", reason: "openTime inválido" };
    }
    const epoch = Math.floor(openTimeMs / 1000);
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      return { kind: "invalid", reason: "vela incoerente (máximo/mínimo)" };
    }
    candles.push({ epoch, open, high, low, close });
  }
  return { kind: "candles", candles };
}

/** Preferred majors at top of the Cripto panel list. */
export const BYBIT_PREFERRED_USDT: readonly string[] = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "DOTUSDT",
  "LINKUSDT",
  "LTCUSDT",
  "MATICUSDT",
  "TRXUSDT",
  "ATOMUSDT",
  "NEARUSDT",
  "UNIUSDT",
] as const;

export function sortBybitUsdtPreferred(items: readonly SymbolInfo[]): SymbolInfo[] {
  const rank = new Map(BYBIT_PREFERRED_USDT.map((s, i) => [s, i]));
  return [...items].sort((a, b) => {
    const ra = rank.has(a.symbol) ? rank.get(a.symbol)! : 1000;
    const rb = rank.has(b.symbol) ? rank.get(b.symbol)! : 1000;
    if (ra !== rb) return ra - rb;
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * GET public with base fallback. No auth headers.
 */
export async function bybitFetch(
  pathAndQuery: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ base: string; text: string; status: number }> {
  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  let lastErr: Error | null = null;
  for (const base of BYBIT_PUBLIC_BASES) {
    try {
      const res = await fetchImpl(`${base}${path}`);
      const text = await res.text();
      if (res.ok) return { base, text, status: res.status };
      if (res.status === 403 || res.status === 418 || res.status === 429 || res.status === 451) {
        lastErr = new Error(`Bybit ${res.status} em ${base}`);
        continue;
      }
      return { base, text, status: res.status };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("Bybit inacessível");
}

/** List linear USDT perpetuals (paginated instruments-info). */
export async function fetchBybitUsdtSymbols(
  fetchImpl: typeof fetch = fetch,
): Promise<SymbolInfo[]> {
  const pages: (BybitSymbolsMessage & { nextCursor?: string })[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    let path =
      `${BYBIT_PATH_INSTRUMENTS}?category=linear&status=Trading&limit=500`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;
    const { text, status } = await bybitFetch(path, fetchImpl);
    if (status < 200 || status >= 300) {
      const parsed = parseBybitInstrumentsPage(text);
      if (parsed.kind === "error") throw new Error(`Bybit instruments: ${parsed.code} — ${parsed.message}`);
      throw new Error(`Bybit instruments HTTP ${status}`);
    }
    const page = parseBybitInstrumentsPage(text);
    if (page.kind !== "symbols") {
      const why = page.kind === "error" ? `${page.code} — ${page.message}` : page.reason;
      throw new Error(`Bybit instruments: ${why}`);
    }
    pages.push(page);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const merged = mergeBybitInstrumentPages(pages);
  if (merged.kind !== "symbols") {
    const why = merged.kind === "error" ? `${merged.code} — ${merged.message}` : merged.reason;
    throw new Error(`Bybit instruments: ${why}`);
  }
  return sortBybitUsdtPreferred(merged.items);
}

/**
 * Fetch up to `limit` klines (max 1000). `endTimeMs` maps to Bybit `end`.
 */
export async function fetchBybitKlinesPage(
  symbol: string,
  interval: BybitInterval,
  limit: number,
  endTimeMs?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  if (!isBybitUsdtSymbol(symbol)) throw new RangeError(`símbolo Bybit inválido: ${symbol}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError(`limit inválido: ${limit}`);
  }
  let path =
    `${BYBIT_PATH_KLINE}?category=linear` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  if (endTimeMs !== undefined) {
    if (!Number.isInteger(endTimeMs) || endTimeMs < 0) throw new RangeError(`endTimeMs inválido: ${endTimeMs}`);
    path += `&end=${endTimeMs}`;
  }
  const { text, status } = await bybitFetch(path, fetchImpl);
  const msg = parseBybitKlines(text);
  if (status < 200 || status >= 300 || msg.kind !== "candles") {
    if (msg.kind === "error") throw new Error(`Bybit klines: ${msg.code} — ${msg.message}`);
    if (msg.kind === "invalid") throw new Error(`Bybit klines: ${msg.reason}`);
    throw new Error(`Bybit klines HTTP ${status}`);
  }
  return msg.candles;
}

/**
 * Merge kline pages until `target` closed candles (oldest → newest).
 */
export async function fetchBybitCandleHistory(
  symbol: string,
  granularitySec: number,
  target: number,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<Candle[]> {
  const interval = granularityToBybitInterval(granularitySec);
  if (!interval) throw new RangeError(`granularity não suportada na Bybit: ${granularitySec}`);
  if (!Number.isInteger(target) || target < 1 || target > 20000) {
    throw new RangeError(`target inválido: ${target}`);
  }

  const byEpoch = new Map<number, Candle>();
  let endTimeMs: number | undefined;
  for (let page = 0; page < 30 && byEpoch.size < target + 5; page++) {
    const batch = await fetchBybitKlinesPage(symbol, interval, 1000, endTimeMs, fetchImpl);
    if (batch.length === 0) break;
    for (const c of batch) byEpoch.set(c.epoch, c);
    const oldest = batch.reduce((m, c) => Math.min(m, c.epoch), Infinity);
    const nextEnd = oldest * 1000 - 1;
    if (endTimeMs !== undefined && nextEnd >= endTimeMs) break;
    endTimeMs = nextEnd;
    if (batch.length < 1000) break;
  }

  const nowSec = nowMs / 1000;
  const closed = [...byEpoch.values()]
    .filter((c) => c.epoch + granularitySec <= nowSec)
    .sort((a, b) => a.epoch - b.epoch);
  return closed.slice(-target);
}
