// NEVER LOSS - backtest e walk-forward (Fase 3).
// Regras de ouro: stake fixa, sem martingale, e NUNCA olhar para o futuro:
// a regra só vê os dígitos ANTERIORES ao tick em que entra.

import { didWin, evaluateContract } from "./stats.ts";
import type { DigitContract, ContractEvaluation } from "./stats.ts";

/** Quantos dígitos passados uma regra pode ver (as janelas do projeto vão até 500). */
export const MAX_HISTORY = 500;

export interface Rule {
  name: string;
  /** Retorno por win, em unidades de stake (ex.: 0,82). Vem da Deriv, não é assumido pelo bot. */
  returnRate: number;
  /** Só usa `history` (dígitos anteriores à entrada). Devolve o contrato, ou null = NO TRADE. */
  decide(history: readonly number[]): DigitContract | null;
}

function assertReturnRate(r: number): void {
  if (!Number.isFinite(r) || r <= 0) throw new RangeError(`returnRate inválido: ${r}`);
}

function assertPositiveInt(v: number, label: string): void {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${label} inválido: ${v}`);
}

export function makeRule(
  name: string,
  returnRate: number,
  decide: (history: readonly number[]) => DigitContract | null,
): Rule {
  assertReturnRate(returnRate);
  return { name, returnRate, decide };
}

// ---------- Métricas ----------

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Lucro líquido em unidades de stake (win = +returnRate, loss = -1). */
  netUnits: number;
  /** Maior queda do lucro acumulado, em unidades de stake (número positivo). */
  maxDrawdown: number;
  longestLosingStreak: number;
  /** Ganhos brutos / perdas brutas. null se não houve perdas. */
  profitFactor: number | null;
  /** Desvio-padrão do resultado por operação. */
  stdDev: number;
  /** Estatística contra o break-even. null se não houve operações. */
  evaluation: ContractEvaluation | null;
}

export function summarize(outcomes: readonly boolean[], returnRate: number): Metrics {
  assertReturnRate(returnRate);
  const trades = outcomes.length;
  let wins = 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let streak = 0;
  let longest = 0;
  let grossWin = 0;
  let grossLoss = 0;
  const pnl: number[] = [];

  for (const won of outcomes) {
    const x = won ? returnRate : -1;
    pnl.push(x);
    equity += x;
    if (won) {
      wins += 1;
      grossWin += returnRate;
      streak = 0;
    } else {
      grossLoss += 1;
      streak += 1;
      if (streak > longest) longest = streak;
    }
    if (equity > peak) peak = equity;
    if (peak - equity > maxDrawdown) maxDrawdown = peak - equity;
  }

  let stdDev = 0;
  if (trades >= 2) {
    const mean = equity / trades;
    const variance = pnl.reduce((s, x) => s + (x - mean) ** 2, 0) / (trades - 1);
    stdDev = Math.sqrt(variance);
  }

  return {
    trades,
    wins,
    losses: trades - wins,
    winRate: trades === 0 ? 0 : wins / trades,
    netUnits: equity,
    maxDrawdown,
    longestLosingStreak: longest,
    profitFactor: grossLoss === 0 ? null : grossWin / grossLoss,
    stdDev,
    evaluation: trades === 0 ? null : evaluateContract(wins, trades, returnRate),
  };
}

// ---------- Backtest ----------

export interface BacktestResult {
  outcomes: boolean[];
  metrics: Metrics;
}

export interface BacktestOptions {
  /** Primeiro tick em que pode entrar (inclusive). Por defeito 0. */
  start?: number;
  /** Último tick + 1 (exclusive). Por defeito, o fim dos dados. */
  end?: number;
}

function assertDigits(digits: readonly number[]): void {
  for (const d of digits) {
    if (!Number.isInteger(d) || d < 0 || d > 9) throw new RangeError(`Dígito inválido: ${d}`);
  }
}

/**
 * Para cada tick t: a regra vê só digits[0..t-1] (no máximo os últimos 500),
 * decide, e o resultado é medido em digits[t]. Stake fixa: win = +returnRate, loss = -1.
 */
export function runBacktest(
  digits: readonly number[],
  rule: Rule,
  opts: BacktestOptions = {},
): BacktestResult {
  assertDigits(digits);
  assertReturnRate(rule.returnRate);
  const start = opts.start ?? 0;
  const end = opts.end ?? digits.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > digits.length || start > end) {
    throw new RangeError(`Intervalo inválido: ${start}..${end}`);
  }

  const outcomes: boolean[] = [];
  for (let t = start; t < end; t++) {
    const history = digits.slice(Math.max(0, t - MAX_HISTORY), t);
    const contract = rule.decide(history);
    if (contract === null) continue;
    outcomes.push(didWin(digits[t]!, contract));
  }
  return { outcomes, metrics: summarize(outcomes, rule.returnRate) };
}

// ---------- Regras de exemplo ----------

/** Referência: aposta em todos os ticks no mesmo contrato. Serve para comparar. */
export function baselineRule(contract: DigitContract, returnRate: number): Rule {
  return makeRule(`referencia ${contract.type}`, returnRate, () => contract);
}

/** Se o dígito mais frequente da janela tem pelo menos minPct%, aposta que sai (match). */
export function dominantDigitMatch(opts: { window: number; minPct: number; returnRate: number }): Rule {
  assertPositiveInt(opts.window, "window");
  if (opts.window > MAX_HISTORY) throw new RangeError(`window máximo é ${MAX_HISTORY}`);
  if (!Number.isFinite(opts.minPct) || opts.minPct < 0 || opts.minPct > 100) {
    throw new RangeError(`minPct inválido: ${opts.minPct}`);
  }
  const { window, minPct } = opts;
  return makeRule(`dominante-match w${window} >=${minPct}%`, opts.returnRate, (history) => {
    if (history.length < window) return null;
    const counts = new Array<number>(10).fill(0);
    for (const d of history.slice(-window)) counts[d]! += 1;
    let best = 0;
    for (let d = 1; d < 10; d++) if (counts[d]! > counts[best]!) best = d;
    return (counts[best]! / window) * 100 >= minPct ? { type: "match", digit: best } : null;
  });
}

/** Se algum dígito não saiu nos últimos K ticks, aposta que sai (match). */
export function absentDigitMatch(opts: { absentTicks: number; returnRate: number }): Rule {
  assertPositiveInt(opts.absentTicks, "absentTicks");
  if (opts.absentTicks > MAX_HISTORY) throw new RangeError(`absentTicks máximo é ${MAX_HISTORY}`);
  const k = opts.absentTicks;
  return makeRule(`ausente-match k${k}`, opts.returnRate, (history) => {
    if (history.length < k) return null;
    const seen = new Set(history.slice(-k));
    for (let d = 0; d < 10; d++) if (!seen.has(d)) return { type: "match", digit: d };
    return null;
  });
}

/** Depois de `length` dígitos seguidos com a mesma paridade, aposta que continua (follow) ou inverte. */
export function parityStreak(opts: { length: number; follow: boolean; returnRate: number }): Rule {
  assertPositiveInt(opts.length, "length");
  if (opts.length > MAX_HISTORY) throw new RangeError(`length máximo é ${MAX_HISTORY}`);
  const { length, follow } = opts;
  return makeRule(`paridade ${follow ? "segue" : "inverte"} ${length}`, opts.returnRate, (history) => {
    if (history.length < length) return null;
    const last = history.slice(-length);
    const parity = last[0]! % 2;
    if (!last.every((d) => d % 2 === parity)) return null;
    const sameIsEven = parity === 0;
    const bet = follow ? sameIsEven : !sameIsEven;
    return { type: bet ? "even" : "odd" };
  });
}

// ---------- Walk-forward ----------

export interface WalkForwardOptions {
  trainSize: number;
  testSize: number;
  /** Mínimo de operações no treino para uma regra poder ser escolhida. Por defeito 30. */
  minTrainTrades?: number;
}

export interface WalkForwardFold {
  fold: number;
  trainStart: number;
  testStart: number;
  testEnd: number;
  /** Regra escolhida no treino (null = nenhuma serviu = NO TRADE neste bloco). */
  chosen: string | null;
  train: Metrics | null;
  test: Metrics | null;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  oosOutcomes: boolean[];
  /** Resultado fora da amostra (só dados que a escolha da regra nunca viu). */
  oos: Metrics;
}

/**
 * Em cada bloco: escolhe a melhor regra no treino (maior lucro líquido) e mede-a
 * no bloco seguinte, que ela nunca viu. Só esse resultado fora da amostra conta.
 * Todas as regras candidatas têm de partilhar o mesmo returnRate.
 */
export function walkForward(
  digits: readonly number[],
  candidates: readonly Rule[],
  opts: WalkForwardOptions,
): WalkForwardResult {
  assertDigits(digits);
  if (candidates.length === 0) throw new RangeError("Sem regras candidatas");
  const returnRate = candidates[0]!.returnRate;
  if (candidates.some((c) => c.returnRate !== returnRate)) {
    throw new RangeError("Todas as regras candidatas têm de ter o mesmo returnRate");
  }
  assertPositiveInt(opts.trainSize, "trainSize");
  assertPositiveInt(opts.testSize, "testSize");
  const minTrainTrades = opts.minTrainTrades ?? 30;

  const folds: WalkForwardFold[] = [];
  const oosOutcomes: boolean[] = [];

  let start = 0;
  let fold = 0;
  while (start + opts.trainSize + opts.testSize <= digits.length) {
    const testStart = start + opts.trainSize;
    const testEnd = testStart + opts.testSize;

    let chosen: Rule | null = null;
    let chosenTrain: Metrics | null = null;
    for (const rule of candidates) {
      const m = runBacktest(digits, rule, { start, end: testStart }).metrics;
      if (m.trades < minTrainTrades) continue;
      if (chosenTrain === null || m.netUnits > chosenTrain.netUnits) {
        chosen = rule;
        chosenTrain = m;
      }
    }

    let test: Metrics | null = null;
    if (chosen !== null) {
      const r = runBacktest(digits, chosen, { start: testStart, end: testEnd });
      oosOutcomes.push(...r.outcomes);
      test = r.metrics;
    }

    folds.push({
      fold,
      trainStart: start,
      testStart,
      testEnd,
      chosen: chosen === null ? null : chosen.name,
      train: chosenTrain,
      test,
    });
    fold += 1;
    start += opts.testSize;
  }

  return { folds, oosOutcomes, oos: summarize(oosOutcomes, returnRate) };
                                               }
