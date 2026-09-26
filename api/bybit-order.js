// REAL Bybit v5 linear orders (HMAC signed on server). Default / browser without keys = blocked.
// POST = place Market; DELETE (or POST action=cancel) = cancel. Evidence gate required. No martingale.
// Keep in sync with src/core/bybit-trading.ts — never log secrets.

import { createHmac } from "node:crypto";

const MAX_SESSION_MS = 3 * 60 * 60 * 1000;
const MIN_STAKE = 0.5;

function bybitBase(env) {
  return typeof env.BYBIT_BASE_URL === "string" &&
    /^https:\/\/[a-z0-9.-]+$/i.test(env.BYBIT_BASE_URL.trim())
    ? env.BYBIT_BASE_URL.trim().replace(/\/$/, "")
    : "https://api.bybit.com";
}

/**
 * @returns {{ apiKey: string, apiSecret: string, base: string } | null}
 * Never log apiSecret / apiKey values.
 */
function keysFromEnv(env) {
  const apiKey = env.BYBIT_API_KEY;
  const apiSecret = env.BYBIT_API_SECRET;
  if (!apiKey || String(apiKey).length <= 8) return null;
  if (!apiSecret || String(apiSecret).length <= 8) return null;
  return { apiKey: String(apiKey), apiSecret: String(apiSecret), base: bybitBase(env) };
}

function signBybitV5(timestamp, apiKey, recvWindow, payload, apiSecret) {
  const prehash = `${timestamp}${apiKey}${recvWindow}${payload}`;
  return createHmac("sha256", apiSecret).update(prehash).digest("hex");
}

function toBybitSide(side) {
  const u = String(side || "").trim().toUpperCase();
  if (u === "BUY") return "Buy";
  if (u === "SELL") return "Sell";
  return null;
}

function formatQty(quantity) {
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON inválido"));
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST" && req.method !== "DELETE") {
    res.setHeader("Allow", "POST, DELETE, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const creds = keysFromEnv(process.env);
  if (!creds) {
    return res.status(503).json({
      error: "keys_missing",
      error_description:
        "Modo REAL indisponível: configura BYBIT_API_KEY e BYBIT_API_SECRET no servidor (Vercel env). Omissão = PAPER.",
    });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return res.status(400).json({ error: "invalid_body", error_description: String(e.message || e) });
  }

  const mode = String(body.mode || "").toUpperCase();
  if (mode !== "REAL") {
    return res.status(403).json({
      error: "paper_mode",
      error_description: "Ordens reais só com mode=REAL. Omissão do painel = PAPER / SIMULADO.",
    });
  }

  const symbol = String(body.symbol || "").toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
    return res.status(400).json({ error: "invalid_symbol" });
  }

  const isCancel =
    req.method === "DELETE" ||
    String(body.action || "").toLowerCase() === "cancel";

  try {
    if (!isCancel) {
      const reduceOnly = body.reduceOnly === true;
      // Opens require evidence + session < 3h. reduceOnly closes may flatten even if gate closed / session long.
      if (!reduceOnly) {
        if (body.evidenceAllowed !== true) {
          return res.status(403).json({
            error: "evidence_gate",
            error_description: "Porta de evidência fechada — NO TRADE",
          });
        }
        const sessionElapsedMs = Number(body.sessionElapsedMs || 0);
        if (!Number.isFinite(sessionElapsedMs) || sessionElapsedMs < 0) {
          return res.status(400).json({ error: "invalid_session" });
        }
        if (sessionElapsedMs >= MAX_SESSION_MS) {
          return res.status(403).json({
            error: "max_session",
            error_description: "Sessão ≥ 3 h — STOP, sem novas ordens",
          });
        }
      }
      const side = toBybitSide(body.side);
      if (!side) {
        return res.status(400).json({ error: "invalid_side" });
      }
      const qty = formatQty(body.quantity);
      if (!qty) {
        return res.status(400).json({ error: "invalid_quantity" });
      }
      const stake = Number(body.stake);
      if (!reduceOnly && Number.isFinite(stake) && stake < MIN_STAKE) {
        return res.status(400).json({
          error: "stake_below_min",
          error_description: `Stake mínima ${MIN_STAKE}`,
        });
      }
      // No martingale: reject recovery / multiplier flags.
      if (body.martingale === true || body.multiplier != null || body.recovery === true) {
        return res.status(400).json({
          error: "no_martingale",
          error_description: "Martingale / multiplicador / recovery proibidos",
        });
      }

      const payload = {
        category: "linear",
        symbol,
        side,
        orderType: "Market",
        qty,
      };
      if (reduceOnly) payload.reduceOnly = true;
      if (body.orderLinkId) payload.orderLinkId = String(body.orderLinkId);
      const jsonBody = JSON.stringify(payload);
      const headers = authHeaders(creds.apiKey, creds.apiSecret, jsonBody, Date.now(), 5000);
      const upstream = await fetch(`${creds.base}/v5/order/create`, {
        method: "POST",
        headers,
        body: jsonBody,
      });
      const text = await upstream.text();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      return res.status(upstream.status).send(text);
    }

    // Cancel
    const orderId = body.orderId != null ? String(body.orderId) : undefined;
    const orderLinkId = body.orderLinkId ? String(body.orderLinkId) : undefined;
    if (!orderId && !orderLinkId) {
      return res.status(400).json({ error: "missing_id" });
    }
    const payload = { category: "linear", symbol };
    if (orderId) payload.orderId = orderId;
    if (orderLinkId) payload.orderLinkId = orderLinkId;
    const jsonBody = JSON.stringify(payload);
    const headers = authHeaders(creds.apiKey, creds.apiSecret, jsonBody, Date.now(), 5000);
    const upstream = await fetch(`${creds.base}/v5/order/cancel`, {
      method: "POST",
      headers,
      body: jsonBody,
    });
    const text = await upstream.text();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(upstream.status).send(text);
  } catch (error) {
    return res.status(502).json({
      error: "bybit_order_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
    });
  }
}
