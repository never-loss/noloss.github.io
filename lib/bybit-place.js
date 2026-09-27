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

export { MIN_STAKE };
