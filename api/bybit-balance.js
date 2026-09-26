// Bybit UNIFIED wallet balance (signed). Never log secrets / sign headers.
// GET only. Returns safe summary for UI — PAPER context always available; balance needs keys.

import { createHmac } from "node:crypto";

function bybitBase(env) {
  return typeof env.BYBIT_BASE_URL === "string" &&
    /^https:\/\/[a-z0-9.-]+$/i.test(env.BYBIT_BASE_URL.trim())
    ? env.BYBIT_BASE_URL.trim().replace(/\/$/, "")
    : "https://api.bybit.com";
}

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

function queryString(params) {
  return Object.keys(params)
    .sort()
    .filter((k) => params[k] != null && params[k] !== "")
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

function parseSummary(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_json", message: "JSON inválido" };
  }
  if (!data || typeof data !== "object") {
    return { ok: false, code: "invalid_json", message: "Resposta não é objeto" };
  }
  if (typeof data.retCode === "number" && data.retCode !== 0) {
    return {
      ok: false,
      code: String(data.retCode),
      message: typeof data.retMsg === "string" ? data.retMsg : "Bybit error",
    };
  }
  const list = data.result && Array.isArray(data.result.list) ? data.result.list : null;
  if (!list || !list.length) {
    return { ok: false, code: "empty_list", message: "Sem contas na carteira Bybit" };
  }
  const row = list[0];
  const coins = [];
  let usdtWalletBalance = null;
  let usdtEquity = null;
  for (const c of Array.isArray(row.coin) ? row.coin : []) {
    if (!c || typeof c.coin !== "string") continue;
    const entry = {
      coin: c.coin,
      walletBalance: String(c.walletBalance ?? "0"),
      equity: String(c.equity ?? "0"),
      usdValue: String(c.usdValue ?? "0"),
      unrealisedPnl: String(c.unrealisedPnl ?? "0"),
    };
    coins.push(entry);
    if (c.coin === "USDT") {
      usdtWalletBalance = entry.walletBalance;
      usdtEquity = entry.equity;
    }
  }
  const str = (v) => (v == null ? "0" : String(v));
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const creds = keysFromEnv(process.env);
  if (!creds) {
    return res.status(503).json({
      error: "keys_missing",
      error_description:
        "Saldo Bybit indisponível: configura BYBIT_API_KEY e BYBIT_API_SECRET no servidor (Vercel). Nunca no browser.",
      keysConfigured: false,
      paperAvailable: true,
      exchange: "bybit",
    });
  }

  const accountType = "UNIFIED";
  const coin =
    typeof req.query?.coin === "string" && /^[A-Z0-9]{2,10}$/.test(req.query.coin.trim().toUpperCase())
      ? req.query.coin.trim().toUpperCase()
      : "USDT";
  const params = { accountType, coin };
  const qs = queryString(params);
  const timestamp = String(Date.now());
  const recvWindow = "5000";
  const sign = signBybitV5(timestamp, creds.apiKey, recvWindow, qs, creds.apiSecret);
  // Never log apiKey / apiSecret / sign
  const url = `${creds.base}/v5/account/wallet-balance?${qs}`;

  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": creds.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-SIGN": sign,
        "X-BAPI-RECV-WINDOW": recvWindow,
      },
    });
    const text = await upstream.text();
    const parsed = parseSummary(text);
    res.setHeader("Cache-Control", "no-store");
    if (!parsed.ok) {
      const status = upstream.status >= 400 ? upstream.status : 502;
      return res.status(status).json({
        error: "bybit_balance_failed",
        error_description: parsed.message,
        code: parsed.code,
        keysConfigured: true,
        exchange: "bybit",
        accountType,
      });
    }
    return res.status(200).json({
      ok: true,
      keysConfigured: true,
      exchange: "bybit",
      accountType,
      source: "bybit_wallet_unified",
      label: "REAL · Bybit UNIFIED",
      paperNote: "PAPER = simulado local; este saldo é a carteira real Bybit (só leitura).",
      ...parsed.summary,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({
      error: "bybit_balance_upstream",
      error_description: e && e.message ? String(e.message) : "Erro de rede Bybit",
      keysConfigured: true,
      exchange: "bybit",
    });
  }
}
