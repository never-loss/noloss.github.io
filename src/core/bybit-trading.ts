// NEVER LOSS — Bybit v5 linear USDT signed order path (REAL only).
// Keys live in server env only — never in the browser. HMAC-SHA256.
// Rules: fixed stake, evidence gate, no martingale, max 3 h (STOP).

import { createHmac } from "node:crypto";
import { isBybitUsdtSymbol } from "./bybit.ts";
import { MIN_STAKE, MAX_SESSION_MS } from "./paper.ts";

export type TradingMode = "PAPER" | "REAL";

export const DEFAULT_TRADING_MODE: TradingMode = "PAPER";

/** Server env names (Vercel). Never ask the user to paste values in chat. */
export const BYBIT_ENV_KEY_NAMES = {
  apiKey: "BYBIT_API_KEY",
  apiSecret: "BYBIT_API_SECRET",
  /** Optional; default https://api.bybit.com (mainnet — not demo). */
  baseUrl: "BYBIT_BASE_URL",
} as const;

export type AuthMode = "hmac" | "none";

export type BybitOrderSide = "Buy" | "Sell";
export type AppOrderSide = "BUY" | "SELL" | "Buy" | "Sell";

export interface BybitOrderRequest {
  symbol: string;
  side: AppOrderSide;
  /** Base-asset qty; sent to Bybit as string. Fixed stake converted upstream. */
  quantity: number | string;
  evidenceAllowed: boolean;
  mode: TradingMode;
  sessionElapsedMs: number;
  recvWindow?: number;
  /** Optional client order link id. */
  orderLinkId?: string;
  /** Flatten existing position — skips evidence/session open gates. */
  reduceOnly?: boolean;
}

export interface BybitCancelRequest {
  symbol: string;
  orderId?: string;
  orderLinkId?: string;
  mode: TradingMode;
  recvWindow?: number;
}

export type BybitOrderBuildResult =
  | {
      ok: true;
      path: string;
      method: "POST";
      body: string;
      headers: Record<string, string>;
      timestamp: string;
      recvWindow: string;
    }
  | { ok: false; code: string; message: string };

export function normalizeTradingMode(raw: unknown): TradingMode {
  if (typeof raw === "string" && raw.trim().toUpperCase() === "REAL") return "REAL";
  return "PAPER";
}

/** Map app BUY/SELL (or Bybit Buy/Sell) → Bybit side. */
export function toBybitSide(side: unknown): BybitOrderSide | null {
  const s = String(side || "").trim();
  const u = s.toUpperCase();
  if (u === "BUY") return "Buy";
  if (u === "SELL") return "Sell";
  return null;
}

/** Qty as non-empty decimal string (Bybit requires string). */
export function formatBybitQty(quantity: number | string): string | null {
  if (typeof quantity === "string") {
    const t = quantity.trim();
    if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
    if (Number(t) <= 0) return null;
    return t;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  // Avoid scientific notation for typical crypto sizes.
  const s = String(quantity);
  if (/e/i.test(s)) {
    const fixed = quantity.toFixed(12).replace(/\.?0+$/, "");
    return Number(fixed) > 0 ? fixed : null;
  }
  return s;
}

/**
 * Bybit v5 HMAC-SHA256 sign payload:
 *   timestamp + api_key + recv_window + (queryString | jsonBody)
 * → hex lowercase.
 */
export function signBybitV5(
  timestamp: string | number,
  apiKey: string,
  recvWindow: string | number,
  payload: string,
  apiSecret: string,
): string {
  if (!apiSecret) throw new RangeError("apiSecret em falta");
  if (!apiKey) throw new RangeError("apiKey em falta");
  const prehash = `${timestamp}${apiKey}${recvWindow}${payload}`;
  return createHmac("sha256", apiSecret).update(prehash).digest("hex");
}

export function resolveAuthMode(env: { [key: string]: string | undefined }): AuthMode {
  const key = env[BYBIT_ENV_KEY_NAMES.apiKey];
  const secret = env[BYBIT_ENV_KEY_NAMES.apiSecret];
  if (!key || String(key).length <= 8) return "none";
  if (!secret || String(secret).length <= 8) return "none";
  return "hmac";
}

export function keysConfigured(env: { [key: string]: string | undefined }): boolean {
  return resolveAuthMode(env) !== "none";
}

export function bybitBaseUrl(env: { [key: string]: string | undefined }): string {
  const raw = env[BYBIT_ENV_KEY_NAMES.baseUrl];
  if (typeof raw === "string" && /^https:\/\/[a-z0-9.-]+$/i.test(raw.trim())) {
    return raw.trim().replace(/\/$/, "");
  }
  return "https://api.bybit.com";
}

function buildAuthHeaders(
  apiKey: string,
  apiSecret: string,
  bodyOrQuery: string,
  timestampMs: number,
  recvWindow: number,
): { headers: Record<string, string>; timestamp: string; recvWindow: string } {
  const timestamp = String(timestampMs);
  const recv = String(recvWindow);
  const sign = signBybitV5(timestamp, apiKey, recv, bodyOrQuery, apiSecret);
  return {
    timestamp,
    recvWindow: recv,
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": sign,
      "X-BAPI-RECV-WINDOW": recv,
      "Content-Type": "application/json",
    },
  };
}

/**
 * Validates gates and builds POST /v5/order/create (Market, linear).
 * Rejects PAPER, closed evidence gate, invalid qty, session ≥ 3 h, bad symbol.
 */
export function buildPlaceMarketOrder(
  req: BybitOrderRequest,
  apiKey: string,
  apiSecret: string,
  timestampMs: number = Date.now(),
): BybitOrderBuildResult {
  if (req.mode !== "REAL") {
    return { ok: false, code: "paper_mode", message: "Ordens reais só em modo REAL (omissão = PAPER)" };
  }
  const reduceOnly = req.reduceOnly === true;
  if (!reduceOnly && !req.evidenceAllowed) {
    return { ok: false, code: "evidence_gate", message: "Porta de evidência fechada — NO TRADE" };
  }
  if (!isBybitUsdtSymbol(req.symbol)) {
    return { ok: false, code: "invalid_symbol", message: `Símbolo inválido: ${req.symbol}` };
  }
  const side = toBybitSide(req.side);
  if (!side) {
    return { ok: false, code: "invalid_side", message: "side tem de ser Buy/Sell (ou BUY/SELL)" };
  }
  const qty = formatBybitQty(req.quantity);
  if (!qty) {
    return { ok: false, code: "invalid_quantity", message: "quantity inválida (stake fixa > 0)" };
  }
  if (!reduceOnly) {
    if (!Number.isFinite(req.sessionElapsedMs) || req.sessionElapsedMs < 0) {
      return { ok: false, code: "invalid_session", message: "sessionElapsedMs inválido" };
    }
    if (req.sessionElapsedMs >= MAX_SESSION_MS) {
      return { ok: false, code: "max_session", message: "Sessão ≥ 3 h — STOP, sem novas ordens" };
    }
  }
  if (!apiKey || apiKey.length <= 8 || !apiSecret || apiSecret.length <= 8) {
    return { ok: false, code: "keys_missing", message: "BYBIT_API_KEY / BYBIT_API_SECRET em falta" };
  }

  const recvWindow = req.recvWindow ?? 5000;
  const payload: Record<string, string | boolean> = {
    category: "linear",
    symbol: req.symbol,
    side,
    orderType: "Market",
    qty,
  };
  if (reduceOnly) payload.reduceOnly = true;
  if (req.orderLinkId) payload.orderLinkId = String(req.orderLinkId);
  const body = JSON.stringify(payload);
  const auth = buildAuthHeaders(apiKey, apiSecret, body, timestampMs, recvWindow);
  return {
    ok: true,
    path: "/v5/order/create",
    method: "POST",
    body,
    headers: auth.headers,
    timestamp: auth.timestamp,
    recvWindow: auth.recvWindow,
  };
}

export function buildCancelOrder(
  req: BybitCancelRequest,
  apiKey: string,
  apiSecret: string,
  timestampMs: number = Date.now(),
): BybitOrderBuildResult {
  if (req.mode !== "REAL") {
    return { ok: false, code: "paper_mode", message: "Cancelamento real só em modo REAL" };
  }
  if (!isBybitUsdtSymbol(req.symbol)) {
    return { ok: false, code: "invalid_symbol", message: `Símbolo inválido: ${req.symbol}` };
  }
  if (!req.orderId && !req.orderLinkId) {
    return { ok: false, code: "missing_id", message: "orderId ou orderLinkId obrigatório" };
  }
  if (!apiKey || apiKey.length <= 8 || !apiSecret || apiSecret.length <= 8) {
    return { ok: false, code: "keys_missing", message: "BYBIT_API_KEY / BYBIT_API_SECRET em falta" };
  }

  const recvWindow = req.recvWindow ?? 5000;
  const payload: Record<string, string> = {
    category: "linear",
    symbol: req.symbol,
  };
  if (req.orderId) payload.orderId = String(req.orderId);
  if (req.orderLinkId) payload.orderLinkId = String(req.orderLinkId);
  const body = JSON.stringify(payload);
  const auth = buildAuthHeaders(apiKey, apiSecret, body, timestampMs, recvWindow);
  return {
    ok: true,
    path: "/v5/order/cancel",
    method: "POST",
    body,
    headers: auth.headers,
    timestamp: auth.timestamp,
    recvWindow: auth.recvWindow,
  };
}

/** Convert fixed USDT stake → quantity (no leverage / martingale). */
export function quantityFromFixedStake(stakeUsdt: number, price: number, stepSize?: number): number {
  if (!Number.isFinite(stakeUsdt) || stakeUsdt < MIN_STAKE) {
    throw new RangeError(`Stake mínima é ${MIN_STAKE}`);
  }
  if (!Number.isFinite(price) || price <= 0) throw new RangeError(`preço inválido: ${price}`);
  let qty = stakeUsdt / price;
  if (stepSize && stepSize > 0) {
    const steps = Math.floor(qty / stepSize);
    qty = steps * stepSize;
  }
  if (qty <= 0) throw new RangeError("quantity resultante ≤ 0 (stake demasiado pequena para o preço)");
  return qty;
}

/**
 * Execute a signed Bybit request on the server. Never log secrets / sign headers.
 */
export async function executeSignedBybitRequest(
  built: Extract<BybitOrderBuildResult, { ok: true }>,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; text: string }> {
  const url = `${baseUrl}${built.path}`;
  const res = await fetchImpl(url, {
    method: built.method,
    headers: built.headers,
    body: built.body,
  });
  return { status: res.status, text: await res.text() };
}

/** Build alphabetical query string for Bybit v5 signed GET. */
export function bybitQueryString(params: Record<string, string | number | undefined | null>): string {
  const parts: string[] = [];
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${key}=${v}`);
  }
  return parts.join("&");
}

export type BybitSignedGetResult =
  | {
      ok: true;
      path: string;
      method: "GET";
      query: string;
      headers: Record<string, string>;
      timestamp: string;
      recvWindow: string;
    }
  | { ok: false; code: string; message: string };

/**
 * Signed GET (wallet balance, positions, etc.). Never include secrets in returned object beyond headers
 * for server-side fetch — callers must not log headers.
 */
export function buildSignedGet(
  path: string,
  params: Record<string, string | number | undefined | null>,
  apiKey: string,
  apiSecret: string,
  timestampMs: number = Date.now(),
  recvWindow: number = 5000,
): BybitSignedGetResult {
  if (!path || !path.startsWith("/")) {
    return { ok: false, code: "invalid_path", message: "path Bybit inválido" };
  }
  if (!apiKey || apiKey.length <= 8 || !apiSecret || apiSecret.length <= 8) {
    return { ok: false, code: "keys_missing", message: "BYBIT_API_KEY / BYBIT_API_SECRET em falta" };
  }
  const query = bybitQueryString(params);
  const auth = buildAuthHeaders(apiKey, apiSecret, query, timestampMs, recvWindow);
  return {
    ok: true,
    path,
    method: "GET",
    query,
    headers: {
      "X-BAPI-API-KEY": auth.headers["X-BAPI-API-KEY"]!,
      "X-BAPI-TIMESTAMP": auth.headers["X-BAPI-TIMESTAMP"]!,
      "X-BAPI-SIGN": auth.headers["X-BAPI-SIGN"]!,
      "X-BAPI-RECV-WINDOW": auth.headers["X-BAPI-RECV-WINDOW"]!,
    },
    timestamp: auth.timestamp,
    recvWindow: auth.recvWindow,
  };
}

export async function executeSignedBybitGet(
  built: Extract<BybitSignedGetResult, { ok: true }>,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; text: string }> {
  const url = built.query ? `${baseUrl}${built.path}?${built.query}` : `${baseUrl}${built.path}`;
  const res = await fetchImpl(url, { method: "GET", headers: built.headers });
  return { status: res.status, text: await res.text() };
}

export interface BybitWalletCoinSummary {
  coin: string;
  walletBalance: string;
  equity: string;
  usdValue: string;
  unrealisedPnl: string;
}

export interface BybitWalletSummary {
  accountType: string;
  totalEquity: string;
  totalWalletBalance: string;
  totalAvailableBalance: string;
  totalPerpUPL: string;
  totalMarginBalance: string;
  coins: BybitWalletCoinSummary[];
  /** Primary USDT (or first) wallet balance for UI. */
  usdtWalletBalance: string | null;
  usdtEquity: string | null;
}

/**
 * Parse Bybit GET /v5/account/wallet-balance JSON into a safe summary (no secrets).
 */
export function parseBybitWalletBalance(raw: string):
  | { ok: true; summary: BybitWalletSummary }
  | { ok: false; code: string; message: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json", message: "JSON inválido" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, code: "invalid_json", message: "Resposta não é objeto" };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.retCode === "number" && obj.retCode !== 0) {
    const msg = typeof obj.retMsg === "string" ? obj.retMsg : "Bybit error";
    return { ok: false, code: String(obj.retCode), message: msg };
  }
  const result = obj.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { ok: false, code: "invalid_result", message: "result em falta" };
  }
  const list = (result as Record<string, unknown>).list;
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, code: "empty_list", message: "Sem contas na carteira Bybit" };
  }
  const row = list[0] as Record<string, unknown>;
  const coinsRaw = Array.isArray(row.coin) ? row.coin : [];
  const coins: BybitWalletCoinSummary[] = [];
  let usdtWalletBalance: string | null = null;
  let usdtEquity: string | null = null;
  for (const c of coinsRaw) {
    if (typeof c !== "object" || c === null) continue;
    const coin = c as Record<string, unknown>;
    const name = typeof coin.coin === "string" ? coin.coin : "";
    if (!name) continue;
    const entry: BybitWalletCoinSummary = {
      coin: name,
      walletBalance: typeof coin.walletBalance === "string" ? coin.walletBalance : String(coin.walletBalance ?? "0"),
      equity: typeof coin.equity === "string" ? coin.equity : String(coin.equity ?? "0"),
      usdValue: typeof coin.usdValue === "string" ? coin.usdValue : String(coin.usdValue ?? "0"),
      unrealisedPnl: typeof coin.unrealisedPnl === "string" ? coin.unrealisedPnl : String(coin.unrealisedPnl ?? "0"),
    };
    coins.push(entry);
    if (name === "USDT") {
      usdtWalletBalance = entry.walletBalance;
      usdtEquity = entry.equity;
    }
  }
  const str = (v: unknown) => (typeof v === "string" ? v : v != null ? String(v) : "0");
  return {
    ok: true,
    summary: {
      accountType: str(row.accountType || "UNIFIED"),
      totalEquity: str(row.totalEquity),
      totalWalletBalance: str(row.totalWalletBalance),
      totalAvailableBalance: str(row.totalAvailableBalance),
      totalPerpUPL: str(row.totalPerpUPL),
      totalMarginBalance: str(row.totalMarginBalance),
      coins,
      usdtWalletBalance,
      usdtEquity,
    },
  };
}
