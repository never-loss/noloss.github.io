// SÓ LEITURA: porta do Giro Diário no livro-razão (histórico profundo, 90 d de 5m) — o mesmo cálculo da cache do servidor.
//   node scripts/giro-ledger-check.ts [--symbols BTCUSDT,ETHUSDT] [--days 90]
import { fetchDeepHistory } from "../lib/history.js";
import { computeGateEntry, GATE_COLD_DAYS } from "../src/core/gate-service.ts";
const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const PROXY = arg("proxy", "https://noloss-zeta.vercel.app");
const proxyFetch = (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input));
  return fetch(`${PROXY}/api/bybit-klines?symbol=${u.searchParams.get("symbol")}&interval=5&limit=1000&end=${u.searchParams.get("end")}`, init);
};
const days = Number(arg("days", String(GATE_COLD_DAYS)));
for (const sym of arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT").split(",")) {
  const h = await fetchDeepHistory(sym, 300, { days, fetchImpl: proxyFetch, bases: ["https://proxy.local"], concurrency: 4 });
  const t0 = Date.now();
  const e = computeGateEntry(null, sym, h.candles, Date.now(), { presets: ["giro_diario"] });
  const v = e.verdicts.giro_diario as Record<string, unknown>;
  const L = e.ledgers.giro_diario!;
  console.log(JSON.stringify({ sym, candles: h.candles.length, complete: h.complete, histDays: +(h.candles.length / 288).toFixed(1),
    foldsAll: L.folds.length, ms: Date.now() - t0, allowed: v.allowed, label: v.label, nOOS: v.nOOS, meanR: v.meanR, p: v.p,
    folds: v.folds, depthDays: v.depthDays, reason: v.reason }));
}
