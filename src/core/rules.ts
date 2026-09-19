// Converte um texto (ex.: "paridade-inverte-3") numa regra de backtest/paper.
import { parityStreak, dominantDigitMatch, absentDigitMatch } from "./backtest.ts";
import type { Rule } from "./backtest.ts";

export const RULE_FORMATS =
  "paridade-segue-N | paridade-inverte-N | dominante-JANELA-PCT | ausente-K";

function num(s: string | undefined): number {
  if (s === undefined || !/^\d+$/.test(s)) throw new RangeError(`Regra inválida. Formatos: ${RULE_FORMATS}`);
  return Number(s);
}

export function parseRuleSpec(spec: string, returnRate: number): Rule {
  const p = spec.trim().toLowerCase().split("-");
  if (p[0] === "paridade" && (p[1] === "segue" || p[1] === "inverte") && p.length === 3) {
    return parityStreak({ length: num(p[2]), follow: p[1] === "segue", returnRate });
  }
  if (p[0] === "dominante" && p.length === 3) {
    return dominantDigitMatch({ window: num(p[1]), minPct: num(p[2]), returnRate });
  }
  if (p[0] === "ausente" && p.length === 2) {
    return absentDigitMatch({ absentTicks: num(p[1]), returnRate });
  }
  throw new RangeError(`Regra inválida. Formatos: ${RULE_FORMATS}`);
}
