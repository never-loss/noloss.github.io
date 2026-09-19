// Pesquisa: corre o teste dos dígitos e o walk-forward das duas "faixas" de payout.
// É investigação, não uma recomendação de operar.

import { countDigits, percentages } from "./digits.ts";
import { chiSquareUniformity, benjaminiHochberg, classify, breakEvenProbability } from "./stats.ts";
import type { ChiSquareResult, EvidenceLabel } from "./stats.ts";
import { walkForward, parityStreak, dominantDigitMatch, absentDigitMatch } from "./backtest.ts";
import type { Rule, WalkForwardResult } from "./backtest.ts";

export interface ResearchOptions {
  /** Retorno por win da faixa A (payout médio, ex.: 0,82). */
  returnA: number;
  /** Retorno por win da faixa B (payout alto). Valor assumido até vir da Deriv. */
  returnB: number;
  trainSize?: number;
  testSize?: number;
}

export interface LaneReport {
  lane: "A" | "B";
  description: string;
  returnRate: number;
  breakEven: number;
  candidates: number;
  walk: WalkForwardResult;
  adjustedP: number | null;
  label: EvidenceLabel;
}

export interface ResearchReport {
  n: number;
  counts: number[];
  percentages: number[];
  chi: ChiSquareResult;
  lanes: LaneReport[];
}

function laneARules(returnRate: number): Rule[] {
  const rules: Rule[] = [];
  for (const length of [2, 3, 4, 5, 6]) {
    for (const follow of [true, false]) rules.push(parityStreak({ length, follow, returnRate }));
  }
  return rules;
}

function laneBRules(returnRate: number): Rule[] {
  const rules: Rule[] = [];
  for (const window of [50, 100, 250]) {
    for (const minPct of [15, 20, 25, 30]) rules.push(dominantDigitMatch({ window, minPct, returnRate }));
  }
  for (const absentTicks of [20, 30, 50]) rules.push(absentDigitMatch({ absentTicks, returnRate }));
  return rules;
}

export function runResearch(digits: readonly number[], opts: ResearchOptions): ResearchReport {
  const trainSize = opts.trainSize ?? 1000;
  const testSize = opts.testSize ?? 500;
  if (digits.length < trainSize + testSize) {
    throw new RangeError(`Precisas de pelo menos ${trainSize + testSize} ticks (tens ${digits.length})`);
  }

  const counts = countDigits(digits);
  const chi = chiSquareUniformity(counts);

  const defs = [
    { lane: "A" as const, description: "payout médio (paridade)", returnRate: opts.returnA, rules: laneARules(opts.returnA) },
    { lane: "B" as const, description: "payout alto (match)", returnRate: opts.returnB, rules: laneBRules(opts.returnB) },
  ];

  const walks = defs.map((d) => walkForward(digits, d.rules, { trainSize, testSize }));

  // Correção para múltiplos testes entre as faixas que tiveram operações.
  const idx: number[] = [];
  const raw: number[] = [];
  walks.forEach((w, i) => {
    if (w.oos.evaluation !== null) {
      idx.push(i);
      raw.push(w.oos.evaluation.pValue);
    }
  });
  const adj = benjaminiHochberg(raw);

  const lanes: LaneReport[] = defs.map((d, i) => {
    const walk = walks[i]!;
    const k = idx.indexOf(i);
    const adjustedP = k >= 0 ? adj[k]! : null;
    return {
      lane: d.lane,
      description: d.description,
      returnRate: d.returnRate,
      breakEven: breakEvenProbability(d.returnRate),
      candidates: d.rules.length,
      walk,
      adjustedP,
      label: classify(walk.oos.trades, adjustedP ?? 1),
    };
  });

  return { n: digits.length, counts, percentages: percentages(counts), chi, lanes };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatReport(r: ResearchReport): string {
  const out: string[] = [];
  out.push(`=== PESQUISA (${r.n} ticks) ===`);
  out.push("Dígitos: " + r.counts.map((c, d) => `${d}:${c} (${r.percentages[d]!.toFixed(1)}%)`).join("  "));
  out.push(
    `Qui-quadrado: ${r.chi.statistic.toFixed(2)} (gl ${r.chi.df}), p = ${r.chi.pValue.toFixed(3)} ` +
      (r.chi.pValue < 0.05 ? "-> distribuição fora do uniforme" : "-> compatível com aleatório"),
  );
  for (const l of r.lanes) {
    const o = l.walk.oos;
    out.push("");
    out.push(`--- Faixa ${l.lane}: ${l.description} | retorno ${l.returnRate} | break-even ${pct(l.breakEven)} | ${l.candidates} regras testadas ---`);
    if (o.trades === 0 || o.evaluation === null) {
      out.push("Fora da amostra: NO TRADE (nenhuma regra serviu no treino).");
    } else {
      const ci = o.evaluation.ci95;
      out.push(`Fora da amostra: ${o.trades} operações, ${o.wins} wins, taxa ${pct(o.winRate)} (IC95% ${pct(ci.low)} a ${pct(ci.high)})`);
      out.push(`Lucro líquido: ${o.netUnits.toFixed(2)} stakes | pior queda: ${o.maxDrawdown.toFixed(2)} | maior sequência de perdas: ${o.longestLosingStreak}`);
      out.push(`p = ${o.evaluation.pValue.toFixed(3)} | p ajustado = ${l.adjustedP === null ? "-" : l.adjustedP.toFixed(3)}`);
    }
    out.push(`Rótulo de pesquisa: ${l.label}`);
  }
  out.push("");
  out.push("Aviso: isto é pesquisa. Nenhum resultado, mesmo positivo, garante lucro futuro.");
  return out.join("\n");
  }
