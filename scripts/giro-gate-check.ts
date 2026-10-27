// SÓ LEITURA: estado real da porta do Giro Diário (mesmo caminho do arm na nuvem) em alguns símbolos, via proxy.
//   node scripts/giro-gate-check.ts [--symbols BTCUSDT,ETHUSDT,SOLUSDT] [--gran 300|60]
import { fetchDeepHistory } from "../lib/history.js";
import { createCloudArmJob, advanceCloudArmJob } from "../src/core/cloud-arm.ts";
const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const PROXY = arg("proxy", "https://noloss-zeta.vercel.app");
const GRAN = Number(arg("gran", "300"));
const IV: Record<number, string> = { 60: "1", 300: "5" };
const proxyFetch = (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input));
  return fetch(`${PROXY}/api/bybit-klines?symbol=${u.searchParams.get("symbol")}&interval=${IV[GRAN]}&limit=1000&end=${u.searchParams.get("end")}`, init);
};
for (const sym of arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT").split(",")) {
  const h = await fetchDeepHistory(sym, GRAN, { count: 1600, fetchImpl: proxyFetch, bases: ["https://proxy.local"] });
  const now = Date.now();
  const job = createCloudArmJob({ symbol: sym, strategyPreset: "giro_diario", stake: 1, leverage: 5, granularity: GRAN, durationMinutes: 720, clientId: "giro_check_1" }, now);
  const out = advanceCloudArmJob(job, h.candles, now);
  console.log(JSON.stringify({ sym, gran: GRAN, candles: h.candles.length, mode: out.mode, gate: out.gate }));
}
