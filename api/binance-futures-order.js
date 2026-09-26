// Ordens REAL Binance USDⓈ-M (assinadas no servidor). Omissão / browser sem chaves = bloqueado.
// POST = place MARKET; DELETE = cancel. Porta de evidência obrigatória. Sem martingale.
// Secrets: BINANCE_API_KEY, BINANCE_API_SECRET (opcional BINANCE_FUTURES_BASE_URL).

import { createHmac } from "node:crypto";

const MAX_SESSION_MS = 3 * 60 * 60 * 1000;
const MIN_STAKE = 0.5;

function keysFromEnv(env) {
  const apiKey = env.BINANCE_API_KEY;
  const apiSecret = env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret || String(apiKey).length <= 8 || String(apiSecret).length <= 8) {
    return null;
  }
  const base =
    typeof env.BINANCE_FUTURES_BASE_URL === "string" &&
    /^https:\/\/[a-z0-9.-]+$/i.test(env.BINANCE_FUTURES_BASE_URL.trim())
      ? env.BINANCE_FUTURES_BASE_URL.trim().replace(/\/$/, "")
      : "https://fapi.binance.com";
  return { apiKey: String(apiKey), apiSecret: String(apiSecret), base };
}

function sign(query, secret) {
  return createHmac("sha256", secret).update(query).digest("hex");
}

function buildSignedQuery(params, apiSecret, timestampMs) {
  const entries = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    entries.push([k, String(v)]);
  }
  entries.push(["timestamp", String(timestampMs)]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${query}&signature=${sign(query, apiSecret)}`;
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
        "Modo REAL indisponível: configura BINANCE_API_KEY e BINANCE_API_SECRET no servidor (Vercel env). Omissão = PAPER.",
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

  try {
    if (req.method === "POST") {
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
      const side = String(body.side || "").toUpperCase();
      if (side !== "BUY" && side !== "SELL") {
        return res.status(400).json({ error: "invalid_side" });
      }
      const quantity = Number(body.quantity);
      const stake = Number(body.stake);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return res.status(400).json({ error: "invalid_quantity" });
      }
      if (Number.isFinite(stake) && stake < MIN_STAKE) {
        return res.status(400).json({ error: "stake_below_min", error_description: `Stake mínima ${MIN_STAKE}` });
      }
      // Sem martingale: rejeitar flags de recuperação / multiplicador.
      if (body.martingale === true || body.multiplier != null || body.recovery === true) {
        return res.status(400).json({
          error: "no_martingale",
          error_description: "Martingale / multiplicador / recovery proibidos",
        });
      }

      const query = buildSignedQuery(
        {
          symbol,
          side,
          type: "MARKET",
          quantity,
          recvWindow: 5000,
        },
        creds.apiSecret,
        Date.now(),
      );
      const upstream = await fetch(`${creds.base}/fapi/v1/order?${query}`, {
        method: "POST",
        headers: {
          "X-MBX-APIKEY": creds.apiKey,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      const text = await upstream.text();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      return res.status(upstream.status).send(text);
    }

    // DELETE cancel
    const orderId = body.orderId != null ? Number(body.orderId) : undefined;
    const origClientOrderId = body.origClientOrderId ? String(body.origClientOrderId) : undefined;
    if ((orderId === undefined || !Number.isFinite(orderId)) && !origClientOrderId) {
      return res.status(400).json({ error: "missing_id" });
    }
    const query = buildSignedQuery(
      {
        symbol,
        orderId: Number.isFinite(orderId) ? orderId : undefined,
        origClientOrderId,
        recvWindow: 5000,
      },
      creds.apiSecret,
      Date.now(),
    );
    const upstream = await fetch(`${creds.base}/fapi/v1/order?${query}`, {
      method: "DELETE",
      headers: {
        "X-MBX-APIKEY": creds.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const text = await upstream.text();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(upstream.status).send(text);
  } catch (error) {
    return res.status(502).json({
      error: "binance_futures_order_failed",
      error_description: error && error.message ? String(error.message) : "Erro",
    });
  }
}
