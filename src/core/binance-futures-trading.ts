// NEVER LOSS — caminho de ordens Binance USDⓈ-M Futures (assinado).
// Só para modo REAL explícito. Chaves NUNCA no browser: vivem em env do servidor.
// Regras: stake fixa, porta de evidência obrigatória, sem martingale, máx. 3 h (STOP).
// Auth: Ed25519 (PKCS8 PEM) preferido — sem IP fixo no Vercel; HMAC como fallback.

import { createHmac, createPrivateKey, sign } from "node:crypto";
import { isBinanceUsdtSymbol } from "./binance.ts";
import { MIN_STAKE, MAX_SESSION_MS } from "./paper.ts";

export type TradingMode = "PAPER" | "REAL";

export const DEFAULT_TRADING_MODE: TradingMode = "PAPER";

/** Nomes de secrets / env no servidor (Vercel / Cloudflare). Não pedir ao utilizador no chat. */
export const BINANCE_ENV_KEY_NAMES = {
  apiKey: "BINANCE_API_KEY",
  apiSecret: "BINANCE_API_SECRET",
  /** PEM PKCS8 Ed25519 (-----BEGIN PRIVATE KEY-----). Preferido vs HMAC. */
  apiPrivateKey: "BINANCE_API_PRIVATE_KEY",
  /** Opcional: base fapi (default https://fapi.binance.com). */
  baseUrl: "BINANCE_FUTURES_BASE_URL",
} as const;

export type AuthMode = "ed25519" | "hmac" | "none";

export type SignMaterial =
  | { mode: "hmac"; secret: string }
  | { mode: "ed25519"; privateKeyPem: string };

export type OrderSide = "BUY" | "SELL";

export interface FuturesOrderRequest {
  symbol: string;
  side: OrderSide;
  /** Quantidade em contratos / base asset. Stake fixa convertida no servidor. */
  quantity: number;
  /** MARKET only nesta fase (sem limit/stop complexos). */
  type?: "MARKET";
  /** Porta de evidência tem de estar aberta. */
  evidenceAllowed: boolean;
  /** Modo tem de ser REAL. */
  mode: TradingMode;
  /** Duração da sessão já decorrida (ms) — rejeita se >= 3 h. */
  sessionElapsedMs: number;
  recvWindow?: number;
}

export interface FuturesCancelRequest {
  symbol: string;
  orderId?: number;
  origClientOrderId?: string;
  mode: TradingMode;
  recvWindow?: number;
}

export type OrderBuildResult =
  | { ok: true; query: string; path: string; method: "POST" | "DELETE" }
  | { ok: false; code: string; message: string };

export function normalizeTradingMode(raw: unknown): TradingMode {
  if (typeof raw === "string" && raw.trim().toUpperCase() === "REAL") return "REAL";
  return "PAPER";
}

/** Normaliza PEM: escapes `\n` literais → newlines reais (comum em env Vercel). */
export function normalizePem(raw: string): string {
  return String(raw)
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();
}

/** Deteta PEM PKCS8 / Ed25519 (após normalizar escapes). */
export function looksLikePem(raw: string | undefined | null): boolean {
  if (raw == null || typeof raw !== "string") return false;
  const n = normalizePem(raw);
  return (
    n.includes("-----BEGIN PRIVATE KEY-----") ||
    n.includes("-----BEGIN ED25519 PRIVATE KEY-----")
  );
}

/** HMAC-SHA256 hex (assinatura REST Binance legada). */
export function signBinanceQuery(query: string, apiSecret: string): string {
  if (!apiSecret) throw new RangeError("apiSecret em falta");
  return createHmac("sha256", apiSecret).update(query).digest("hex");
}

/**
 * Ed25519: assina os bytes UTF-8 da query string; encoding base64 (Binance).
 * Chave: PKCS8 PEM (`-----BEGIN PRIVATE KEY-----`).
 */
export function signBinanceQueryEd25519(query: string, privateKeyPem: string): string {
  const pem = normalizePem(privateKeyPem);
  if (!looksLikePem(pem)) throw new RangeError("privateKeyPem inválido (espera PKCS8 PEM)");
  const key = createPrivateKey(pem);
  return sign(null, Buffer.from(query, "utf8"), key).toString("base64");
}

export function signWithMaterial(query: string, material: SignMaterial): string {
  if (material.mode === "ed25519") {
    return signBinanceQueryEd25519(query, material.privateKeyPem);
  }
  return signBinanceQuery(query, material.secret);
}

/** string → HMAC, ou Ed25519 se o valor parecer PEM. */
export function coerceSignMaterial(secretOrMaterial: string | SignMaterial): SignMaterial {
  if (typeof secretOrMaterial !== "string") return secretOrMaterial;
  if (looksLikePem(secretOrMaterial)) {
    return { mode: "ed25519", privateKeyPem: secretOrMaterial };
  }
  return { mode: "hmac", secret: secretOrMaterial };
}

/**
 * Resolve material de assinatura a partir do env.
 * Preferência: BINANCE_API_PRIVATE_KEY → secret que parece PEM → HMAC secret.
 */
export function resolveSignMaterial(env: { [key: string]: string | undefined }): SignMaterial | null {
  const pem = env[BINANCE_ENV_KEY_NAMES.apiPrivateKey];
  if (pem && looksLikePem(pem) && normalizePem(pem).length > 32) {
    return { mode: "ed25519", privateKeyPem: pem };
  }
  const secret = env[BINANCE_ENV_KEY_NAMES.apiSecret];
  if (secret && looksLikePem(secret) && normalizePem(secret).length > 32) {
    return { mode: "ed25519", privateKeyPem: secret };
  }
  if (secret && String(secret).length > 8 && !looksLikePem(secret)) {
    return { mode: "hmac", secret: String(secret) };
  }
  return null;
}

export function resolveAuthMode(env: { [key: string]: string | undefined }): AuthMode {
  const key = env[BINANCE_ENV_KEY_NAMES.apiKey];
  if (!key || String(key).length <= 8) return "none";
  const material = resolveSignMaterial(env);
  if (!material) return "none";
  return material.mode;
}

export function buildSignedQuery(
  params: Record<string, string | number | boolean | undefined>,
  secretOrMaterial: string | SignMaterial,
  timestampMs: number = Date.now(),
): string {
  const material = coerceSignMaterial(secretOrMaterial);
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    entries.push([k, String(v)]);
  }
  entries.push(["timestamp", String(timestampMs)]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const signature = signWithMaterial(query, material);
  // Base64 (Ed25519) tem +/= ; hex (HMAC) fica intacto.
  return `${query}&signature=${encodeURIComponent(signature)}`;
}

/**
 * Valida e monta POST /fapi/v1/order (MARKET).
 * Rejeita PAPER, porta fechada, martingale implícito (qty ≤ 0), sessão > 3 h, símbolo inválido.
 */
export function buildPlaceMarketOrder(
  req: FuturesOrderRequest,
  secretOrMaterial: string | SignMaterial,
  timestampMs: number = Date.now(),
): OrderBuildResult {
  if (req.mode !== "REAL") {
    return { ok: false, code: "paper_mode", message: "Ordens reais só em modo REAL (omissão = PAPER)" };
  }
  if (!req.evidenceAllowed) {
    return { ok: false, code: "evidence_gate", message: "Porta de evidência fechada — NO TRADE" };
  }
  if (!isBinanceUsdtSymbol(req.symbol)) {
    return { ok: false, code: "invalid_symbol", message: `Símbolo inválido: ${req.symbol}` };
  }
  if (req.side !== "BUY" && req.side !== "SELL") {
    return { ok: false, code: "invalid_side", message: "side tem de ser BUY ou SELL" };
  }
  if (!Number.isFinite(req.quantity) || req.quantity <= 0) {
    return { ok: false, code: "invalid_quantity", message: "quantity inválida (stake fixa > 0)" };
  }
  if (!Number.isFinite(req.sessionElapsedMs) || req.sessionElapsedMs < 0) {
    return { ok: false, code: "invalid_session", message: "sessionElapsedMs inválido" };
  }
  if (req.sessionElapsedMs >= MAX_SESSION_MS) {
    return { ok: false, code: "max_session", message: "Sessão ≥ 3 h — STOP, sem novas ordens" };
  }
  const type = req.type ?? "MARKET";
  if (type !== "MARKET") {
    return { ok: false, code: "unsupported_type", message: "Só MARKET nesta fase" };
  }
  const recvWindow = req.recvWindow ?? 5000;
  const query = buildSignedQuery(
    {
      symbol: req.symbol,
      side: req.side,
      type: "MARKET",
      quantity: req.quantity,
      recvWindow,
    },
    secretOrMaterial,
    timestampMs,
  );
  return { ok: true, query, path: "/fapi/v1/order", method: "POST" };
}

export function buildCancelOrder(
  req: FuturesCancelRequest,
  secretOrMaterial: string | SignMaterial,
  timestampMs: number = Date.now(),
): OrderBuildResult {
  if (req.mode !== "REAL") {
    return { ok: false, code: "paper_mode", message: "Cancelamento real só em modo REAL" };
  }
  if (!isBinanceUsdtSymbol(req.symbol)) {
    return { ok: false, code: "invalid_symbol", message: `Símbolo inválido: ${req.symbol}` };
  }
  if (req.orderId === undefined && !req.origClientOrderId) {
    return { ok: false, code: "missing_id", message: "orderId ou origClientOrderId obrigatório" };
  }
  const recvWindow = req.recvWindow ?? 5000;
  const query = buildSignedQuery(
    {
      symbol: req.symbol,
      orderId: req.orderId,
      origClientOrderId: req.origClientOrderId,
      recvWindow,
    },
    secretOrMaterial,
    timestampMs,
  );
  return { ok: true, query, path: "/fapi/v1/order", method: "DELETE" };
}

/** Converte stake USDT aproximada → quantity (sem alavancagem implícita / martingale). */
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

/** true se API key + (PEM Ed25519 OU secret HMAC) estiverem configurados. */
export function keysConfigured(env: { [key: string]: string | undefined }): boolean {
  return resolveAuthMode(env) !== "none";
}

export function futuresBaseUrl(env: { [key: string]: string | undefined }): string {
  const raw = env[BINANCE_ENV_KEY_NAMES.baseUrl];
  if (typeof raw === "string" && /^https:\/\/[a-z0-9.-]+$/i.test(raw.trim())) {
    return raw.trim().replace(/\/$/, "");
  }
  return "https://fapi.binance.com";
}

/**
 * Executa pedido assinado no servidor. Nunca logar secrets / PEM.
 */
export async function executeSignedFuturesRequest(
  built: Extract<OrderBuildResult, { ok: true }>,
  apiKey: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; text: string }> {
  const url = `${baseUrl}${built.path}?${built.query}`;
  const res = await fetchImpl(url, {
    method: built.method,
    headers: {
      "X-MBX-APIKEY": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  return { status: res.status, text: await res.text() };
}
