// NEVER LOSS — Binance Spot public market data (sem API keys, sem trading).
// exchangeInfo / klines → SymbolInfo / Candle. Só paper / pesquisa.

import type { Candle, SymbolInfo } from "./market-data.ts";

/** Bases públicas (vision evita bloqueios geo em api.binance.com). */
export const BINANCE_PUBLIC_BASES: readonly string[] = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
] as const;

export type BinanceInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "6h"
  | "8h"
  | "12h"
  | "1d";

const GRANULARITY_TO_INTERVAL: Readonly<Record<number, BinanceInterval>> = {
  60: "1m",
  180: "3m",
  300: "5m",
  900: "15m",
  1800: "30m",
  3600: "1h",
  7200: "2h",
  14400: "4h",
  21600: "6h",
  28800: "8h",
  43200: "12h",
  86400: "1d",
};

export function granularityToBinanceInterval(seconds: number): BinanceInterval | null {
  if (!Number.isInteger(seconds) || seconds < 60) return null;
  return GRANULARITY_TO_INTERVAL[seconds] ?? null;
}

export function binanceIntervalToSeconds(interval: string): number | null {
  for (const [sec, label] of Object.entries(GRANULARITY_TO_INTERVAL)) {
    if (label === interval) return Number(sec);
  }
  return null;
}

/** Par Spot cotado em USDT (ex.: BTCUSDT). */
export function isBinanceUsdtSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{2,20}USDT$/.test(symbol);
}

export function binanceBaseAsset(symbol: string): string {
  const m = /^([A-Z0-9]+)USDT$/.exec(symbol);
  return m ? m[1]! : symbol;
}

export type BinanceSymbolsMessage =
  | { kind: "symbols"; items: SymbolInfo[]; skipped: number }
  | { kind: "error"; code: string; message: string }
  | { kind: "invalid"; reason: string };

export type BinanceKlinesMessage =
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

function binanceError(obj: Record<string, unknown>): { kind: "error"; code: string; message: string } | null {
  if (typeof obj.code === "number" && typeof obj.msg === "string") {
    return { kind: "error", code: String(obj.code), message: obj.msg };
  }
  return null;
}

function spotAllowed(e: Record<string, unknown>): boolean {
  if (e.isSpotTradingAllowed === false) return false;
  if (Array.isArray(e.permissions) && e.permissions.length > 0) {
    return e.permissions.includes("SPOT");
  }
  return true;
}

/**
 * Interpreta GET /api/v3/exchangeInfo.
 * Filtra quoteAsset=USDT, status=TRADING, Spot permitido.
 */
export function parseBinanceExchangeInfo(raw: string): BinanceSymbolsMessage {
  const obj = parseObject(raw);
  if (typeof obj === "string") return { kind: "invalid", reason: obj };
  const err = binanceError(obj);
  if (err) return err;
  if (!Array.isArray(obj.symbols)) return { kind: "invalid", reason: "symbols em falta" };

  const items: SymbolInfo[] = [];
  let skipped = 0;
  for (const entry of obj.symbols) {
    if (typeof entry !== "object" || entry === null) {
      skipped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    const symbol = typeof e.symbol === "string" ? e.symbol : null;
    const quote = typeof e.quoteAsset === "string" ? e.quoteAsset : null;
    const status = typeof e.status === "string" ? e.status : null;
    const base = typeof e.baseAsset === "string" ? e.baseAsset : null;
    if (symbol === null || quote !== "USDT" || !isBinanceUsdtSymbol(symbol)) {
      skipped += 1;
      continue;
    }
    if (status !== "TRADING" || !spotAllowed(e)) {
      skipped += 1;
      continue;
    }
    items.push({
      symbol,
      displayName: `${base ?? binanceBaseAsset(symbol)}/USDT (Binance Spot)`,
      market: "cryptocurrency",
      submarket: "binance_usdt",
      open: true,
      suspended: false,
    });
  }
  items.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { kind: "symbols", items, skipped };
}

/**
 * Interpreta GET /api/v3/klines — array de arrays:
 * [ openTime, open, high, low, close, volume, closeTime, ... ]
 * epoch em segundos (openTime ms / 1000), igual ao Candle da Deriv.
 */
export function parseBinanceKlines(raw: string): BinanceKlinesMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "JSON inválido" };
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const err = binanceError(data as Record<string, unknown>);
    if (err) return err;
    return { kind: "invalid", reason: "klines não é um array" };
  }
  if (!Array.isArray(data)) return { kind: "invalid", reason: "klines não é um array" };

  const candles: Candle[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 6) {
      return { kind: "invalid", reason: "vela Binance inválida" };
    }
    const openTimeMs = num(row[0]);
    const open = num(row[1]);
    const high = num(row[2]);
    const low = num(row[3]);
    const close = num(row[4]);
    if (openTimeMs === null || open === null || high === null || low === null || close === null) {
      return { kind: "invalid", reason: "vela Binance com campos em falta ou inválidos" };
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

/** Prefere BTC/ETH/BNB/SOL/… no topo da lista do painel. */
export const BINANCE_PREFERRED_USDT: readonly string[] = [
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

export function sortBinanceUsdtPreferred(items: readonly SymbolInfo[]): SymbolInfo[] {
  const rank = new Map(BINANCE_PREFERRED_USDT.map((s, i) => [s, i]));
  return [...items].sort((a, b) => {
    const ra = rank.has(a.symbol) ? rank.get(a.symbol)! : 1000;
    const rb = rank.has(b.symbol) ? rank.get(b.symbol)! : 1000;
    if (ra !== rb) return ra - rb;
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * GET público com fallback entre bases. Sem headers de autenticação.
 */
export async function binanceFetch(
  pathAndQuery: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ base: string; text: string; status: number }> {
  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  let lastErr: Error | null = null;
  for (const base of BINANCE_PUBLIC_BASES) {
    try {
      const res = await fetchImpl(`${base}${path}`);
      const text = await res.text();
      if (res.ok) return { base, text, status: res.status };
      // 451 geo / 403 — tenta a próxima base
      if (res.status === 451 || res.status === 403 || res.status === 418) {
        lastErr = new Error(`Binance ${res.status} em ${base}`);
        continue;
      }
      return { base, text, status: res.status };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("Binance inacessível");
}

/** Lista pares USDT Spot via exchangeInfo (parse + filtro). */
export async function fetchBinanceUsdtSymbols(
  fetchImpl: typeof fetch = fetch,
): Promise<SymbolInfo[]> {
  const { text, status } = await binanceFetch("/api/v3/exchangeInfo", fetchImpl);
  if (status < 200 || status >= 300) {
    const parsed = parseBinanceExchangeInfo(text);
    if (parsed.kind === "error") throw new Error(`Binance exchangeInfo: ${parsed.code} — ${parsed.message}`);
    throw new Error(`Binance exchangeInfo HTTP ${status}`);
  }
  const msg = parseBinanceExchangeInfo(text);
  if (msg.kind !== "symbols") {
    const why = msg.kind === "error" ? `${msg.code} — ${msg.message}` : msg.reason;
    throw new Error(`Binance exchangeInfo: ${why}`);
  }
  return sortBinanceUsdtPreferred(msg.items);
}

/**
 * Busca até `limit` velas (máx. 1000 por pedido Binance).
 * `endTimeMs` opcional (inclusive) para paginar para trás.
 */
export async function fetchBinanceKlinesPage(
  symbol: string,
  interval: BinanceInterval,
  limit: number,
  endTimeMs?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  if (!isBinanceUsdtSymbol(symbol)) throw new RangeError(`símbolo Binance inválido: ${symbol}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError(`limit inválido: ${limit}`);
  }
  let path =
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  if (endTimeMs !== undefined) {
    if (!Number.isInteger(endTimeMs) || endTimeMs < 0) throw new RangeError(`endTimeMs inválido: ${endTimeMs}`);
    path += `&endTime=${endTimeMs}`;
  }
  const { text, status } = await binanceFetch(path, fetchImpl);
  const msg = parseBinanceKlines(text);
  if (status < 200 || status >= 300 || msg.kind !== "candles") {
    if (msg.kind === "error") throw new Error(`Binance klines: ${msg.code} — ${msg.message}`);
    if (msg.kind === "invalid") throw new Error(`Binance klines: ${msg.reason}`);
    throw new Error(`Binance klines HTTP ${status}`);
  }
  return msg.candles;
}

/**
 * Junta páginas de klines até `target` velas fechadas (mais antigas → mais recentes).
 */
export async function fetchBinanceCandleHistory(
  symbol: string,
  granularitySec: number,
  target: number,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<Candle[]> {
  const interval = granularityToBinanceInterval(granularitySec);
  if (!interval) throw new RangeError(`granularity não suportada na Binance: ${granularitySec}`);
  if (!Number.isInteger(target) || target < 1 || target > 20000) {
    throw new RangeError(`target inválido: ${target}`);
  }

  const byEpoch = new Map<number, Candle>();
  let endTimeMs: number | undefined;
  for (let page = 0; page < 30 && byEpoch.size < target + 5; page++) {
    const batch = await fetchBinanceKlinesPage(symbol, interval, 1000, endTimeMs, fetchImpl);
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
