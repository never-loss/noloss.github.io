// Estado do caminho REAL: se as chaves existem no servidor (sem revelar valores).
// Omissão = PAPER. Nunca devolver secrets. authMode: ed25519 | hmac | none.
// Manter em sync com src/core/binance-futures-trading.ts

function normalizePem(raw) {
  return String(raw)
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();
}

function looksLikePem(raw) {
  if (raw == null || typeof raw !== "string") return false;
  const n = normalizePem(raw);
  return (
    n.includes("-----BEGIN PRIVATE KEY-----") ||
    n.includes("-----BEGIN ED25519 PRIVATE KEY-----")
  );
}

/** @returns {'ed25519'|'hmac'|'none'} */
function resolveAuthMode(env) {
  const key = env.BINANCE_API_KEY;
  if (!key || String(key).length <= 8) return "none";
  const pem = env.BINANCE_API_PRIVATE_KEY;
  if (pem && looksLikePem(pem) && normalizePem(pem).length > 32) return "ed25519";
  const secret = env.BINANCE_API_SECRET;
  if (secret && looksLikePem(secret) && normalizePem(secret).length > 32) return "ed25519";
  if (secret && String(secret).length > 8 && !looksLikePem(secret)) return "hmac";
  return "none";
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
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    defaultMode: "PAPER",
    keysConfigured: configured,
    realAvailable: configured,
    authMode,
    envNames: [
      "BINANCE_API_KEY",
      "BINANCE_API_SECRET",
      "BINANCE_API_PRIVATE_KEY",
      "BINANCE_FUTURES_BASE_URL",
    ],
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
