// NEVER LOSS - backtest de velas (Forex/cripto) com custos, nos dois sentidos, em unidades de risco (R).
// R = perda no stop: uma perda normal vale -1R, um ganho no alvo vale +tpR. Stake fixa = risco fixo por operação.
// Sem olhar para o futuro: o sinal usa a vela fechada i e a entrada é na abertura da vela i+1.

import { gammaQ } from "./stats.ts";
import { atr } from "./indicators.ts";
import type { Candle } from "./market-data.ts";
import type { Strategy } from "./strategies.ts";

export type ExitReason = "sl" | "tp" | "time";

export interface CandleTrade {
  entryIndex: number;
  exitIndex: number;
  direction: 1 | -1;
  entry: number;
  exit: number;
  /** Resultado em unidades de risco, já com custos. */
  r: number;
  reason: ExitReason;
}

export interface CandleBacktestOptions {
  /** Stop = slAtr x ATR da vela do sinal. */
  slAtr: number;
  /** Alvo = tpR x distância do stop. */
  tpR: number;
  /** Saída por tempo, em velas depois da entrada. */
  maxBars: number;
  /** Custo total de ida e volta como fração do preço de entrada (spread + comissões). */
  costFraction: number;
  atrPeriod?: number;
  directions?: "both" | "long" | "short";
  /** Só entra com sinais nas velas [start, end). As saídas nunca usam velas depois de `end`. */
  start?: number;
  end?: number;
}

export interface RMetrics {
  trades: number;
  wins: number;
  winRate: number;
  netR: number;
  /** Média de R por operação (expectativa). */
  meanR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  longestLosingStreak: number;
  stdDevR: number;
  /** p-value unilateral de a média de R ser > 0 (aproximação normal; só fiável com >= 30 operações). */
  pValue: number | null;
}

function assertOpts(o: CandleBacktestOptions): void {
  if (!(o.slAtr > 0) || !Number.isFinite(o.slAtr)) throw new RangeError(`slAtr inválido: ${o.slAtr}`);
  if (!(o.tpR > 0) || !Number.isFinite(o.tpR)) throw new RangeError(`tpR inválido: ${o.tpR}`);
  if (!Number.isInteger(o.maxBars) || o.maxBars < 1) throw new RangeError(`maxBars inválido: ${o.maxBars}`);
  if (!Number.isFinite(o.costFraction) || o.costFraction < 0) throw new RangeError(`costFraction inválido: ${o.costFraction}`);
}

/** P(média de R > 0 apenas por sorte), com aproximação normal. */
export function expectancyPValue(rs: readonly number[]): number | null {
  const n = rs.length;
  if (n < 2) return null;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  if (sd === 0) return mean > 0 ? 0 : 1;
  const z = mean / (sd / Math.sqrt(n));
  const tail = 0.5 * gammaQ(0.5, (z * z) / 2); // P(Z > |z|)
  return z >= 0 ? tail : 1 - tail;
}

export function summarizeR(rs: readonly number[]): RMetrics {
  const trades = rs.length;
  let wins = 0;
  let net = 0;
  let peak = 0;
  let dd = 0;
  let streak = 0;
  let longest = 0;
  let gw = 0;
  let gl = 0;
  for (const r of rs) {
    net += r;
    if (r > 0) {
      wins += 1;
      gw += r;
      streak = 0;
    } else {
      gl += -r;
      streak += 1;
      if (streak > longest) longest = streak;
    }
    if (net > peak) peak = net;
    if (peak - net > dd) dd = peak - net;
  }
  const mean = trades === 0 ? 0 : net / trades;
  const sd = trades < 2 ? 0 : Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (trades - 1));
  return {
    trades,
    wins,
    winRate: trades === 0 ? 0 : wins / trades,
    netR: net,
    meanR: mean,
    profitFactor: gl === 0 ? null : gw / gl,
    maxDrawdownR: dd,
    longestLosingStreak: longest,
    stdDevR: sd,
    pValue: trades < 2 ? null : expectancyPValue(rs),
  };
}

export interface CandleBacktestResult {
  trades: CandleTrade[];
  metrics: RMetrics;
}

export function runCandleBacktest(
  candles: readonly Candle[],
  strategy: Strategy,
  opts: CandleBacktestOptions,
): CandleBacktestResult {
  assertOpts(opts);
  const n = candles.length;
  const start = opts.start ?? 0;
  const end = opts.end ?? n;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > n || start > end) {
    throw new RangeError(`Intervalo inválido: ${start}..${end}`);
  }
  const dirs = opts.directions ?? "both";
  const signals = strategy.signals(candles);
  if (signals.length !== n) throw new RangeError("A estratégia devolveu um número errado de sinais");
  const atrs = atr(candles, opts.atrPeriod ?? 14);
  const trades: CandleTrade[] = [];

  let i = start;
  while (i < end - 1) {
    const sig = signals[i]!;
    const a = atrs[i];
    const allowed = sig === 1 ? dirs !== "short" : sig === -1 ? dirs !== "long" : false;
    if (!allowed || a === null || a === undefined || !(a > 0)) {
      i += 1;
      continue;
    }
    const dir = sig as 1 | -1;
    const entryIndex = i + 1;
    const entry = candles[entryIndex]!.open;
    const dist = opts.slAtr * a;
    const sl = entry - dir * dist;
    const tp = entry + dir * opts.tpR * dist;
    const cost = (entry * opts.costFraction) / dist;
    const last = Math.min(entryIndex + opts.maxBars, end - 1);

    let exitIndex = last;
    let exitPrice = candles[last]!.close;
    let reason: ExitReason = "time";
    for (let j = entryIndex; j <= last; j++) {
      const c = candles[j]!;
      // Abertura com salto (gap) para além do stop ou do alvo (depois da vela de entrada).
      if (j > entryIndex) {
        if (dir === 1 ? c.open <= sl : c.open >= sl) {
          exitIndex = j; exitPrice = c.open; reason = "sl"; break;
        }
        if (dir === 1 ? c.open >= tp : c.open <= tp) {
          exitIndex = j; exitPrice = c.open; reason = "tp"; break;
        }
      }
      const hitSl = dir === 1 ? c.low <= sl : c.high >= sl;
      const hitTp = dir === 1 ? c.high >= tp : c.low <= tp;
      // Se ambos acontecem na mesma vela, assume-se o pior: o stop primeiro.
      if (hitSl) {
        exitIndex = j; exitPrice = sl; reason = "sl"; break;
      }
      if (hitTp) {
        exitIndex = j; exitPrice = tp; reason = "tp"; break;
      }
    }

    const r = (dir * (exitPrice - entry)) / dist - cost;
    trades.push({ entryIndex, exitIndex, direction: dir, entry, exit: exitPrice, r, reason });
    i = exitIndex; // volta a procurar sinal na vela de saída (a entrada seguinte é na vela seguinte)
    if (i <= entryIndex - 1) i = entryIndex; // segurança: garante progresso
  }

  return { trades, metrics: summarizeR(trades.map((t) => t.r)) };
}

// ---------- Walk-forward ----------

export interface CandleWalkForwardOptions extends Omit<CandleBacktestOptions, "start" | "end"> {
  trainSize: number;
  testSize: number;
  minTrainTrades?: number;
}

export interface CandleFold {
  fold: number;
  trainStart: number;
  testStart: number;
  testEnd: number;
  chosen: string | null;
  train: RMetrics | null;
  test: RMetrics | null;
}

export interface CandleWalkForwardResult {
  folds: CandleFold[];
  oosR: number[];
  oos: RMetrics;
}

/**
 * Em cada bloco escolhe a estratégia com maior lucro (em R) no treino e mede-a no bloco seguinte,
 * que ela nunca viu. Só o resultado fora da amostra conta.
 */
export function walkForwardCandles(
  candles: readonly Candle[],
  strategies: readonly Strategy[],
  opts: CandleWalkForwardOptions,
): CandleWalkForwardResult {
  if (strategies.length === 0) throw new RangeError("Sem estratégias");
  if (!Number.isInteger(opts.trainSize) || opts.trainSize < 1) throw new RangeError("trainSize inválido");
  if (!Number.isInteger(opts.testSize) || opts.testSize < 1) throw new RangeError("testSize inválido");
  const minTrades = opts.minTrainTrades ?? 20;
  const { trainSize, testSize, minTrainTrades: _ignored, ...base } = opts;
  void _ignored;

  const folds: CandleFold[] = [];
  const oosR: number[] = [];
  let start = 0;
  let fold = 0;
  while (start + trainSize + testSize <= candles.length) {
    const testStart = start + trainSize;
    const testEnd = testStart + testSize;

    let chosen: Strategy | null = null;
    let chosenTrain: RMetrics | null = null;
    for (const s of strategies) {
      const m = runCandleBacktest(candles, s, { ...base, start, end: testStart }).metrics;
      if (m.trades < minTrades) continue;
      if (chosenTrain === null || m.netR > chosenTrain.netR) {
        chosen = s;
        chosenTrain = m;
      }
    }

    let test: RMetrics | null = null;
    if (chosen !== null) {
      const r = runCandleBacktest(candles, chosen, { ...base, start: testStart, end: testEnd });
      oosR.push(...r.trades.map((t) => t.r));
      test = r.metrics;
    }
    folds.push({ fold, trainStart: start, testStart, testEnd, chosen: chosen?.name ?? null, train: chosenTrain, test });
    fold += 1;
    start += testSize;
  }
  return { folds, oosR, oos: summarizeR(oosR) };
}
