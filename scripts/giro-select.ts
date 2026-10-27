// Selecção REPRODUTÍVEL das estratégias do "Giro Diário" (SÓ LEITURA, dados reais Bybit via proxy).
// Regra pré-definida: para cada estratégia da biblioteca existente (strategyLibrary), backtest em velas de 5 min
// com custo 0,1 % (o padrão, NÃO alterado), stop/alvo/tempo do Giro Diário (1,2 ATR · 1,5R · 12 velas),
// numa janela de SELECÇÃO antiga (dias 60→30 antes de hoje) que a porta ao vivo não usa; junta as operações de
// todos os símbolos e ordena por média R. Escolhem-se as 4 melhores com >= 100 operações.
// Isto NÃO é evidência de lucro: a porta (walk-forward, >= 100 OOS, p < 0,01) continua a decidir ao vivo.
//
//   node scripts/giro-select.ts [--symbols BTCUSDT,...] [--gran 300] [--out /tmp/giro.json]
import { writeFileSync } from "node:fs";
import { fetchDeepHistory } from "../lib/history.js";
import { runCandleBacktest, summarizeR } from "../src/core/candle-backtest.ts";
import { strategyLibrary } from "../src/core/strategies.ts";

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const PROXY = arg("proxy", "https://noloss-zeta.vercel.app");
const GRAN = Number(arg("gran", "300"));
const SYMBOLS = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT").split(",");
const IV: Record<number, string> = { 60: "1", 300: "5" };
const proxyFetch = (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input));
  return fetch(`${PROXY}/api/bybit-klines?symbol=${u.searchParams.get("symbol")}&interval=${IV[GRAN]}&limit=1000&end=${u.searchParams.get("end")}`, init);
};

async function main(): Promise<void> {
  const lib = strategyLibrary();
  const pooled: Record<string, number[]> = Object.fromEntries(lib.map((s) => [s.name, []]));
  const per = 86400 / GRAN;
  for (const sym of SYMBOLS) {
    const h = await fetchDeepHistory(sym, GRAN, { days: 60, fetchImpl: proxyFetch, bases: ["https://proxy.local"] });
    if (!h.complete) { console.error(`${sym}: histórico incompleto`); continue; }
    const c = h.candles;
    const end = Math.max(0, c.length - 30 * per);
    for (const s of lib) {
      const r = runCandleBacktest(c, s, { slAtr: 1.2, tpR: 1.5, maxBars: 12, costFraction: 0.001, start: 200, end });
      pooled[s.name]!.push(...r.trades.map((t) => t.r));
    }
    console.error(`${sym}: ${c.length} velas`);
  }
  const rows = lib.map((s) => { const m = summarizeR(pooled[s.name]!); return { name: s.name, trades: m.trades, meanR: m.meanR, p: m.pValue }; })
    .sort((a, b) => b.meanR - a.meanR);
  const chosen = rows.filter((r) => r.trades >= 100).slice(0, 4).map((r) => r.name);
  const out = { at: new Date().toISOString(), gran: GRAN, symbols: SYMBOLS, window: "dias 60→30 antes de hoje", rule: "top-4 média R, >=100 ops, custo 0,1%", rows, chosen };
  console.log(JSON.stringify(out, null, 2));
  const o = arg("out", ""); if (o) writeFileSync(o, JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
