// Pesquisa em velas reais: walk-forward da biblioteca de estratégias, por símbolo, com custos.
// É investigação, não uma recomendação de operar.

import { walkForwardCandles } from "./candle-backtest.ts";
import type { CandleWalkForwardResult, RMetrics } from "./candle-backtest.ts";
import { strategyLibrary } from "./strategies.ts";
import type { Strategy } from "./strategies.ts";
import { benjaminiHochberg, classify } from "./stats.ts";
import type { EvidenceLabel } from "./stats.ts";
import type { Candle } from "./market-data.ts";

export interface CandleResearchOptions {
  slAtr: number;
  tpR: number;
  maxBars: number;
  /** Custo de ida e volta por símbolo, como fração do preço (suposição até medirmos o real). */
  costFor: (symbol: string) => number;
  trainSize: number;
  testSize: number;
}

export interface SymbolReport {
  symbol: string;
  candles: number;
  cost: number;
  /** Resultado fora da amostra, com custos. */
  walk: CandleWalkForwardResult;
  /** O mesmo, sem custos (para ver quanto os custos pesam). */
  noCost: RMetrics;
  adjustedP: number | null;
  label: EvidenceLabel;
}

export function runCandleResearch(
  data: Readonly<Record<string, readonly Candle[]>>,
  opts: CandleResearchOptions,
  strategies: readonly Strategy[] = strategyLibrary(),
): SymbolReport[] {
  const symbols = Object.keys(data);
  if (symbols.length === 0) throw new RangeError("Sem dados");
  const need = opts.trainSize + opts.testSize;

  const partial = symbols.map((symbol) => {
    const candles = data[symbol]!;
    if (candles.length < need) {
      throw new RangeError(`${symbol}: precisas de pelo menos ${need} velas (tens ${candles.length})`);
    }
    const cost = opts.costFor(symbol);
    const base = { slAtr: opts.slAtr, tpR: opts.tpR, maxBars: opts.maxBars, trainSize: opts.trainSize, testSize: opts.testSize };
    const walk = walkForwardCandles(candles, strategies, { ...base, costFraction: cost });
    const free = walkForwardCandles(candles, strategies, { ...base, costFraction: 0 });
    return { symbol, candles: candles.length, cost, walk, noCost: free.oos };
  });

  // Correção para múltiplos testes entre os símbolos que tiveram operações.
  const idx: number[] = [];
  const raw: number[] = [];
  partial.forEach((p, i) => {
    const pv = p.walk.oos.pValue;
    if (pv !== null) {
      idx.push(i);
      raw.push(pv);
    }
  });
  const adj = benjaminiHochberg(raw);

  return partial.map((p, i) => {
    const k = idx.indexOf(i);
    const adjustedP = k >= 0 ? adj[k]! : null;
    return { ...p, adjustedP, label: classify(p.walk.oos.trades, adjustedP ?? 1) };
  });
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const sgn = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;

export function formatCandleReport(reports: readonly SymbolReport[], opts: CandleResearchOptions): string {
  const out: string[] = [];
  out.push(
    `=== PESQUISA EM VELAS (stop ${opts.slAtr} x ATR, alvo ${opts.tpR}R, saída por tempo ${opts.maxBars} velas, compra e venda) ===`,
  );
  for (const r of reports) {
    const o = r.walk.oos;
    out.push("");
    out.push(`--- ${r.symbol} | ${r.candles} velas | custo assumido ${(r.cost * 100).toFixed(3)}% ---`);
    if (o.trades === 0) {
      out.push("Fora da amostra: NO TRADE (nenhuma estratégia serviu no treino).");
    } else {
      out.push(`Fora da amostra: ${o.trades} operações, taxa ${pct(o.winRate)}, média ${sgn(o.meanR)}R por operação, total ${sgn(o.netR)}R`);
      out.push(`Sem custos seria: média ${sgn(r.noCost.meanR)}R (${r.noCost.trades} operações)`);
      out.push(`Pior queda: ${o.maxDrawdownR.toFixed(1)}R | maior sequência de perdas: ${o.longestLosingStreak}`);
      out.push(`p = ${o.pValue === null ? "-" : o.pValue.toFixed(3)} | p ajustado = ${r.adjustedP === null ? "-" : r.adjustedP.toFixed(3)}`);
    }
    out.push(`Rótulo de pesquisa: ${r.label}`);
  }
  out.push("");
  out.push("Aviso: isto é pesquisa com custos assumidos. Nenhum resultado, mesmo positivo, garante lucro futuro.");
  return out.join("\n");
}
