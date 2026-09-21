// Filtro de viabilidade para os multiplicadores da Deriv (ex.: ×100 a ×800).
// Com stake = perda máxima, o multiplicador m fecha a operação quando o preço anda 1/m contra ti.
// O menor multiplicador (×100) dá o stop mais largo possível: 1% do preço. Sinais que exigiriam
// um stop maior não podem ser executados e são descartados (sem olhar para o futuro).

import { atr } from "./indicators.ts";
import type { Strategy, Signal } from "./strategies.ts";
import type { Candle } from "./market-data.ts";

export interface FeasibleOptions {
  /** Stop = slAtr x ATR (o mesmo do backtest). */
  slAtr: number;
  atrPeriod?: number;
  /** Stop máximo executável, como fração do preço (1 / menor multiplicador). */
  maxStopFraction: number;
}

function assertOpts(o: FeasibleOptions): void {
  if (!(o.slAtr > 0) || !Number.isFinite(o.slAtr)) throw new RangeError(`slAtr inválido: ${o.slAtr}`);
  if (!(o.maxStopFraction > 0) || !Number.isFinite(o.maxStopFraction)) {
    throw new RangeError(`maxStopFraction inválido: ${o.maxStopFraction}`);
  }
}

/** Stop máximo executável a partir do menor multiplicador permitido (ex.: 100 -> 1%). */
export function maxStopFromMultiplier(minMultiplier: number): number {
  if (!(minMultiplier > 0) || !Number.isFinite(minMultiplier)) throw new RangeError(`multiplicador inválido: ${minMultiplier}`);
  return 1 / minMultiplier;
}

/** Devolve a mesma estratégia, mas só com os sinais cujo stop cabe num multiplicador permitido. */
export function feasible(strategy: Strategy, opts: FeasibleOptions): Strategy {
  assertOpts(opts);
  return {
    name: strategy.name,
    signals(candles: readonly Candle[]): Signal[] {
      const raw = strategy.signals(candles);
      const a = atr(candles, opts.atrPeriod ?? 14);
      return raw.map((s, i): Signal => {
        if (s === 0) return 0;
        const av = a[i];
        if (av === null || av === undefined) return 0;
        const stopFraction = (opts.slAtr * av) / candles[i]!.close;
        return stopFraction <= opts.maxStopFraction ? s : 0;
      });
    },
  };
}

export interface SignalShare {
  total: number;
  kept: number;
}

/** Quantos sinais das estratégias são executáveis (sobrevivem ao filtro). */
export function signalShare(strategies: readonly Strategy[], candles: readonly Candle[], opts: FeasibleOptions): SignalShare {
  assertOpts(opts);
  let total = 0;
  let kept = 0;
  for (const s of strategies) {
    const before = s.signals(candles);
    const after = feasible(s, opts).signals(candles);
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== 0) {
        total += 1;
        if (after[i] !== 0) kept += 1;
      }
    }
  }
  return { total, kept };
}
