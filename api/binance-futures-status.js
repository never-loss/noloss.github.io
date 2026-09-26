// Estado do caminho REAL: se as chaves existem no servidor (sem revelar valores).
// Omissão = PAPER. Nunca devolver secrets.

function keysConfigured(env) {
  const key = env.BINANCE_API_KEY;
  const secret = env.BINANCE_API_SECRET;
  return Boolean(key && secret && String(key).length > 8 && String(secret).length > 8);
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "OPTIONS") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const configured = keysConfigured(process.env);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    defaultMode: "PAPER",
    keysConfigured: configured,
    realAvailable: configured,
    envNames: ["BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_FUTURES_BASE_URL"],
    rules: {
      fixedStake: true,
      evidenceGateRequired: true,
      noMartingale: true,
      maxSessionHours: 3,
      stopOnMaxSession: true,
    },
    source: "binance_usdtm_futures",
  });
}
