// NEVER LOSS - porta de evidência para velas: o bot só opera se a estratégia passar num teste fora da amostra,
// com custos, e só com operações executáveis. Caso contrário: NO TRADE, e diz porquê.

import { walkForwardCandles, runCandleBacktest } from "./candle-backtest.ts";
import { classify, PRELIMINARY_MIN_OBS } from "./stats.ts";
import type { EvidenceLabel } from "./stats.ts";
import type { Strategy, Signal } from "./strategies.ts";
import type { Candle } from "./market-data.ts";
import { GATE_ALPHA } from "./gate.ts";

export interface CandleGateOptions {
  slAtr: number;
  tpR: number;
  maxBars: number;
  costFraction: number;
  trainSize: number;
  testSize: number;
  atrPeriod?: number;
  directions?: "both" | "long" | "short";
  minLabel?: "PRELIMINARY" | "EVIDENCE";
  alpha?: number;
  minTrainTrades?: number;
}

export interface CandleGateResult {
  allowed: boolean;
  label: EvidenceLabel;
  reason: string;
  strategy: Strategy | null;
  oosTrades: number;
  meanR: number;
  pValue: number | null;
}

function closed(label: EvidenceLabel, reason: string, over: Partial<CandleGateResult> = {}): CandleGateResult {
  return { allowed: false, label, reason, strategy: null, oosTrades: 0, meanR: 0, pValue: null, ...over };
}

const sgn = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;

export function evaluateCandleGate(
  candles: readonly Candle[],
  strategies: readonly Strategy[],
  opts: CandleGateOptions,
): CandleGateResult {
  if (strategies.length === 0) throw new RangeError("Sem estratégias");
  const alpha = opts.alpha ?? GATE_ALPHA;
  const minLabel = opts.minLabel ?? "PRELIMINARY";
  const need = opts.trainSize + opts.testSize;
  if (candles.length < need) {
    return closed("INSUFFICIENT", `poucas velas (${candles.length} de ${need} necessárias)`);
  }
  const { trainSize, testSize, minLabel: _a, alpha: _b, minTrainTrades, ...bt } = opts;
  void _a;
  void _b;

  const wf = walkForwardCandles(candles, strategies, { ...bt, trainSize, testSize, ...(minTrainTrades !== undefined ? { minTrainTrades } : {}) });
  const oos = wf.oos;
  if (oos.trades < PRELIMINARY_MIN_OBS || oos.pValue === null) {
    return closed("INSUFFICIENT", `só ${oos.trades} operações fora da amostra (mínimo ${PRELIMINARY_MIN_OBS})`, { oosTrades: oos.trades });
  }
  const base = { oosTrades: oos.trades, meanR: oos.meanR, pValue: oos.pValue };
  if (oos.pValue >= alpha || oos.meanR <= 0) {
    return closed("NO_EVIDENCE", `sem evidência: média ${sgn(oos.meanR)}R por operação em ${oos.trades} operações (p = ${oos.pValue.toFixed(3)})`, base);
  }
  const label = classify(oos.trades, oos.pValue);
  const permitted = minLabel === "EVIDENCE" ? label === "EVIDENCE" : label === "EVIDENCE" || label === "PRELIMINARY";
  if (!permitted) return closed(label, `evidência ${label} insuficiente para este modo (pede ${minLabel})`, base);

  // Estratégia com melhor resultado no treino mais recente.
  const start = Math.max(0, candles.length - trainSize);
  let best: Strategy | null = null;
  let bestNet = -Infinity;
  for (const s of strategies) {
    const m = runCandleBacktest(candles, s, { ...bt, start, end: candles.length }).metrics;
    if (m.trades < (minTrainTrades ?? 20)) continue;
    if (m.netR > bestNet) {
      best = s;
      bestNet = m.netR;
    }
  }
  if (best === null) return closed(label, "nenhuma estratégia serviu no treino recente", base);
  return {
    allowed: true,
    label,
    reason: `evidência ${label}: média ${sgn(oos.meanR)}R em ${oos.trades} operações (p = ${oos.pValue.toFixed(4)}); estratégia ${best.name}`,
    strategy: best,
    ...base,
  };
}

export function formatCandleGate(g: CandleGateResult): string {
  return g.allowed ? `PORTA ABERTA - ${g.reason}` : `NO TRADE - ${g.reason}`;
}

export interface CandleGateControllerOptions {
  strategies: readonly Strategy[];
  gate: CandleGateOptions;
  revalidateEvery: number;
  maxBuffer?: number;
  initial?: readonly Candle[];
  /** Validações seguidas positivas para abrir (por defeito 2). Fechar é imediato. */
  confirmations?: number;
}

export class CandleGateController {
  #opts: CandleGateControllerOptions;
  #buffer: Candle[];
  #since = 0;
  #streak = 0;
  #open = false;
  #result: CandleGateResult;

  constructor(opts: CandleGateControllerOptions) {
    if (!Number.isInteger(opts.revalidateEvery) || opts.revalidateEvery < 1) {
      throw new RangeError(`revalidateEvery inválido: ${opts.revalidateEvery}`);
    }
    this.#opts = opts;
    this.#buffer = [...(opts.initial ?? [])];
    this.#trim();
    this.#result = closed("INSUFFICIENT", "a aguardar a primeira validação");
    this.#check();
  }

  get result(): CandleGateResult {
    return this.#result;
  }
  get isOpen(): boolean {
    return this.#open;
  }
  get candles(): number {
    return this.#buffer.length;
  }

  #trim(): void {
    const max = this.#opts.maxBuffer ?? 3000;
    if (this.#buffer.length > max) this.#buffer.splice(0, this.#buffer.length - max);
  }

  #check(): boolean {
    const before = this.#open;
    const res = evaluateCandleGate(this.#buffer, this.#opts.strategies, this.#opts.gate);
    this.#result = res;
    this.#streak = res.allowed ? this.#streak + 1 : 0;
    this.#open = res.allowed && this.#streak >= (this.#opts.confirmations ?? 2);
    this.#since = 0;
    return before !== this.#open;
  }

  /** Recebe uma vela fechada nova. Devolve true se a porta abriu ou fechou. */
  push(c: Candle): boolean {
    this.#buffer.push(c);
    this.#trim();
    this.#since += 1;
    return this.#since >= this.#opts.revalidateEvery ? this.#check() : false;
  }

  /** Estratégia para a sessão: só dá sinais quando a porta está aberta. */
  asStrategy(): Strategy {
    return {
      name: "porta-de-evidencia",
      signals: (candles) => {
        const zeros = (): Signal[] => new Array<Signal>(candles.length).fill(0);
        if (!this.#open || this.#result.strategy === null) return zeros();
        return this.#result.strategy.signals(candles);
      },
    };
  }
    }
