// NEVER LOSS - controlador da porta ancorado no livro-razão (gate-ledger) para o arm na nuvem.
// Diferença para o CandleGateController: a evidência fora da amostra vem dos blocos já fechados do livro (histórico
// profundo, p.ex. 90 dias) em vez de um walk-forward sobre ~1500 velas; só a ESCOLHA da estratégia usa a cauda recente.
//
// Determinismo (o arm reconstrói a sessão a cada tick): a verdade "como seria a porta no instante t" depende só de
// (blocos do livro com fim <= t) + (velas <= t). Como os blocos são prefix-invariantes, usar um livro MAIS NOVO e
// filtrar fim <= t dá exactamente o mesmo veredicto que o livro desse instante. Logo reconstruir é estável.
//
// Sem esperar 12 velas: o streak inicial deriva de validações passadas (grelha de 12 velas para trás a partir do
// arranque), todas "as-of". Porta já aberta há >= 2 validações abre logo. Fecha de imediato à 1.ª reprovação.
// Nada aqui promete lucro.

import { evaluateLedgerGate } from "./gate-ledger.ts";
import type { GateLedger, LedgerGateResult } from "./gate-ledger.ts";
import type { CandleMinLabel } from "./candle-gate.ts";
import type { Strategy, Signal } from "./strategies.ts";
import type { Candle } from "./market-data.ts";

/** Nº máximo de blocos (os mais recentes) que contam para o veredicto — o livro guarda mais para não perder contexto. */
export const GATE_VERDICT_FOLDS = 100;

export interface LedgerGateControllerOptions {
  ledger: GateLedger;
  strategies: readonly Strategy[];
  minLabel: CandleMinLabel;
  alpha?: number;
  revalidateEvery: number;
  /** Validações positivas seguidas para abrir (por omissão 2, como o CandleGateController). */
  confirmations?: number;
  maxFolds?: number;
  /** Velas FECHADAS até ao arranque, ordem crescente. */
  initial: readonly Candle[];
}

/** Livro "como era" no instante `endSec` (fim da última vela fechada), limitado aos blocos mais recentes. */
export function ledgerAsOf(ledger: GateLedger, endSec: number, maxFolds: number = GATE_VERDICT_FOLDS): GateLedger {
  const folds = ledger.folds.filter((f) => f.end <= endSec);
  return { ...ledger, folds: folds.length > maxFolds ? folds.slice(folds.length - maxFolds) : folds };
}

export class LedgerGateController {
  #opts: LedgerGateControllerOptions;
  #buffer: Candle[];
  #since = 0;
  #streak = 0;
  #open = false;
  #result: LedgerGateResult;
  #need: number;
  #conf: number;

  constructor(opts: LedgerGateControllerOptions) {
    if (!Number.isInteger(opts.revalidateEvery) || opts.revalidateEvery < 1) {
      throw new RangeError(`revalidateEvery inválido: ${opts.revalidateEvery}`);
    }
    this.#opts = opts;
    const p = opts.ledger.params;
    this.#need = p.trainSize + p.warmup;
    this.#conf = opts.confirmations ?? 2;
    this.#buffer = [...opts.initial];
    this.#trim();
    this.#result = this.#verdictAt(this.#buffer.length);
    this.#seed();
  }

  get result(): LedgerGateResult {
    return this.#result;
  }
  get isOpen(): boolean {
    return this.#open;
  }
  get streak(): number {
    return this.#streak;
  }
  get candles(): number {
    return this.#buffer.length;
  }

  #trim(): void {
    // Cauda necessária + folga para o seed (grelha de validações passadas) e a sessão.
    const max = this.#need + this.#opts.revalidateEvery * (this.#conf + 1) + 400;
    if (this.#buffer.length > max) this.#buffer.splice(0, this.#buffer.length - max);
  }

  /** Veredicto "como era" com as primeiras `endIdx` velas do buffer. */
  #verdictAt(endIdx: number): LedgerGateResult {
    const slice = this.#buffer.slice(0, endIdx);
    const gran = this.#opts.ledger.params.gran;
    const last = slice[slice.length - 1];
    const asOf = ledgerAsOf(this.#opts.ledger, last ? last.epoch + gran : 0, this.#opts.maxFolds ?? GATE_VERDICT_FOLDS);
    return evaluateLedgerGate(asOf, slice, this.#opts.strategies, { minLabel: this.#opts.minLabel, alpha: this.#opts.alpha });
  }

  /** Streak inicial a partir de validações passadas (agora, -12 velas, -24, ...). */
  #seed(): void {
    const step = this.#opts.revalidateEvery;
    let streak = 0;
    for (let k = 0; k < this.#conf; k++) {
      const idx = this.#buffer.length - k * step;
      if (idx < 1) break;
      const r = k === 0 ? this.#result : this.#verdictAt(idx);
      if (!r.allowed) break;
      streak += 1;
    }
    this.#streak = this.#result.allowed ? streak : 0;
    this.#open = this.#result.allowed && this.#streak >= this.#conf;
    this.#since = 0;
  }

  #check(): boolean {
    const before = this.#open;
    const res = this.#verdictAt(this.#buffer.length);
    this.#result = res;
    this.#streak = res.allowed ? this.#streak + 1 : 0;
    this.#open = res.allowed && this.#streak >= this.#conf;
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
      name: "porta-de-evidencia-livro",
      signals: (candles) => {
        const zeros = (): Signal[] => new Array<Signal>(candles.length).fill(0);
        if (!this.#open || this.#result.strategy === null) return zeros();
        return this.#result.strategy.signals(candles);
      },
    };
  }
}
