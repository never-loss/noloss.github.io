// Relatório SÓ DE LEITURA: como muda o veredicto da porta (livro-razão) com o custo por ida-e-volta e com stops mais largos.
// NÃO altera o custo por omissão nem nenhum comportamento ao vivo. Dados reais da Bybit via proxy público do projecto.
//
//   node scripts/cost-sensitivity.ts [--days 90] [--symbols BTCUSDT,ETHUSDT] [--proxy https://noloss-zeta.vercel.app] [--out /tmp/cost.json]
//
// Cada combinação (símbolo x preset x stop x custo) é UM teste de hipótese; por isso o relatório aplica Benjamini-Hochberg
// (FDR) por cenário e, no fim, sobre a grelha inteira (procurar em muitos cenários é "olhar para o lado" e gera falsos positivos).

import { writeFileSync } from "node:fs";
import { fetchDeepHistory } from "../lib/history.js";
import { atr } from "../src/core/indicators.ts";
import { computeLedger, evaluateLedgerGate, makeLedgerParams, ledgerOos } from "../src/core/gate-ledger.ts";
import { ledgerAsOf, GATE_VERDICT_FOLDS } from "../src/core/ledger-gate-controller.ts";
import { strategiesForPreset, strategyPreset } from "../src/core/strategies.ts";
import type { StrategyPresetId } from "../src/core/strategies.ts";
import { feasible } from "../src/core/feasible.ts";
import { benjaminiHochberg } from "../src/core/fdr.ts";
import { GATE_TRAIN, GATE_BLOCK, GATE_WARMUP, GATE_KEEP_FOLDS, GATE_TAIL_KEEP, GATE_MIN_MULTIPLIER } from "../src/core/gate-service.ts";

const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const DAYS = Number(arg("days", "90"));
const PROXY = arg("proxy", "https://noloss-zeta.vercel.app");
const SYMBOLS = arg("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,BNBUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT").split(",");
const PRESETS: StrategyPresetId[] = ["lucro_rapido", "loss_zero", "blitz_zero"];

/** Custos por ida-e-volta (fracção do preço). Rótulos ilustrativos — NÃO é a tabela oficial da Bybit. */
export const COSTS = [
  { id: "0.10%", label: "padrão do bot (≈ taker×2 sem derrapagem)", v: 0.001 },
  { id: "0.06%", label: "taker×2 tipo VIP", v: 0.0006 },
  { id: "0.04%", label: "maker×2 (ordens limite sempre executadas)", v: 0.0004 },
  { id: "0.02%", label: "maker×2 tipo VIP", v: 0.0002 },
  { id: "0.00%", label: "sem custos (limite teórico, irreal)", v: 0 },
];
/** Stops em múltiplos de ATR: o do preset, 2.5 e 4.0 (mais largo → o custo pesa menos em R). */
const STOPS = ["preset", 2.5, 4.0] as const;

const proxyFetch = (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input));
  return fetch(`${PROXY}/api/bybit-klines?symbol=${u.searchParams.get("symbol")}&interval=5&limit=1000&end=${u.searchParams.get("end")}`, init);
};

interface Cell { symbol: string; preset: string; stop: number; cost: string; allowed: boolean; label: string; nOOS: number; meanR: number; p: number | null; folds: number }

async function main(): Promise<void> {
  const cells: Cell[] = [];
  const costInR: Record<string, Record<string, number>> = {};
  const hist: Record<string, { n: number; from: number; to: number }> = {};
  for (const sym of SYMBOLS) {
    const h = await fetchDeepHistory(sym, 300, { days: DAYS, fetchImpl: proxyFetch, bases: ["https://proxy.local"] });
    if (!h.complete || h.candles.length < 3000) { console.error(`${sym}: histórico incompleto (${h.candles.length})`); continue; }
    const candles = h.candles;
    hist[sym] = { n: candles.length, from: candles[0]!.epoch, to: candles[candles.length - 1]!.epoch };
    const a = atr(candles, 14);
    const tail = candles.slice(-GATE_TAIL_KEEP);
    for (const pid of PRESETS) {
      const preset = strategyPreset(pid)!;
      const g = preset.preferredGate ?? {};
      const minLabel = g.minLabel || "PRELIMINARY";
      for (const stopSpec of STOPS) {
        const slAtr = stopSpec === "preset" ? g.slAtr || 1.5 : stopSpec;
        const strategies = strategiesForPreset(pid).map((s) => feasible(s, { slAtr, maxStopFraction: 1 / GATE_MIN_MULTIPLIER }));
        // custo em R (mediana) para este stop
        const rs: number[] = [];
        candles.forEach((c, i) => { const x = a[i]; if (x) rs.push(c.open / (slAtr * x)); });
        rs.sort((x, y) => x - y);
        costInR[`${sym}|${slAtr}`] = Object.fromEntries(COSTS.map((c) => [c.id, c.v * rs[rs.length >> 1]!]));
        for (const cost of COSTS) {
          const params = makeLedgerParams(strategies, { slAtr, tpR: g.tpR || 2, maxBars: g.maxBars || 24, costFraction: cost.v, trainSize: GATE_TRAIN }, 300, { blockCandles: GATE_BLOCK, warmup: GATE_WARMUP });
          const ledger = computeLedger(candles, strategies, params, { keepFolds: GATE_KEEP_FOLDS });
          const view = ledgerAsOf(ledger, Number.POSITIVE_INFINITY, GATE_VERDICT_FOLDS);
          const r = evaluateLedgerGate(view, tail, strategies, { minLabel });
          // média/p do OOS agregado mesmo abaixo do mínimo do preset (a porta fecha por INSUFFICIENT, mas o número existe)
          const agg = ledgerOos(view);
          cells.push({ symbol: sym, preset: pid, stop: slAtr, cost: cost.id, allowed: r.allowed, label: r.label, nOOS: agg.trades, meanR: agg.meanR, p: agg.pValue, folds: r.folds });
        }
      }
    }
    console.error(`${sym}: ${candles.length} velas ok`);
  }
  // Agregados por cenário (preset x stop x custo) com FDR entre símbolos
  const scen = new Map<string, Cell[]>();
  for (const c of cells) {
    const k = `${c.preset}|${c.stop}|${c.cost}`;
    (scen.get(k) ?? scen.set(k, []).get(k)!).push(c);
  }
  const rows = [...scen.entries()].map(([k, list]) => {
    const [preset, stop, cost] = k.split("|") as [string, string, string];
    const withP = list.filter((c) => c.nOOS >= 30 && c.p !== null);
    const bh = benjaminiHochberg(withP.map((c) => c.p), 0.1);
    return {
      preset, stop: Number(stop), cost, symbols: list.length,
      open: list.filter((c) => c.allowed).length,
      openFdr: withP.filter((c, i) => c.allowed && bh.reject[i]).length,
      positiveMean: list.filter((c) => c.meanR > 0 && c.nOOS >= 30).length,
      medianMeanR: [...list].map((c) => c.meanR).sort((x, y) => x - y)[list.length >> 1] ?? 0,
      medianN: [...list].map((c) => c.nOOS).sort((x, y) => x - y)[list.length >> 1] ?? 0,
    };
  });
  // FDR sobre a grelha inteira por preset (todos os símbolos x stops x custos)
  const grid: Record<string, { tests: number; allowed: number; passFdrGrid: number }> = {};
  for (const pid of PRESETS) {
    const list = cells.filter((c) => c.preset === pid && c.nOOS >= 30 && c.p !== null);
    const bh = benjaminiHochberg(list.map((c) => c.p), 0.1);
    grid[pid] = { tests: list.length, allowed: list.filter((c) => c.allowed).length, passFdrGrid: list.filter((c, i) => c.allowed && bh.reject[i]).length };
  }
  const out = { days: DAYS, symbols: Object.keys(hist), history: hist, costs: COSTS, rows, grid, costInRMedian: costInR, cells };
  const file = arg("out", "");
  if (file) writeFileSync(file, JSON.stringify(out));
  console.log(JSON.stringify({ ...out, cells: undefined }, null, 1));
}

await main();
