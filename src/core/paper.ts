// NEVER LOSS - sessão de paper trading (Fase 4).
// Simula operações com ticks reais. Sem dinheiro, sem saldo inventado.
// Regras: stake fixa, sem martingale, limites de sessão obrigatórios (máx. 3 horas),
// e o bot só entra se a regra disser que sim (NO TRADE é o normal).

import { TickWindow, MAX_WINDOW } from "./digits.ts";
import { didWin } from "./stats.ts";
import type { DigitContract } from "./stats.ts";
import { summarize } from "./backtest.ts";
import type { Rule, Metrics } from "./backtest.ts";

export const MIN_STAKE = 0.5;
export const MAX_SESSION_MS = 3 * 60 * 60 * 1000;

export type SessionStatus = "STOPPED" | "RUNNING" | "PAUSED";
export type StopReason =
  | "manual"
  | "max_loss"
  | "max_trades"
  | "max_duration"
  | "max_consecutive_losses"
  | "max_drawdown";

export interface PaperConfig {
  rule: Rule;
  /** Stake fixa (mínimo 0,50). Nunca muda durante a sessão. */
  stake: number;
  /** Perda máxima da sessão, na moeda da stake. Tem de ser >= stake. */
  maxLoss: number;
  maxTrades: number;
  /** Duração máxima em ms (no máximo 3 horas). */
  maxDurationMs: number;
  maxConsecutiveLosses: number;
  /** Nº de ticks sem novas entradas depois de uma perda (inclui o tick da perda). */
  cooldownTicks: number;
  /** Queda máxima face ao pico da sessão (opcional). */
  maxDrawdown?: number;
}

const ALLOWED_KEYS = new Set([
  "rule",
  "stake",
  "maxLoss",
  "maxTrades",
  "maxDurationMs",
  "maxConsecutiveLosses",
  "cooldownTicks",
  "maxDrawdown",
]);

export type PaperEvent =
  | { type: "started"; at: number }
  | { type: "paused"; at: number }
  | { type: "stopped"; at: number; reason: StopReason }
  | { type: "trade_opened"; at: number; contract: DigitContract; stake: number; rule: string }
  | {
      type: "trade_closed";
      at: number;
      contract: DigitContract;
      digit: number;
      won: boolean;
      pnl: number;
      totalPnl: number;
    };

export interface PaperSummary {
  status: SessionStatus;
  stopReason: StopReason | null;
  stake: number;
  opened: number;
  closed: number;
  totalPnl: number;
  /** Maior queda do resultado da sessão face ao pico, na moeda da stake. */
  maxDrawdown: number;
  metrics: Metrics;
}

function assertPositive(v: number, label: string): void {
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${label} inválido: ${v}`);
}

function assertPositiveInt(v: number, label: string): void {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${label} inválido: ${v}`);
}

function validateConfig(cfg: PaperConfig): void {
  // Lista fechada: qualquer opção desconhecida (martingale, multiplicador, recuperação...) é rejeitada.
  for (const key of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.has(key)) throw new RangeError(`Opção não permitida: ${key}`);
  }
  if (!cfg.rule || typeof cfg.rule.decide !== "function") throw new RangeError("Regra em falta");
  if (!Number.isFinite(cfg.rule.returnRate) || cfg.rule.returnRate <= 0) {
    throw new RangeError(`returnRate da regra inválido: ${cfg.rule.returnRate}`);
  }
  if (!Number.isFinite(cfg.stake) || cfg.stake < MIN_STAKE) {
    throw new RangeError(`Stake mínima é ${MIN_STAKE}`);
  }
  assertPositive(cfg.maxLoss, "maxLoss");
  if (cfg.maxLoss < cfg.stake) throw new RangeError("maxLoss tem de ser pelo menos uma stake");
  assertPositiveInt(cfg.maxTrades, "maxTrades");
  assertPositive(cfg.maxDurationMs, "maxDurationMs");
  if (cfg.maxDurationMs > MAX_SESSION_MS) throw new RangeError("Duração máxima é 3 horas");
  assertPositiveInt(cfg.maxConsecutiveLosses, "maxConsecutiveLosses");
  if (!Number.isInteger(cfg.cooldownTicks) || cfg.cooldownTicks < 0) {
    throw new RangeError(`cooldownTicks inválido: ${cfg.cooldownTicks}`);
  }
  if (cfg.maxDrawdown !== undefined) assertPositive(cfg.maxDrawdown, "maxDrawdown");
}

export class PaperSession {
  #cfg: Readonly<PaperConfig>;
  #status: SessionStatus = "STOPPED";
  #stopReason: StopReason | null = null;
  #startedAt: number | null = null;
  #window = new TickWindow(MAX_WINDOW);
  #pending: DigitContract | null = null;
  #outcomes: boolean[] = [];
  #opened = 0;
  #pnl = 0;
  #peak = 0;
  #maxDrawdown = 0;
  #consecutiveLosses = 0;
  #cooldown = 0;

  constructor(cfg: PaperConfig) {
    validateConfig(cfg);
    this.#cfg = Object.freeze({ ...cfg });
  }

  get status(): SessionStatus {
    return this.#status;
  }
  get stopReason(): StopReason | null {
    return this.#stopReason;
  }
  get totalPnl(): number {
    return this.#pnl;
  }
  get hasPending(): boolean {
    return this.#pending !== null;
  }

  /** PLAY: liga a análise. Não força nenhuma operação. */
  start(now: number): PaperEvent[] {
    if (this.#status === "RUNNING") return [];
    if (this.#status === "STOPPED" && this.#startedAt !== null) {
      throw new Error("Sessão terminada: cria uma nova sessão");
    }
    if (this.#startedAt === null) this.#startedAt = now;
    this.#status = "RUNNING";
    return [{ type: "started", at: now }];
  }

  /** PAUSE: bloqueia novas operações. Uma operação já aberta fecha no tick seguinte. */
  pause(now: number): PaperEvent[] {
    if (this.#status !== "RUNNING") return [];
    this.#status = "PAUSED";
    return [{ type: "paused", at: now }];
  }

  /** STOP: termina a sessão. Uma operação já aberta ainda fecha no tick seguinte. */
  stop(now: number): PaperEvent[] {
    if (this.#status === "STOPPED") return [];
    return [this.#doStop(now, "manual")];
  }

  #doStop(now: number, reason: StopReason): PaperEvent {
    this.#status = "STOPPED";
    this.#stopReason = reason;
    return { type: "stopped", at: now, reason };
  }

  /** Recebe o último dígito de cada tick. Devolve os eventos que aconteceram. */
  onTick(digit: number, now: number): PaperEvent[] {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
      throw new RangeError(`Dígito inválido: ${digit}`);
    }
    if (this.#startedAt === null) return []; // ainda em STOPPED: ignora tudo
    const events: PaperEvent[] = [];
    const wasActive = this.#status !== "STOPPED";
    if (wasActive) this.#window.push(digit);

    // 1) Fecha a operação aberta no tick anterior.
    if (this.#pending !== null) {
      const contract = this.#pending;
      this.#pending = null;
      const won = didWin(digit, contract);
      const pnl = won ? this.#cfg.stake * this.#cfg.rule.returnRate : -this.#cfg.stake;
      this.#pnl += pnl;
      this.#outcomes.push(won);
      if (won) {
        this.#consecutiveLosses = 0;
      } else {
        this.#consecutiveLosses += 1;
        this.#cooldown = this.#cfg.cooldownTicks;
      }
      if (this.#pnl > this.#peak) this.#peak = this.#pnl;
      if (this.#peak - this.#pnl > this.#maxDrawdown) this.#maxDrawdown = this.#peak - this.#pnl;
      events.push({ type: "trade_closed", at: now, contract, digit, won, pnl, totalPnl: this.#pnl });

      if (this.#status !== "STOPPED") {
        const reason = this.#limitReached();
        if (reason !== null) events.push(this.#doStop(now, reason));
      }
    }

    if (this.#status !== "RUNNING") return events;

    // 2) Duração máxima.
    if (now - this.#startedAt >= this.#cfg.maxDurationMs) {
      events.push(this.#doStop(now, "max_duration"));
      return events;
    }

    // 3) Cooldown depois de perdas.
    if (this.#cooldown > 0) {
      this.#cooldown -= 1;
      return events;
    }

    // 4) Decide (NO TRADE é o normal). Só vê dígitos até ao tick atual.
    if (this.#opened >= this.#cfg.maxTrades) return events;
    const contract = this.#cfg.rule.decide(this.#window.last(this.#window.size));
    if (contract !== null) {
      this.#pending = contract;
      this.#opened += 1;
      events.push({
        type: "trade_opened",
        at: now,
        contract,
        stake: this.#cfg.stake,
        rule: this.#cfg.rule.name,
      });
    }
    return events;
  }

  #limitReached(): StopReason | null {
    const c = this.#cfg;
    if (this.#pnl <= -c.maxLoss) return "max_loss";
    if (this.#consecutiveLosses >= c.maxConsecutiveLosses) return "max_consecutive_losses";
    if (c.maxDrawdown !== undefined && this.#maxDrawdown >= c.maxDrawdown) return "max_drawdown";
    if (this.#outcomes.length >= c.maxTrades) return "max_trades";
    return null;
  }

  summary(): PaperSummary {
    return {
      status: this.#status,
      stopReason: this.#stopReason,
      stake: this.#cfg.stake,
      opened: this.#opened,
      closed: this.#outcomes.length,
      totalPnl: this.#pnl,
      maxDrawdown: this.#maxDrawdown,
      metrics: summarize(this.#outcomes, this.#cfg.rule.returnRate),
    };
  }
}
