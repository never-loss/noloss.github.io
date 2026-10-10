// Relatório SÓ DE LEITURA do modo sombra: porta nova (livro-razão, 90 d) vs antiga (walk-forward curto) + FDR (BH).
// Dados reais da Bybit via proxy público do projecto. Não escreve em Redis nem altera comportamento.
//   node scripts/shadow-report.ts [--proxy https://noloss-zeta.vercel.app] [--symbols BTCUSDT,ETHUSDT | auto] [--out /tmp/shadow.json]
import { writeFileSync } from "node:fs";
import { fetchDeepHistory } from "../lib/history.js";
import { computeGateEntry, summarizeEntry, GATE_PRESET_IDS, GATE_COLD_DAYS, summarizeShadow } from "../src/core/gate-service.ts";

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const PROXY = arg("proxy", "https://noloss-zeta.vercel.app");
const proxyFetch = (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input));
  return fetch(`${PROXY}/api/bybit-klines?symbol=${u.searchParams.get("symbol")}&interval=5&limit=1000&end=${u.searchParams.get("end")}`, init);
};

async function symbols(): Promise<string[]> {
  const a = arg("symbols", "auto");
  if (a !== "auto") return a.split(",");
  const j = (await (await fetch(`${PROXY}/api/bybit-klines?mode=gate&symbols=all`)).json()) as { gates?: Record<string, unknown> };
  return Object.keys(j.gates ?? {});
}

const syms = await symbols();
const sums = [];
const failed: string[] = [];
for (const s of syms) {
  const h = await fetchDeepHistory(s, 300, { days: GATE_COLD_DAYS, fetchImpl: proxyFetch, bases: ["https://proxy.local"] });
  if (h.candles.length < 2700 || !h.complete) { failed.push(s); continue; }
  sums.push(summarizeEntry(computeGateEntry(null, s, h.candles, Date.now())));
}
const rep = summarizeShadow(sums, GATE_PRESET_IDS);
const out = { symbols: sums.length, failed, asOf: new Date().toISOString(), presets: rep };
if (arg("out", "")) writeFileSync(arg("out", ""), JSON.stringify(out));
console.log(JSON.stringify(out, null, 1));
