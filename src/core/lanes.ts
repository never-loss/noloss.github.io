// Conjuntos de regras candidatas de cada faixa de payout.
import { parityStreak, dominantDigitMatch, absentDigitMatch } from "./backtest.ts";
import type { Rule } from "./backtest.ts";

/** Faixa A: payout médio (paridade). */
export function laneARules(returnRate: number): Rule[] {
  const rules: Rule[] = [];
  for (const length of [2, 3, 4, 5, 6]) {
    for (const follow of [true, false]) rules.push(parityStreak({ length, follow, returnRate }));
  }
  return rules;
}

/** Faixa B: payout alto (match). */
export function laneBRules(returnRate: number): Rule[] {
  const rules: Rule[] = [];
  for (const window of [50, 100, 250]) {
    for (const minPct of [15, 20, 25, 30]) rules.push(dominantDigitMatch({ window, minPct, returnRate }));
  }
  for (const absentTicks of [20, 30, 50]) rules.push(absentDigitMatch({ absentTicks, returnRate }));
  return rules;
}
