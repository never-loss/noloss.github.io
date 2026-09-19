// NEVER LOSS - porta de evidência (Fase 4b).
// O bot só pode abrir operações se a regra passar num teste fora da amostra, com dados recentes.
// Caso contrário: NO TRADE, e diz porquê. A porta é revalidada de tempos a tempos.

import { walkForward, runBacktest, makeRule } from "./backtest.ts";
import type { Rule } from "./backtest.ts";
import { classify, breakEvenProbability, PRELIMINARY_MIN_OBS } from "./stats.ts";
import type { EvidenceLabel } from "./stats.ts";

/** Rigor da porta: mais exigente que o ALPHA de pesquisa, porque o teste repete-se ao longo do tempo. */
export const GATE_ALPHA = 0.01;
export const MIN_GATE_TICKS = 600;

export interface GateOptions {
  trainSize?: number;
  testSize?: number;
  /** PRELIMINARY (>= 100 operações fora da amostra) ou EVIDENCE (>= 1000). Conta real: EVIDENCE. */
  minLabel?: "PRELIMINARY" | "EVIDENCE";
  alpha?: number;
}

export interface GateResult {
  allowed: boolean;
  label: EvidenceLabel;
  reason: string;
  /** Regra escolhida com os dados recentes (só existe se a porta estiver aberta). */
  rule: Rule | null;
  oosTrades: number;
  oosWinRate: number;
  breakEven: number;
  pValue: number | null;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function closed(label: EvidenceLabel, reason: string, over: Partial<GateResult> = {}): GateResult {
  return { allowed: false, label, reason, rule: null, oosTrades: 0, oosWinRate: 0, breakEven: 0, pValue: null, ...over };
}

/** Melhor regra no treino mais recente (maior lucro líquido, com um mínimo de operações). */
export function chooseRule(
  digits: readonly number[],
  candidates: readonly Rule[],
  trainSize: number,
  minTrades = 30,
): Rule | null {
  const start = Math.max(0, digits.length - trainSize);
  let best: Rule | null = null;
  let bestNet = -Infinity;
  for (const rule of candidates) {
    const m = runBacktest(digits, rule, { start, end: digits.length }).metrics;
    if (m.trades < minTrades) continue;
    if (m.netUnits > bestNet) {
      best = rule;
      bestNet = m.netUnits;
    }
  }
  return best;
}

export function evaluateGate(
  digits: readonly number[],
  candidates: readonly Rule[],
  opts: GateOptions = {},
): GateResult {
  if (candidates.length === 0) throw new RangeError("Sem regras candidatas");
  const alpha = opts.alpha ?? GATE_ALPHA;
  const minLabel = opts.minLabel ?? "PRELIMINARY";
  const n = digits.length;
  if (n < MIN_GATE_TICKS) {
    return closed("INSUFFICIENT", `poucos ticks (${n} de ${MIN_GATE_TICKS} necessários)`);
  }
  const trainSize = opts.trainSize ?? Math.min(1000, Math.floor(n * 0.5));
  const testSize = opts.testSize ?? Math.min(500, Math.floor(n * 0.25));

  const oos = walkForward(digits, candidates, { trainSize, testSize }).oos;
  const breakEven = breakEvenProbability(candidates[0]!.returnRate);
  if (oos.trades < PRELIMINARY_MIN_OBS || oos.evaluation === null) {
    return closed("INSUFFICIENT", `só ${oos.trades} operações fora da amostra (mínimo ${PRELIMINARY_MIN_OBS})`, {
      oosTrades: oos.trades,
      breakEven,
    });
  }

  const p = oos.evaluation.pValue;
  const base = { oosTrades: oos.trades, oosWinRate: oos.winRate, breakEven, pValue: p };
  if (p >= alpha || oos.winRate <= breakEven) {
    return closed(
      "NO_EVIDENCE",
      `sem evidência: taxa ${pct(oos.winRate)} contra break-even ${pct(breakEven)} (p = ${p.toFixed(3)})`,
      base,
    );
  }

  const label = classify(oos.trades, p);
  const permitted = minLabel === "EVIDENCE" ? label === "EVIDENCE" : label === "EVIDENCE" || label === "PRELIMINARY";
  if (!permitted) {
    return closed(label, `evidência ${label} insuficiente para este modo (pede ${minLabel})`, base);
  }

  const rule = chooseRule(digits, candidates, trainSize);
  if (rule === null) return closed(label, "nenhuma regra serviu no treino recente", base);
  return { allowed: true, label, reason: `evidência ${label}: taxa ${pct(oos.winRate)} contra break-even ${pct(breakEven)} (p = ${p.toFixed(4)}); regra ${rule.name}`, rule, ...base };
}

export function formatGate(g: GateResult): string {
  return g.allowed ? `PORTA ABERTA - ${g.reason}` : `NO TRADE - ${g.reason}`;
}

// ---------- Controlador: revalida a porta ao longo do tempo ----------

export interface GateControllerOptions {
  candidates: readonly Rule[];
  /** Revalida de N em N ticks. */
  revalidateEvery: number;
  /** Ticks guardados (os mais recentes). */
  maxBuffer?: number;
  gate?: GateOptions;
  /** Histórico inicial (ticks passados). */
  initial?: readonly number[];
  /** Nº de validações seguidas positivas para abrir a porta (por defeito 2). Fechar é imediato. */
  confirmations?: number;
}

export class GateController {
  #opts: GateControllerOptions;
  #buffer: number[];
  #sinceCheck = 0;
  #streak = 0;
  #result: GateResult;
  #open = false;

  constructor(opts: GateControllerOptions) {
    if (!Number.isInteger(opts.revalidateEvery) || opts.revalidateEvery < 1) {
      throw new RangeError(`revalidateEvery inválido: ${opts.revalidateEvery}`);
    }
    this.#opts = opts;
    this.#buffer = [...(opts.initial ?? [])];
    this.#trim();
    this.#result = closed("INSUFFICIENT", "a aguardar a primeira validação");
    this.#check();
  }

  get result(): GateResult {
    return this.#result;
  }
  get isOpen(): boolean {
    return this.#open;
  }
  get ticks(): number {
    return this.#buffer.length;
  }

  #trim(): void {
    const max = this.#opts.maxBuffer ?? 3000;
    if (this.#buffer.length > max) this.#buffer.splice(0, this.#buffer.length - max);
  }

  #check(): boolean {
    const before = this.#open;
    const res = evaluateGate(this.#buffer, this.#opts.candidates, this.#opts.gate);
    this.#result = res;
    this.#streak = res.allowed ? this.#streak + 1 : 0;
    this.#open = res.allowed && this.#streak >= (this.#opts.confirmations ?? 2);
    this.#sinceCheck = 0;
    return before !== this.#open;
  }

  /** Recebe um dígito novo. Devolve true se a porta abriu ou fechou. */
  push(digit: number): boolean {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) throw new RangeError(`Dígito inválido: ${digit}`);
    this.#buffer.push(digit);
    this.#trim();
    this.#sinceCheck += 1;
    if (this.#sinceCheck >= this.#opts.revalidateEvery) return this.#check();
    return false;
  }

  /** Regra para a sessão: só decide quando a porta está aberta. */
  asRule(): Rule {
    const returnRate = this.#opts.candidates[0]!.returnRate;
    return makeRule("porta-de-evidencia", returnRate, (history) => {
      if (!this.#open || this.#result.rule === null) return null;
      return this.#result.rule.decide(history);
    });
  }
    }
