// NEVER LOSS - serviço da porta em cache: junta o livro-razão (gate-ledger) aos presets (Lucro rápido, Loss zero,
// Agressivo/blitz_zero) e produz o registo que o servidor guarda no Redis e que a UI/arm lêem.
// Puro (sem rede, sem Redis): o servidor trata do IO. Só Bybit Linear USDT, velas de 5 min.
// Nada aqui promete lucro: é o veredicto estatístico fora da amostra, com custos, e diz a profundidade usada.

import { computeLedger, updateLedger, evaluateLedgerGate, makeLedgerParams, ledgerTailNeeded, ledgerOos, LEDGER_VERSION, paramsHash } from "./gate-ledger.ts";
import { ledgerAsOf, GATE_VERDICT_FOLDS } from "./ledger-gate-controller.ts";
import { legacyVerdict } from "./gate-shadow.ts";
import type { LegacyVerdict } from "./gate-shadow.ts";
import type { GateLedger, LedgerParams } from "./gate-ledger.ts";
import { strategiesForPreset, strategyPreset } from "./strategies.ts";
import type { Strategy } from "./strategies.ts";
import { feasible } from "./feasible.ts";
import { MARKETS } from "./markets.ts";
import type { Candle } from "./market-data.ts";

export const GATE_PRESET_IDS = ["lucro_rapido", "loss_zero", "blitz_zero"] as const;
export type GatePresetId = (typeof GATE_PRESET_IDS)[number];

/** Única granularidade em cache: 5 min (a do gráfico). */
export const GATE_GRAN = 300;
export const GATE_MIN_MULTIPLIER = 100;
export const GATE_TRAIN = 1000;
export const GATE_BLOCK = 500;
export const GATE_WARMUP = 600;
/** Blocos guardados por preset (≈ 208 dias de 5m). */
export const GATE_KEEP_FOLDS = 120;
/** Velas guardadas na cauda: aquecimento + treino + 2 blocos (2600) + folga. */
export const GATE_TAIL_KEEP = 2700;
/** Histórico inicial (arranque a frio), em dias. */
export const GATE_COLD_DAYS = 90;
/** Mínimo de velas entre duas validações que contam para a confirmação (igual ao revalidateEvery do arm). */
export const GATE_STREAK_GAP_CANDLES = 12;
/** Validações positivas seguidas para considerar a porta aberta (igual ao CandleGateController). */
export const GATE_CONFIRMATIONS = 2;
/** Se o buraco desde a última vela guardada for maior que isto, refaz-se o arranque a frio (para o livro não ter buracos). */
export const GATE_MAX_WARM_GAP_CANDLES = 480;
/** Veredicto considerado fresco durante este tempo (3 velas de 5m). */
export const GATE_FRESH_MS = 15 * 60 * 1000;

export interface GateSetup {
  presetId: GatePresetId;
  strategies: Strategy[];
  params: LedgerParams;
  minLabel: "AGILE" | "PRELIMINARY" | "EVIDENCE";
}

export function gateCostFraction(): number {
  return MARKETS.crypto.assumedCostFraction;
}

export function gateSetup(presetId: GatePresetId, gran: number = GATE_GRAN, costFraction: number = gateCostFraction()): GateSetup {
  const preset = strategyPreset(presetId);
  if (!preset) throw new RangeError(`preset desconhecido: ${presetId}`);
  const g = preset.preferredGate ?? {};
  const slAtr = g.slAtr || 1.5;
  const strategies = strategiesForPreset(presetId).map((s) => feasible(s, { slAtr, maxStopFraction: 1 / GATE_MIN_MULTIPLIER }));
  const params = makeLedgerParams(
    strategies,
    { slAtr, tpR: g.tpR || 2, maxBars: g.maxBars || 24, costFraction, trainSize: GATE_TRAIN },
    gran,
    { blockCandles: GATE_BLOCK, warmup: GATE_WARMUP },
  );
  return { presetId, strategies, params, minLabel: g.minLabel || "PRELIMINARY" };
}

export interface GateVerdict {
  allowed: boolean;
  label: string;
  reason: string;
  strategy: string | null;
  nOOS: number;
  meanR: number;
  p: number | null;
  folds: number;
  foldsPositive: number;
  foldsWithTrades: number;
  /** Fim (época, s) do último bloco fechado usado. */
  asOf: number | null;
  /** Dias de história fora da amostra cobertos pelos blocos. */
  depthDays: number;
  /** Validações positivas seguidas (separadas por >= 12 velas). Fecha a 0 de imediato. */
  streak: number;
  /** Época da última vela com que o streak foi contado. */
  streakAt: number | null;
  minLabel: string;
  needOos: number;
  /** Média de R e p-value do OOS agregado mesmo abaixo do mínimo do preset (para o FDR; informativo). */
  oosMeanR?: number;
  oosP?: number | null;
  /** MODO SOMBRA: o que a porta ANTIGA (walk-forward curto sobre a cauda) diria. Só informativo. */
  legacy?: LegacyVerdict;
}

export interface GateConfigInfo {
  gran: number;
  minMultiplier: number;
  costFraction: number;
  trainSize: number;
  blockCandles: number;
  warmup: number;
  ledgerVersion: number;
  /** Hash de parâmetros por preset (muda se a lógica/parâmetros mudarem). */
  hashes: Record<string, string>;
}

/** Parte pública (pequena) do registo: é o que se lê para o radar e o Analisar. */
export interface GateSummary {
  v: 1;
  symbol: string;
  gran: number;
  /** ms */
  updatedAt: number;
  /** Época (s) de início da última vela fechada guardada. */
  lastEpoch: number;
  /** Época (s) da vela mais antiga descarregada no arranque a frio. */
  historyFrom: number | null;
  cfg: GateConfigInfo;
  verdicts: Record<string, GateVerdict>;
}

export interface GateEntry extends GateSummary {
  ledgers: Record<string, GateLedger>;
  /** [época, open, high, low, close] — velas fechadas, ordem crescente. */
  tail: number[][];
}

export function summarizeEntry(e: GateEntry): GateSummary {
  const { ledgers: _l, tail: _t, ...rest } = e;
  void _l;
  void _t;
  return rest;
}

export function candlesToTail(candles: readonly Candle[], keep = GATE_TAIL_KEEP): number[][] {
  return candles.slice(-keep).map((c) => [c.epoch, c.open, c.high, c.low, c.close]);
}

export function tailToCandles(tail: readonly (readonly number[])[]): Candle[] {
  return tail.map((r) => ({ epoch: r[0]!, open: r[1]!, high: r[2]!, low: r[3]!, close: r[4]! }));
}

/** Streak com histerese: só soma se passaram >= minGap velas desde a última contagem; fecha a 0 de imediato. */
export function nextStreak(
  prev: { streak: number; streakAt: number | null } | null,
  allowed: boolean,
  lastEpoch: number,
  gran: number,
  minGapCandles: number = GATE_STREAK_GAP_CANDLES,
): { streak: number; streakAt: number | null } {
  if (!allowed) return { streak: 0, streakAt: null };
  if (!prev || prev.streak < 1 || prev.streakAt === null) return { streak: 1, streakAt: lastEpoch };
  if (lastEpoch - prev.streakAt >= minGapCandles * gran) return { streak: prev.streak + 1, streakAt: lastEpoch };
  return { streak: prev.streak, streakAt: prev.streakAt };
}

export function configInfo(setups: readonly GateSetup[]): GateConfigInfo {
  const hashes: Record<string, string> = {};
  for (const s of setups) hashes[s.presetId] = paramsHash(s.params);
  return {
    gran: GATE_GRAN,
    minMultiplier: GATE_MIN_MULTIPLIER,
    costFraction: gateCostFraction(),
    trainSize: GATE_TRAIN,
    blockCandles: GATE_BLOCK,
    warmup: GATE_WARMUP,
    ledgerVersion: LEDGER_VERSION,
    hashes,
  };
}

export interface ComputeGateOptions {
  presets?: readonly GatePresetId[];
  /** Época (s) da vela mais antiga do histórico descarregado (só informação). */
  historyFrom?: number | null;
}

/**
 * Calcula (ou actualiza) o registo da porta de um símbolo.
 * `candles`: velas FECHADAS, ordem crescente (cauda guardada + novas, ou histórico completo no arranque a frio).
 * `prev`: registo anterior (livros e streak são reaproveitados se os hashes ainda coincidirem).
 */
export function computeGateEntry(
  prev: GateEntry | null,
  symbol: string,
  candles: readonly Candle[],
  nowMs: number,
  opts: ComputeGateOptions = {},
): GateEntry {
  if (candles.length === 0) throw new RangeError("sem velas");
  const ids = opts.presets ?? GATE_PRESET_IDS;
  const setups = ids.map((id) => gateSetup(id));
  const lastEpoch = candles[candles.length - 1]!.epoch;
  const tailForGate = candles.slice(-Math.max(GATE_TAIL_KEEP, ledgerTailNeeded(setups[0]!.params, 2)));
  const verdicts: Record<string, GateVerdict> = {};
  const ledgers: Record<string, GateLedger> = {};
  for (const s of setups) {
    const prevLedger = prev && prev.symbol === symbol ? prev.ledgers[s.presetId] ?? null : null;
    const ledger = prevLedger
      ? updateLedger(prevLedger, candles, s.strategies, s.params, { keepFolds: GATE_KEEP_FOLDS })
      : computeLedger(candles, s.strategies, s.params, { keepFolds: GATE_KEEP_FOLDS });
    ledgers[s.presetId] = ledger;
    // Mesma regra do arm: só os blocos mais recentes (GATE_VERDICT_FOLDS) contam.
    const r = evaluateLedgerGate(ledgerAsOf(ledger, Number.POSITIVE_INFINITY, GATE_VERDICT_FOLDS), tailForGate, s.strategies, { minLabel: s.minLabel });
    const sameCfg = prevLedger !== null && prevLedger.paramsHash === ledger.paramsHash;
    const pv = sameCfg && prev ? prev.verdicts[s.presetId] ?? null : null;
    const st = nextStreak(pv ? { streak: pv.streak, streakAt: pv.streakAt } : null, r.allowed, lastEpoch, GATE_GRAN);
    const oosAgg = ledgerOos(ledgerAsOf(ledger, Number.POSITIVE_INFINITY, GATE_VERDICT_FOLDS));
    const legacy = legacyVerdict(tailForGate, s.strategies, {
      slAtr: s.params.slAtr, tpR: s.params.tpR, maxBars: s.params.maxBars, costFraction: s.params.costFraction, minLabel: s.minLabel,
    });
    verdicts[s.presetId] = {
      allowed: r.allowed,
      label: r.label,
      reason: r.reason,
      strategy: r.strategy ? r.strategy.name : null,
      nOOS: r.oosTrades,
      meanR: r.meanR,
      p: r.pValue,
      folds: r.folds,
      foldsPositive: r.foldsPositive,
      foldsWithTrades: r.foldsWithTrades,
      asOf: r.asOf,
      depthDays: Math.round(r.depthDays * 10) / 10,
      streak: st.streak,
      streakAt: st.streakAt,
      minLabel: s.minLabel,
      needOos: s.minLabel === "EVIDENCE" ? 1000 : s.minLabel === "AGILE" ? 10 : 100,
      oosMeanR: oosAgg.meanR,
      oosP: oosAgg.pValue,
      legacy,
    };
  }
  return {
    v: 1,
    symbol,
    gran: GATE_GRAN,
    updatedAt: nowMs,
    lastEpoch,
    historyFrom: opts.historyFrom ?? prev?.historyFrom ?? candles[0]!.epoch,
    cfg: configInfo(setups),
    verdicts,
    ledgers,
    tail: candlesToTail(candles),
  };
}

/** A porta está aberta quando o veredicto passa E o streak atingiu as confirmações (como o CandleGateController). */
export function verdictIsOpen(v: GateVerdict, confirmations: number = GATE_CONFIRMATIONS): boolean {
  return v.allowed && v.streak >= confirmations;
}

export function isFresh(s: Pick<GateSummary, "updatedAt">, nowMs: number, maxAgeMs: number = GATE_FRESH_MS): boolean {
  return nowMs - s.updatedAt <= maxAgeMs;
}

export { legacyVerdict, summarizeShadow, fdrByPreset, shadowRelation, benjaminiHochberg, FDR_Q, FDR_MIN_OOS } from "./gate-shadow.ts";
export type { LegacyVerdict, ShadowPresetStats, FdrFlag } from "./gate-shadow.ts";
