// NEVER LOSS - estratégias de velas (Forex/cripto): sinais de COMPRA (+1) e VENDA (-1).
// Cada sinal no índice i usa só velas até i (nunca o futuro). Nenhuma estratégia garante lucro:
// a porta de evidência decide quais servem, com dados fora da amostra e custos incluídos.

import { ema, rsi, macd, bollinger, stochastic, adx, atr } from "./indicators.ts";
import type { Series } from "./indicators.ts";
import type { Candle } from "./market-data.ts";

export type Signal = -1 | 0 | 1;

export interface Strategy {
  name: string;
  signals(candles: readonly Candle[]): Signal[];
}

function closes(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.close);
}

/** a passou de baixo para cima de b entre i-1 e i. */
function crossedUp(a: Series, b: Series, i: number): boolean {
  const a0 = a[i - 1];
  const b0 = b[i - 1];
  const a1 = a[i];
  const b1 = b[i];
  if (i < 1 || a0 == null || b0 == null || a1 == null || b1 == null) return false;
  return a0 <= b0 && a1 > b1;
}

function crossedDown(a: Series, b: Series, i: number): boolean {
  const a0 = a[i - 1];
  const b0 = b[i - 1];
  const a1 = a[i];
  const b1 = b[i];
  if (i < 1 || a0 == null || b0 == null || a1 == null || b1 == null) return false;
  return a0 >= b0 && a1 < b1;
}

function build(n: number, f: (i: number) => Signal): Signal[] {
  const out: Signal[] = new Array<Signal>(n).fill(0);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
}

function level(v: number | null | undefined): number | null {
  return v == null ? null : v;
}

/** Cruzamento de médias exponenciais: compra quando a rápida cruza acima da lenta, vende no contrário. */
export function emaCross(opts: { fast: number; slow: number }): Strategy {
  if (!(opts.fast < opts.slow)) throw new RangeError("fast tem de ser menor que slow");
  return {
    name: `ema-cruza ${opts.fast}/${opts.slow}`,
    signals(candles) {
      const c = closes(candles);
      const f = ema(c, opts.fast);
      const s = ema(c, opts.slow);
      return build(c.length, (i) => (crossedUp(f, s, i) ? 1 : crossedDown(f, s, i) ? -1 : 0));
    },
  };
}

/** RSI (reversão à média): compra quando sobe de volta acima de `low`, vende quando cai abaixo de `high`. */
export function rsiReversion(opts: { period: number; low: number; high: number }): Strategy {
  if (!(opts.low < opts.high)) throw new RangeError("low tem de ser menor que high");
  return {
    name: `rsi-reversao ${opts.period} ${opts.low}/${opts.high}`,
    signals(candles) {
      const r = rsi(closes(candles), opts.period);
      return build(r.length, (i) => {
        const p = level(r[i - 1]);
        const x = level(r[i]);
        if (i < 1 || p === null || x === null) return 0;
        if (p < opts.low && x >= opts.low) return 1;
        if (p > opts.high && x <= opts.high) return -1;
        return 0;
      });
    },
  };
}

/** MACD: compra quando a linha MACD cruza acima da linha de sinal, vende no contrário. */
export function macdCross(opts: { fast: number; slow: number; signal: number }): Strategy {
  return {
    name: `macd-cruza ${opts.fast}/${opts.slow}/${opts.signal}`,
    signals(candles) {
      const m = macd(closes(candles), opts.fast, opts.slow, opts.signal);
      return build(candles.length, (i) => (crossedUp(m.macd, m.signal, i) ? 1 : crossedDown(m.macd, m.signal, i) ? -1 : 0));
    },
  };
}

/** Bollinger (reversão): compra quando o preço volta para dentro da banda inferior, vende na superior. */
export function bollingerReversion(opts: { period: number; k: number }): Strategy {
  return {
    name: `bollinger-reversao ${opts.period} k${opts.k}`,
    signals(candles) {
      const c = closes(candles);
      const b = bollinger(c, opts.period, opts.k);
      return build(c.length, (i) => {
        const lo0 = level(b.lower[i - 1]);
        const lo1 = level(b.lower[i]);
        const up0 = level(b.upper[i - 1]);
        const up1 = level(b.upper[i]);
        if (i < 1 || lo0 === null || lo1 === null || up0 === null || up1 === null) return 0;
        if (c[i - 1]! < lo0 && c[i]! >= lo1) return 1;
        if (c[i - 1]! > up0 && c[i]! <= up1) return -1;
        return 0;
      });
    },
  };
}

/** Bollinger (rompimento): compra quando o preço rompe a banda superior, vende quando rompe a inferior. */
export function bollingerBreakout(opts: { period: number; k: number }): Strategy {
  return {
    name: `bollinger-rompe ${opts.period} k${opts.k}`,
    signals(candles) {
      const c = closes(candles);
      const b = bollinger(c, opts.period, opts.k);
      return build(c.length, (i) => {
        const lo0 = level(b.lower[i - 1]);
        const lo1 = level(b.lower[i]);
        const up0 = level(b.upper[i - 1]);
        const up1 = level(b.upper[i]);
        if (i < 1 || lo0 === null || lo1 === null || up0 === null || up1 === null) return 0;
        if (c[i - 1]! <= up0 && c[i]! > up1) return 1;
        if (c[i - 1]! >= lo0 && c[i]! < lo1) return -1;
        return 0;
      });
    },
  };
}

/** Estocástico: compra no cruzamento de %K acima de %D vindo de zona baixa; vende vindo de zona alta. */
export function stochasticCross(opts: { k: number; d: number; low: number; high: number }): Strategy {
  return {
    name: `estocastico ${opts.k}/${opts.d} ${opts.low}/${opts.high}`,
    signals(candles) {
      const s = stochastic(candles, opts.k, opts.d);
      return build(candles.length, (i) => {
        const k0 = level(s.k[i - 1]);
        if (i < 1 || k0 === null) return 0;
        if (crossedUp(s.k, s.d, i) && k0 < opts.low) return 1;
        if (crossedDown(s.k, s.d, i) && k0 > opts.high) return -1;
        return 0;
      });
    },
  };
}

/** ADX: com tendência forte (ADX >= minAdx), compra quando +DI cruza acima de -DI, vende no contrário. */
export function adxTrend(opts: { period: number; minAdx: number }): Strategy {
  return {
    name: `adx-tendencia ${opts.period} min${opts.minAdx}`,
    signals(candles) {
      const a = adx(candles, opts.period);
      return build(candles.length, (i) => {
        const v = level(a.adx[i]);
        if (v === null || v < opts.minAdx) return 0;
        return crossedUp(a.plusDI, a.minusDI, i) ? 1 : crossedDown(a.plusDI, a.minusDI, i) ? -1 : 0;
      });
    },
  };
}

/**
 * Tendência diária / breakout com ATR: rompe o máximo/mínimo das últimas `lookback` velas
 * por pelo menos `atrMult` × ATR (movimentos mais fortes). Filtro ADX opcional.
 * Nome em PT para o painel. Passa pela mesma porta de evidência — sem garantir lucro.
 */
export function dailyTrendAtrBreakout(opts: {
  lookback: number;
  atrPeriod: number;
  atrMult: number;
  minAdx?: number;
}): Strategy {
  if (!Number.isInteger(opts.lookback) || opts.lookback < 2) {
    throw new RangeError(`lookback inválido: ${opts.lookback}`);
  }
  if (!(opts.atrMult > 0)) throw new RangeError(`atrMult inválido: ${opts.atrMult}`);
  const minAdx = opts.minAdx;
  return {
    name: `tendência-diária breakout-ATR ${opts.lookback}×${opts.atrMult}` +
      (minAdx != null ? ` adx${minAdx}` : ""),
    signals(candles) {
      const a = atr(candles, opts.atrPeriod);
      const trend = minAdx != null ? adx(candles, 14) : null;
      return build(candles.length, (i) => {
        if (i < opts.lookback) return 0;
        const atrV = level(a[i]);
        if (atrV === null || atrV <= 0) return 0;
        if (trend && minAdx != null) {
          const adxV = level(trend.adx[i]);
          if (adxV === null || adxV < minAdx) return 0;
        }
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - opts.lookback; j < i; j++) {
          const c = candles[j]!;
          if (c.high > hi) hi = c.high;
          if (c.low < lo) lo = c.low;
        }
        const close = candles[i]!.close;
        const pad = opts.atrMult * atrV;
        if (close > hi + pad) return 1;
        if (close < lo - pad) return -1;
        return 0;
      });
    },
  };
}

/**
 * Confluência: só dá sinal quando pelo menos `minAgree` estratégias concordam na mesma direção
 * (cada uma conta durante `hold` velas depois de sinalizar) e nenhuma aponta para o lado oposto.
 */
export function confluence(opts: { strategies: readonly Strategy[]; minAgree: number; hold: number }): Strategy {
  if (opts.strategies.length < 2) throw new RangeError("Precisas de pelo menos 2 estratégias");
  if (!Number.isInteger(opts.minAgree) || opts.minAgree < 2 || opts.minAgree > opts.strategies.length) {
    throw new RangeError(`minAgree inválido: ${opts.minAgree}`);
  }
  if (!Number.isInteger(opts.hold) || opts.hold < 1) throw new RangeError(`hold inválido: ${opts.hold}`);
  return {
    name: `confluencia(${opts.strategies.map((s) => s.name).join(" + ")}) >=${opts.minAgree} h${opts.hold}`,
    signals(candles) {
      const all = opts.strategies.map((s) => s.signals(candles));
      return build(candles.length, (i) => {
        let longs = 0;
        let shorts = 0;
        for (const sig of all) {
          for (let j = i; j > i - opts.hold && j >= 0; j--) {
            if (sig[j] !== 0) {
              if (sig[j] === 1) longs += 1;
              else shorts += 1;
              break;
            }
          }
        }
        if (longs >= opts.minAgree && shorts === 0) return 1;
        if (shorts >= opts.minAgree && longs === 0) return -1;
        return 0;
      });
    },
  };
}

/** Biblioteca inicial de estratégias (o bot testa todas e só usa as que passam na porta de evidência). */
export function strategyLibrary(): Strategy[] {
  const trend = [
    emaCross({ fast: 9, slow: 21 }),
    emaCross({ fast: 12, slow: 26 }),
    emaCross({ fast: 20, slow: 50 }),
    macdCross({ fast: 12, slow: 26, signal: 9 }),
    macdCross({ fast: 8, slow: 17, signal: 9 }),
    adxTrend({ period: 14, minAdx: 20 }),
    adxTrend({ period: 14, minAdx: 25 }),
    bollingerBreakout({ period: 20, k: 2 }),
    // Movimentos diários mais fortes (cripto): mesma porta de evidência.
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 0.5, minAdx: 20 }),
    dailyTrendAtrBreakout({ lookback: 48, atrPeriod: 14, atrMult: 0.75, minAdx: 25 }),
  ];
  const reversion = [
    rsiReversion({ period: 14, low: 30, high: 70 }),
    rsiReversion({ period: 14, low: 25, high: 75 }),
    rsiReversion({ period: 7, low: 20, high: 80 }),
    bollingerReversion({ period: 20, k: 2 }),
    bollingerReversion({ period: 20, k: 2.5 }),
    stochasticCross({ k: 14, d: 3, low: 20, high: 80 }),
  ];
  const combos = [
    confluence({ strategies: [emaCross({ fast: 12, slow: 26 }), adxTrend({ period: 14, minAdx: 25 })], minAgree: 2, hold: 3 }),
    confluence({ strategies: [macdCross({ fast: 12, slow: 26, signal: 9 }), adxTrend({ period: 14, minAdx: 20 })], minAgree: 2, hold: 3 }),
    confluence({
      strategies: [rsiReversion({ period: 14, low: 30, high: 70 }), bollingerReversion({ period: 20, k: 2 })],
      minAgree: 2,
      hold: 3,
    }),
    confluence({
      strategies: [stochasticCross({ k: 14, d: 3, low: 20, high: 80 }), rsiReversion({ period: 14, low: 30, high: 70 })],
      minAgree: 2,
      hold: 3,
    }),
  ];
  return [...trend, ...reversion, ...combos];
}

/** Subconjunto: só tendência diária / breakout-ATR (ainda passa pela porta de evidência). */
export function dailyTrendStrategySet(): Strategy[] {
  return [
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 0.5, minAdx: 20 }),
    dailyTrendAtrBreakout({ lookback: 48, atrPeriod: 14, atrMult: 0.75, minAdx: 25 }),
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 1.0 }),
  ];
}

/** IDs dos presets do seletor obrigatório no painel. */
export type StrategyPresetId = "lucro_rapido" | "loss_zero" | "tendencia_diaria" | "biblioteca";

export interface StrategyPresetGateHints {
  /** Take-profit em múltiplos de R (ainda stake fixa — sem martingale). */
  tpR?: number;
  maxBars?: number;
  slAtr?: number;
  /** Loss zero pede evidência mais forte; Lucro rápido aceita PRELIMINARY. */
  minLabel?: "PRELIMINARY" | "EVIDENCE";
}

export interface StrategyPreset {
  id: StrategyPresetId;
  /** Nome visível no painel (ex.: "Lucro rápido"). */
  label: string;
  /** Texto honesto: porta de evidência + NO TRADE; sem promessa de lucro. */
  description: string;
  preferredGate?: StrategyPresetGateHints;
  strategies(): Strategy[];
}

/**
 * Lucro rápido: sinais mais curtos / frequentes (EMA rápidas, MACD curto, RSI 7, breakouts).
 * Continua a passar pela porta — pode dar NO TRADE. Stake fixa, sem martingale.
 */
export function lucroRapidoStrategySet(): Strategy[] {
  return [
    emaCross({ fast: 9, slow: 21 }),
    emaCross({ fast: 12, slow: 26 }),
    macdCross({ fast: 8, slow: 17, signal: 9 }),
    bollingerBreakout({ period: 20, k: 2 }),
    rsiReversion({ period: 7, low: 20, high: 80 }),
    stochasticCross({ k: 14, d: 3, low: 20, high: 80 }),
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 0.5, minAdx: 20 }),
  ];
}

/**
 * Loss zero: mais seletivo (confluência + ADX alto + tendência diária).
 * Nome aspiracional da marca — NÃO garante zero perdas; NO TRADE se a porta falhar.
 */
export function lossZeroStrategySet(): Strategy[] {
  return [
    confluence({
      strategies: [emaCross({ fast: 12, slow: 26 }), adxTrend({ period: 14, minAdx: 25 })],
      minAgree: 2,
      hold: 3,
    }),
    confluence({
      strategies: [macdCross({ fast: 12, slow: 26, signal: 9 }), adxTrend({ period: 14, minAdx: 20 })],
      minAgree: 2,
      hold: 3,
    }),
    confluence({
      strategies: [rsiReversion({ period: 14, low: 30, high: 70 }), bollingerReversion({ period: 20, k: 2 })],
      minAgree: 2,
      hold: 3,
    }),
    confluence({
      strategies: [stochasticCross({ k: 14, d: 3, low: 20, high: 80 }), rsiReversion({ period: 14, low: 30, high: 70 })],
      minAgree: 2,
      hold: 3,
    }),
    adxTrend({ period: 14, minAdx: 25 }),
    dailyTrendAtrBreakout({ lookback: 48, atrPeriod: 14, atrMult: 0.75, minAdx: 25 }),
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 1.0 }),
  ];
}

/** Catálogo do seletor do painel (obrigatório antes de PLAY). */
export const STRATEGY_PRESETS: readonly StrategyPreset[] = [
  {
    id: "lucro_rapido",
    label: "Lucro rápido",
    description:
      "Sinais mais curtos (EMA/MACD/RSI rápidos). Stake fixa · porta de evidência · NO TRADE se falhar · sem martingale. Não garante lucro.",
    preferredGate: { tpR: 1.5, maxBars: 12, slAtr: 1.2, minLabel: "PRELIMINARY" },
    strategies: lucroRapidoStrategySet,
  },
  {
    id: "loss_zero",
    label: "Loss zero",
    description:
      "Mais seletivo (confluência + ADX + tendência diária). Exige evidência mais forte. NÃO promete zero perdas — NO TRADE se a porta falhar. Stake fixa, sem martingale.",
    preferredGate: { tpR: 2, maxBars: 24, slAtr: 1.5, minLabel: "EVIDENCE" },
    strategies: lossZeroStrategySet,
  },
  {
    id: "tendencia_diaria",
    label: "Tendência diária / breakout-ATR",
    description:
      "Só breakouts ATR de tendência diária. Ainda exige walk-forward e pode fechar em NO TRADE.",
    preferredGate: { tpR: 2, maxBars: 24, slAtr: 1.5, minLabel: "PRELIMINARY" },
    strategies: dailyTrendStrategySet,
  },
  {
    id: "biblioteca",
    label: "Biblioteca completa",
    description:
      "Toda a biblioteca: a porta escolhe a que passa fora da amostra. Sem martingale · stake fixa · paper.",
    preferredGate: { tpR: 2, maxBars: 24, slAtr: 1.5, minLabel: "PRELIMINARY" },
    strategies: strategyLibrary,
  },
];

export function strategyPreset(id: string): StrategyPreset | null {
  const found = STRATEGY_PRESETS.find((p) => p.id === id);
  return found ?? null;
}

/** Estratégias do preset; lança se o id for desconhecido (select obrigatório). */
export function strategiesForPreset(id: string): Strategy[] {
  const p = strategyPreset(id);
  if (!p) throw new RangeError(`preset de estratégia desconhecido: ${id}`);
  return p.strategies();
}
