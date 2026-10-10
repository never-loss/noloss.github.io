// NEVER LOSS - livro-razão da porta (gate ledger): resultado FINAL por bloco alinhado à época.
// Ideia: o walk-forward é a soma de blocos independentes. Cada bloco (≈500 velas, alinhado à época) mede, fora da
// amostra, a estratégia escolhida no treino imediatamente anterior. Um bloco fechado nunca muda → guarda-se uma vez
// e só se calculam os blocos novos (incremental), em vez de refazer 90 dias de velas a cada pedido.
//
// Propriedades garantidas por construção (e por testes):
//  - Sem olhar para o futuro: o bloco só usa velas até ao seu fim; acrescentar velas depois nunca o altera.
//  - Independente da profundidade: usa um aquecimento (warmup) FIXO de velas antes do treino; ter mais história à
//    esquerda não muda o resultado de nenhum bloco.
//  - Incremental == recálculo completo (bit a bit).
//  - A chave inclui versão + hash dos parâmetros/estratégias: mudou a lógica → livro antigo é descartado.
// Nada aqui garante lucro: é só contabilidade honesta do que aconteceu fora da amostra, com custos.

import { runCandleBacktest, prepareBacktest, summarizeR } from "./candle-backtest.ts";
import type { RMetrics } from "./candle-backtest.ts";
import { atr } from "./indicators.ts";
import { classify } from "./stats.ts";
import { GATE_ALPHA } from "./gate.ts";
import { requiredOosForCandleMinLabel, candleLabelPermitted } from "./candle-gate.ts";
import type { CandleGateOptions, CandleGateResult } from "./candle-gate.ts";
import type { Strategy } from "./strategies.ts";
import type { Candle } from "./market-data.ts";

/**
 * Subir sempre que mudar a lógica de estratégias, indicadores, custos ou do backtest: livros antigos deixam de valer.
 * (Há um teste "golden" que falha quando o resultado muda sem esta versão subir.)
 */
export const LEDGER_VERSION = 1;
export const LEDGER_BLOCK_CANDLES = 500;
export const LEDGER_WARMUP = 600;
export const LEDGER_KEEP_FOLDS = 160;

export interface LedgerParams {
  gran: number;
  blockCandles: number;
  trainSize: number;
  warmup: number;
  slAtr: number;
  tpR: number;
  maxBars: number;
  costFraction: number;
  atrPeriod: number;
  directions: "both" | "long" | "short";
  minTrainTrades: number;
  /** Nomes das estratégias, por ordem (o nome inclui os parâmetros de cada uma). */
  strategies: string[];
}

export interface LedgerFold {
  /** Índice do bloco alinhado: floor(época / (blockCandles × gran)). */
  block: number;
  /** [start, end) em segundos desde a época. */
  start: number;
  end: number;
  nCandles: number;
  chosen: string | null;
  trainTrades: number;
  trainNetR: number | null;
  /** Estatísticas fora da amostra do bloco. */
  n: number;
  sumR: number;
  sumR2: number;
  wins: number;
  /** Cada R fora da amostra (ordem cronológica) — permite recompor p-value exacto. */
  r: number[];
}

export interface GateLedger {
  version: number;
  paramsHash: string;
  params: LedgerParams;
  folds: LedgerFold[];
}

/** Hash determinístico de 53 bits (cyrb53) em hexadecimal. Não é criptográfico: serve de chave de versão. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function paramsHash(p: LedgerParams): string {
  const canon = JSON.stringify([
    LEDGER_VERSION, p.gran, p.blockCandles, p.trainSize, p.warmup, p.slAtr, p.tpR, p.maxBars, p.costFraction,
    p.atrPeriod, p.directions, p.minTrainTrades, p.strategies,
  ]);
  return hashString(canon);
}

export function makeLedgerParams(
  strategies: readonly Strategy[],
  gate: Pick<CandleGateOptions, "slAtr" | "tpR" | "maxBars" | "costFraction" | "trainSize" | "atrPeriod" | "directions" | "minTrainTrades">,
  gran: number,
  over: { blockCandles?: number; warmup?: number } = {},
): LedgerParams {
  if (!Number.isInteger(gran) || gran < 1) throw new RangeError("gran inválida");
  const blockCandles = over.blockCandles ?? LEDGER_BLOCK_CANDLES;
  const warmup = over.warmup ?? LEDGER_WARMUP;
  if (!Number.isInteger(blockCandles) || blockCandles < 1) throw new RangeError("blockCandles inválido");
  if (!Number.isInteger(warmup) || warmup < 0) throw new RangeError("warmup inválido");
  if (!Number.isInteger(gate.trainSize) || gate.trainSize < 1) throw new RangeError("trainSize inválido");
  return {
    gran,
    blockCandles,
    trainSize: gate.trainSize,
    warmup,
    slAtr: gate.slAtr,
    tpR: gate.tpR,
    maxBars: gate.maxBars,
    costFraction: gate.costFraction,
    atrPeriod: gate.atrPeriod ?? 14,
    directions: gate.directions ?? "both",
    minTrainTrades: gate.minTrainTrades ?? 20,
    strategies: strategies.map((s) => s.name),
  };
}

/** Velas necessárias (cauda) para calcular um bloco novo: aquecimento + treino + bloco. */
export function ledgerTailNeeded(p: LedgerParams, blocks = 2): number {
  return p.warmup + p.trainSize + p.blockCandles * blocks;
}

export function blockSeconds(p: LedgerParams): number {
  return p.blockCandles * p.gran;
}

/** Primeiro índice com época >= e (as velas estão por ordem crescente de época). */
function lowerBound(candles: readonly Candle[], e: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]!.epoch < e) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function assertAscending(candles: readonly Candle[]): void {
  for (let i = 1; i < candles.length; i++) {
    if (!(candles[i]!.epoch > candles[i - 1]!.epoch)) throw new RangeError("velas fora de ordem ou duplicadas");
  }
}

/** Calcula UM bloco (função pura de velas [bi - treino - aquecimento, be) e dos parâmetros). */
function computeFold(
  candles: readonly Candle[],
  block: number,
  bi: number,
  be: number,
  p: LedgerParams,
  strategies: readonly Strategy[],
): LedgerFold {
  const T = p.trainSize;
  const W = p.warmup;
  const local = candles.slice(bi - T - W, be);
  const trainStart = W;
  const testStart = W + T;
  const bt = { slAtr: p.slAtr, tpR: p.tpR, maxBars: p.maxBars, costFraction: p.costFraction, atrPeriod: p.atrPeriod, directions: p.directions };
  const atrs = atr(local, p.atrPeriod);
  const prepared = strategies.map((s) => ({ s, prep: { signals: s.signals(local), atrs } }));

  let chosen: (typeof prepared)[number] | null = null;
  let chosenTrain: RMetrics | null = null;
  for (const x of prepared) {
    const m = runCandleBacktest(local, x.s, { ...bt, start: trainStart, end: testStart }, x.prep).metrics;
    if (m.trades < p.minTrainTrades) continue;
    if (chosenTrain === null || m.netR > chosenTrain.netR) {
      chosen = x;
      chosenTrain = m;
    }
  }
  const r: number[] = [];
  if (chosen !== null) {
    const res = runCandleBacktest(local, chosen.s, { ...bt, start: testStart, end: local.length }, chosen.prep);
    for (const t of res.trades) r.push(t.r);
  }
  let sumR = 0;
  let sumR2 = 0;
  let wins = 0;
  for (const x of r) {
    sumR += x;
    sumR2 += x * x;
    if (x > 0) wins += 1;
  }
  const bs = blockSeconds(p);
  return {
    block,
    start: block * bs,
    end: (block + 1) * bs,
    nCandles: be - bi,
    chosen: chosen?.s.name ?? null,
    trainTrades: chosenTrain?.trades ?? 0,
    trainNetR: chosenTrain?.netR ?? null,
    n: r.length,
    sumR,
    sumR2,
    wins,
    r,
  };
}

export interface UpdateLedgerOptions {
  /** Máximo de blocos guardados (os mais antigos saem). */
  keepFolds?: number;
}

/**
 * Acrescenta ao livro os blocos FECHADOS ainda em falta (incremental). Um bloco só entra quando as velas cobrem todo o
 * seu intervalo e há `warmup + treino` velas antes dele. Se `prev` tiver versão/hash diferente, é descartado.
 * `candles`: ordem crescente, só velas fechadas (pode ser só a cauda; ver ledgerTailNeeded).
 */
export function updateLedger(
  prev: GateLedger | null,
  candles: readonly Candle[],
  strategies: readonly Strategy[],
  params: LedgerParams,
  opts: UpdateLedgerOptions = {},
): GateLedger {
  if (strategies.length === 0) throw new RangeError("Sem estratégias");
  if (strategies.length !== params.strategies.length || strategies.some((s, i) => s.name !== params.strategies[i])) {
    throw new RangeError("estratégias não correspondem aos parâmetros do livro");
  }
  assertAscending(candles);
  const hash = paramsHash(params);
  const valid = prev !== null && prev.version === LEDGER_VERSION && prev.paramsHash === hash;
  let folds: LedgerFold[] = valid ? prev!.folds.slice() : [];
  if (candles.length > 0) {
    const bs = blockSeconds(params);
    const first = candles[0]!.epoch;
    const lastEnd = candles[candles.length - 1]!.epoch + params.gran; // fim da última vela fechada
    const lastKnown = folds.length ? folds[folds.length - 1]!.block : Number.NEGATIVE_INFINITY;
    let b = Math.max(Math.floor(first / bs), Number.isFinite(lastKnown) ? lastKnown + 1 : Number.NEGATIVE_INFINITY);
    for (; (b + 1) * bs <= lastEnd; b++) {
      const bi = lowerBound(candles, b * bs);
      const be = lowerBound(candles, (b + 1) * bs);
      if (be - bi < 1) continue;
      // O bloco tem de começar de facto no início do intervalo (não a meio, por falta de velas à esquerda).
      if (bi - params.trainSize - params.warmup < 0) continue;
      folds.push(computeFold(candles, b, bi, be, params, strategies));
    }
  }
  const keep = opts.keepFolds ?? LEDGER_KEEP_FOLDS;
  if (folds.length > keep) folds = folds.slice(folds.length - keep);
  return { version: LEDGER_VERSION, paramsHash: hash, params, folds };
}

export function computeLedger(candles: readonly Candle[], strategies: readonly Strategy[], params: LedgerParams, opts: UpdateLedgerOptions = {}): GateLedger {
  return updateLedger(null, candles, strategies, params, opts);
}

/** OOS agregado dos blocos (recompõe a lista de R → p-value exacto, igual ao do walk-forward). */
export function ledgerOos(ledger: GateLedger, lastFolds?: number): RMetrics {
  const folds = lastFolds !== undefined ? ledger.folds.slice(-lastFolds) : ledger.folds;
  const rs: number[] = [];
  for (const f of folds) for (const x of f.r) rs.push(x);
  return summarizeR(rs);
}

export interface LedgerGateResult extends CandleGateResult {
  folds: number;
  /** Blocos com soma de R > 0 (e com operações). */
  foldsPositive: number;
  foldsWithTrades: number;
  /** Fim (época, s) do último bloco fechado incluído. */
  asOf: number | null;
  /** Dias de história fora da amostra coberta pelos blocos. */
  depthDays: number;
}

const sgn = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;

/**
 * Veredicto da porta a partir do livro (mesmos limiares que evaluateCandleGate: alpha, mínimo de OOS do modo, etiqueta).
 * A estratégia a usar agora escolhe-se na cauda recente (últimas `warmup + treino` velas), como na porta clássica.
 */
export function evaluateLedgerGate(
  ledger: GateLedger,
  tail: readonly Candle[],
  strategies: readonly Strategy[],
  gate: Pick<CandleGateOptions, "minLabel" | "alpha">,
): LedgerGateResult {
  const p = ledger.params;
  const alpha = gate.alpha ?? GATE_ALPHA;
  const minLabel = gate.minLabel ?? "PRELIMINARY";
  const f = ledger.folds;
  const withTrades = f.filter((x) => x.n > 0);
  const positive = withTrades.filter((x) => x.sumR > 0).length;
  const asOf = f.length ? f[f.length - 1]!.end : null;
  const depthDays = f.length ? (f[f.length - 1]!.end - f[0]!.start) / 86400 : 0;
  const meta = { folds: f.length, foldsPositive: positive, foldsWithTrades: withTrades.length, asOf, depthDays };
  const closedRes = (label: CandleGateResult["label"], reason: string, over: Partial<CandleGateResult> = {}): LedgerGateResult => ({
    allowed: false, label, reason, strategy: null, oosTrades: 0, meanR: 0, pValue: null, ...over, ...meta,
  });

  const oos = ledgerOos(ledger);
  const needOos = requiredOosForCandleMinLabel(minLabel);
  if (oos.trades < needOos || oos.pValue === null) {
    return closedRes("INSUFFICIENT", `só ${oos.trades} operações fora da amostra (mínimo ${needOos})`, { oosTrades: oos.trades });
  }
  const base = { oosTrades: oos.trades, meanR: oos.meanR, pValue: oos.pValue };
  if (oos.pValue >= alpha || oos.meanR <= 0) {
    return closedRes("NO_EVIDENCE", `sem evidência: média ${sgn(oos.meanR)}R por operação em ${oos.trades} operações (p = ${oos.pValue.toFixed(3)})`, base);
  }
  const label = classify(oos.trades, oos.pValue);
  if (!candleLabelPermitted(label, minLabel)) {
    return closedRes(label, `evidência ${label} insuficiente para este modo (pede ${minLabel})`, base);
  }

  const need = p.trainSize + p.warmup;
  if (tail.length < need) return closedRes(label, `cauda curta (${tail.length} de ${need} velas) para escolher a estratégia`, base);
  const local = tail.slice(tail.length - need);
  const bt = { slAtr: p.slAtr, tpR: p.tpR, maxBars: p.maxBars, costFraction: p.costFraction, atrPeriod: p.atrPeriod, directions: p.directions };
  let best: Strategy | null = null;
  let bestNet = -Infinity;
  for (const s of strategies) {
    const prep = prepareBacktest(local, s, p.atrPeriod);
    const m = runCandleBacktest(local, s, { ...bt, start: p.warmup, end: local.length }, prep).metrics;
    if (m.trades < p.minTrainTrades) continue;
    if (m.netR > bestNet) {
      best = s;
      bestNet = m.netR;
    }
  }
  if (best === null) return closedRes(label, "nenhuma estratégia serviu no treino recente", base);
  return {
    allowed: true,
    label,
    reason: `evidência ${label}: média ${sgn(oos.meanR)}R em ${oos.trades} operações (p = ${oos.pValue.toFixed(4)}); estratégia ${best.name}`,
    strategy: best,
    ...base,
    ...meta,
  };
}
