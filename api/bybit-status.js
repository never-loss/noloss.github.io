// Bybit Cripto status: PAPER default; keysConfigured from env presence only (never values).
// PR1: realAvailable stays false (no signed order route yet). authMode: hmac | none.

function resolveAuthMode(env) {
  const key = env.BYBIT_API_KEY;
  const secret = env.BYBIT_API_SECRET;
  if (!key || String(key).length <= 8) return "none";
  if (!secret || String(secret).length <= 8) return "none";
  return "hmac";
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const authMode = resolveAuthMode(process.env);
  const configured = authMode !== "none";
  // PR1: market + paper only — no bybit-order route; gate REAL off even if keys exist.
  const realAvailable = false;
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    defaultMode: "PAPER",
    keysConfigured: configured,
    realAvailable,
    paperAvailable: true,
    exchange: "bybit",
    authMode,
    envNames: ["BYBIT_API_KEY", "BYBIT_API_SECRET", "BYBIT_BASE_URL"],
    rules: {
      fixedStake: true,
      evidenceGateRequired: true,
      noMartingale: true,
      maxSessionHours: 3,
      stopOnMaxSession: true,
    },
    source: "bybit_linear_usdt",
  });
}
