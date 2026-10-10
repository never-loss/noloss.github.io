// Shared Bybit v5 linear market order helpers (HMAC signed).
// Used by api/bybit-order.js and api/bybit-arm.js REAL cloud mirroring.
// Never log apiKey / apiSecret values.

import { createHmac } from "node:crypto";

const MIN_STAKE = 0.5;

export function bybitBase(env = process.env) {
  return typeof env.BYBIT_BASE_URL === "string" &&
    /^https:\/\/[a-z0-9.-]+$/i.test(env.BYBIT_BASE_URL.trim())
    ? env.BYBIT_BASE_URL.trim().replace(/\/$/, "")
    : "https://api.bybit.com";
}

/**
 * @returns {{ apiKey: string, apiSecret: string, base: string } | null}
 */
export function keysFromEnv(env = process.env) {
  const apiKey = env.BYBIT_API_KEY;
  const apiSecret = env.BYBIT_API_SECRET;
  if (!apiKey || String(apiKey).length <= 8) return null;
  if (!apiSecret || String(apiSecret).length <= 8) return null;
  return { apiKey: String(apiKey), apiSecret: String(apiSecret), base: bybitBase(env) };
}

export function hasBybitKeys(env = process.env) {
  return keysFromEnv(env) != null;
}

function signBybitV5(timestamp, apiKey, recvWindow, payload, apiSecret) {
  const prehash = `${timestamp}${apiKey}${recvWindow}${payload}`;
  return createHmac("sha256", apiSecret).update(prehash).digest("hex");
}

export function toBybitSide(side) {
  const u = String(side || "").trim().toUpperCase();
  if (u === "BUY") return "Buy";
  if (u === "SELL") return "Sell";
  return null;
}

export function formatQty(quantity) {
  if (typeof quantity === "string") {
    const t = quantity.trim();
    if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
    if (Number(t) <= 0) return null;
    return t;
  }
  const n = Number(quantity);
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = String(n);
  if (/e/i.test(s)) {
    const fixed = n.toFixed(12).replace(/\.?0+$/, "");
    return Number(fixed) > 0 ? fixed : null;
  }
  return s;
}

/** Fixed USDT stake → qty string (no leverage / martingale). */
export function quantityFromFixedStake(stakeUsdt, price) {
  const s = Number(stakeUsdt);
  const px = Number(price);
  if (!Number.isFinite(s) || s < MIN_STAKE) throw new RangeError(`Stake mínima ${MIN_STAKE}`);
  if (!Number.isFinite(px) || px <= 0) throw new RangeError("Preço inválido para qty");
  const qty = s / px;
  const raw = qty.toFixed(8).replace(/\.?0+$/, "");
  if (!raw || Number(raw) <= 0) throw new RangeError("quantity resultante ≤ 0");
  return raw;
}

function authHeaders(apiKey, apiSecret, body, timestampMs, recvWindow) {
  const timestamp = String(timestampMs);
  const recv = String(recvWindow);
  const sign = signBybitV5(timestamp, apiKey, recv, body, apiSecret);
  return {
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-SIGN": sign,
    "X-BAPI-RECV-WINDOW": recv,
    "Content-Type": "application/json",
  };
}

/**
 * Place a linear USDT market order on Bybit.
 * @param {{ symbol: string, side: "BUY"|"SELL"|string, quantity: string|number, reduceOnly?: boolean, orderLinkId?: string }} opts
 * @returns {Promise<{ ok: boolean, status: number, body: any, text: string, error?: string }>}
 */
export async function placeLinearMarketOrder(opts, env = process.env, fetchImpl = fetch) {
  const creds = keysFromEnv(env);
  if (!creds) {
    return { ok: false, status: 503, body: { error: "keys_missing" }, text: "", error: "keys_missing" };
  }
  const symbol = String(opts.symbol || "").toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
    return { ok: false, status: 400, body: { error: "invalid_symbol" }, text: "", error: "invalid_symbol" };
  }
  const side = toBybitSide(opts.side);
  if (!side) {
    return { ok: false, status: 400, body: { error: "invalid_side" }, text: "", error: "invalid_side" };
  }
  const qty = formatQty(opts.quantity);
  if (!qty) {
    return { ok: false, status: 400, body: { error: "invalid_quantity" }, text: "", error: "invalid_quantity" };
  }
  const payload = {
    category: "linear",
    symbol,
    side,
    orderType: "Market",
    qty,
  };
  if (opts.reduceOnly === true) payload.reduceOnly = true;
  if (opts.orderLinkId) payload.orderLinkId = String(opts.orderLinkId);
  const jsonBody = JSON.stringify(payload);
  const headers = authHeaders(creds.apiKey, creds.apiSecret, jsonBody, Date.now(), 5000);
  try {
    const upstream = await fetchImpl(`${creds.base}/v5/order/create`, {
      method: "POST",
      headers,
      body: jsonBody,
    });
    const text = await upstream.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* raw */ }
    const retOk = body == null || body.retCode === 0 || body.retCode === "0";
    return {
      ok: upstream.ok && retOk,
      status: upstream.status,
      body,
      text,
      error: !retOk ? ((body && body.retMsg) || "bybit_ret") : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      status: 502,
      body: null,
      text: "",
      error: e && e.message ? String(e.message) : "bybit_order_failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Medição do custo REAL (só leitura, depois da ordem). NUNCA bloqueia nem altera a colocação da ordem:
// qualquer falha devolve { ok:false, error } e quem chama segue em frente.
// ---------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Resume as execuções (/v5/execution/list) de UMA ordem num preenchimento médio, com a taxa paga
 * e a derrapagem vs preço do sinal (positivo = pior para nós).
 * @param {any[]} rows linhas de result.list
 * @param {{ side: "BUY"|"SELL", signalPrice: number, symbol: string, key: string, action: "open"|"close", at?: number, orderId?: string }} ctx
 * @returns {object|null} RealFill (ver src/core/trade-cost.ts) ou null se não houver execuções válidas
 */
export function summarizeExecutions(rows, ctx) {
  let qty = 0;
  let notional = 0;
  let fee = 0;
  let n = 0;
  let makers = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object") continue;
    if (r.execType != null && String(r.execType) !== "Trade") continue; // ignora Funding / ADL / etc.
    if (ctx.orderId && r.orderId != null && String(r.orderId) !== String(ctx.orderId)) continue;
    const px = num(r.execPrice);
    const q = num(r.execQty);
    const f = num(r.execFee);
    if (!(px > 0) || !(q > 0) || !Number.isFinite(f)) continue;
    qty += q;
    notional += px * q;
    fee += f;
    n += 1;
    if (r.isMaker === true || r.isMaker === "true") makers += 1;
  }
  if (n === 0 || !(qty > 0)) return null;
  const avgPrice = notional / qty;
  const signal = num(ctx.signalPrice);
  if (!(signal > 0)) return null;
  const dir = ctx.side === "BUY" ? 1 : -1;
  const slipFrac = (dir * (avgPrice - signal)) / signal;
  const feeFrac = fee / notional;
  return {
    key: ctx.key,
    action: ctx.action,
    side: ctx.side,
    symbol: ctx.symbol,
    signalPrice: signal,
    avgPrice,
    qty,
    execFee: fee,
    feeFrac,
    slipFrac,
    costFrac: feeFrac + slipFrac,
    execs: n,
    makerExecs: makers,
    at: ctx.at ?? Date.now(),
    source: "execution/list",
  };
}

/**
 * GET /v5/execution/list (assinado) para uma ordem. Nunca lança.
 * @returns {Promise<{ ok: boolean, rows?: any[], error?: string }>}
 */
export async function fetchOrderExecutions(opts, env = process.env, fetchImpl = fetch, tools = {}) {
  const sleep = tools.sleep || defaultSleep;
  const attempts = Math.max(1, Math.min(4, tools.attempts ?? 3));
  const delayMs = tools.delayMs ?? 400;
  const timeoutMs = tools.timeoutMs ?? 4000;
  try {
    const creds = keysFromEnv(env);
    if (!creds) return { ok: false, error: "keys_missing" };
    const symbol = String(opts.symbol || "").toUpperCase();
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return { ok: false, error: "invalid_symbol" };
    if (!opts.orderId && !opts.orderLinkId) return { ok: false, error: "missing_order_id" };
    let query = `category=linear&symbol=${encodeURIComponent(symbol)}&limit=50`;
    if (opts.orderId) query += `&orderId=${encodeURIComponent(String(opts.orderId))}`;
    else query += `&orderLinkId=${encodeURIComponent(String(opts.orderLinkId))}`;
    const started = Date.now();
    let lastErr = "no_executions";
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        if (Date.now() - started + delayMs > timeoutMs) break;
        await sleep(delayMs);
      }
      const headers = authHeaders(creds.apiKey, creds.apiSecret, query, Date.now(), 5000);
      delete headers["Content-Type"];
      const upstream = await fetchImpl(`${creds.base}/v5/execution/list?${query}`, { method: "GET", headers });
      const text = await upstream.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* raw */ }
      if (!upstream.ok) { lastErr = `http_${upstream.status}`; continue; }
      if (!body || (body.retCode !== 0 && body.retCode !== "0")) { lastErr = (body && body.retMsg) || "bybit_ret"; continue; }
      const list = body.result && Array.isArray(body.result.list) ? body.result.list : [];
      if (list.length) return { ok: true, rows: list };
      lastErr = "no_executions";
    }
    return { ok: false, error: lastErr };
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : "execution_read_failed" };
  }
}

/**
 * Depois de uma ordem aceite: lê as execuções e calcula taxa + derrapagem vs preço do sinal.
 * Nunca lança e nunca altera a ordem. `orderRes` = devolução de placeLinearMarketOrder.
 * @returns {Promise<{ ok: true, fill: object } | { ok: false, error: string }>}
 */
export async function measureOrderFill(orderRes, ctx, env = process.env, fetchImpl = fetch, tools = {}) {
  try {
    if (!orderRes || !orderRes.ok) return { ok: false, error: "order_not_ok" };
    if (!(Number(ctx && ctx.signalPrice) > 0)) return { ok: false, error: "signal_price_missing" };
    const orderId = orderRes.body && orderRes.body.result && orderRes.body.result.orderId;
    const orderLinkId = (orderRes.body && orderRes.body.result && orderRes.body.result.orderLinkId) || ctx.orderLinkId;
    const ex = await fetchOrderExecutions({ symbol: ctx.symbol, orderId, orderLinkId }, env, fetchImpl, tools);
    if (!ex.ok) return { ok: false, error: ex.error || "execution_read_failed" };
    const fill = summarizeExecutions(ex.rows, { ...ctx, orderId: orderId || undefined });
    if (!fill) return { ok: false, error: "no_valid_executions" };
    return { ok: true, fill };
  } catch (e) {
    return { ok: false, error: e && e.message ? String(e.message) : "measure_failed" };
  }
}

export { MIN_STAKE };
