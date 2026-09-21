// NEVER LOSS - sessão de paper trading em VELAS (Forex, metais, cripto), compra e venda.
// Simula operações com velas reais, sem dinheiro e sem saldo inventado.
// Mesmas regras do backtest: o sinal usa a vela fechada, a entrada é na abertura da vela seguinte,
// stop e alvo pela vela, custos incluídos, stake fixa (= risco por operação) e limites obrigatórios.

import { atr } from "./indicators.ts";
import { summarizeR } from "./candle-backtest.ts";
import type { RMetrics, ExitReason } from "./candle-backtest.ts";
import { MIN_STAKE, MAX_SESSION_MS } from "./paper.ts";
import type { SessionStatus, StopReason } from "./paper.ts";
import type { Strategy } from "./strategies.ts";
import type { Candle } from "./market-data.ts";

export interface CandlePaperConfig {
  strategy: Strategy;
  /** Risco por operação (1R) na moeda da conta. Fixo, mínimo 0,50. */
  stake: number;
  slAtr: number;
  tpR: number;
  maxBars: number;
  /** Custo de ida e volta como fração do preço. */
  costFraction: number;
  atrPeriod?: number;
  directions?: "both" | "long" | "short";
  /** Velas guardadas para os indicadores (por defeito 1500). */
  maxBuffer?: number;
  maxLoss: number;
  maxTrades: number;
  maxDurationMs: number;
  maxConsecutiveLosses: number;
  /** Nº de velas sem novas entradas depois de uma perda (inclui a vela da perda). */
  cooldownCandles: number;
}

const ALLOWED_KEYS = new Set([
  "strategy", "stake", "slAtr", "tpR", "maxBars", "costFraction", "atrPeriod", "directions", "maxBuffer",
  "maxLoss", "maxTrades", "maxDurationMs", "maxConsecutiveLosses", "cooldownCandles",
]);

export type CandlePaperEvent =
  | { type: "started"; at: number }
  | { type: "paused"; at: number }
  | { type: "stopped"; at: number; reason: StopReason }
  | { type: "trade_opened"; at: number; direction: 1 | -1; entry: number; stopLoss: number; takeProfit: number; strategy: string }
  | {
      type: "trade_closed";
      at: number;
      direction: 1 | -1;
      entry: number;
      exit: number;
      reason: ExitReason;
      r: number;
      pnl: number;
      totalPnl: number;
    };

export interface CandlePaperSummary {
  status: SessionStatus;
  stopReason: StopReason | null;
  stake: number;
  opened: number;
  closed: number;
  hasOpenPosition: boolean;
  totalPnl: number;
  maxDrawdown: number;
  metrics: RMetrics;
}

function positive(v: number, label: string): void {
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${label} inválido: ${v}`);
}

function positiveInt(v: number, label: string): void {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${label} inválido: ${v}`);
}

function validate(cfg: CandlePaperConfig): void {
  for (const key of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.has(key)) throw new RangeError(`Opção não permitida: ${key}`);
  }
  if (!cfg.strategy || typeof cfg.strategy.signals !== "function") throw new RangeError("Estratégia em falta");
  if (!Number.isFinite(cfg.stake) || cfg.stake < MIN_STAKE) throw new RangeError(`Stake mínima é ${MIN_STAKE}`);
  positive(cfg.slAtr, "slAtr");
  positive(cfg.tpR, "tpR");
  positiveInt(cfg.maxBars, "maxBars");
  if (!Number.isFinite(cfg.costFraction) || cfg.costFraction < 0) throw new RangeError(`costFraction inválido: ${cfg.costFraction}`);
  positive(cfg.maxLoss, "maxLoss");
  if (cfg.maxLoss < cfg.stake) throw new RangeError("maxLoss tem de ser pelo menos uma stake");
  positiveInt(cfg.maxTrades, "maxTrades");
  positive(cfg.maxDurationMs, "maxDurationMs");
  if (cfg.maxDurationMs > MAX_SESSION_MS) throw new RangeError("Duração máxima é 3 horas");
  positiveInt(cfg.maxConsecutiveLosses, "maxConsecutiveLosses");
  if (!Number.isInteger(cfg.cooldownCandles) || cfg.cooldownCandles < 0) throw new RangeError(`cooldownCandles inválido: ${cfg.cooldownCandles}`);
  if (cfg.maxBuffer !== undefined) positiveInt(cfg.maxBuffer, "maxBuffer");
}

interface Pending {
  dir: 1 | -1;
  atr: number;
}

interface Position {
  dir: 1 | -1;
  entry: number;
  sl: number;
  tp: number;
  dist: number;
  cost: number;
  barsHeld: number;
}

export class CandlePaperSession {
  #cfg: Readonly<CandlePaperConfig>;
  #status: SessionStatus = "STOPPED";
  #stopReason: StopReason | null = null;
  #startedAt: number | null = null;
  #buffer: Candle[] = [];
  #pending: Pending | null = null;
  #position: Position | null = null;
  #rs: number[] = [];
  #opened = 0;
  #pnl = 0;
  #peak = 0;
  #maxDrawdown = 0;
  #consecutiveLosses = 0;
  #cooldown = 0;

  constructor(cfg: CandlePaperConfig) {
    validate(cfg);
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
  get hasOpenPosition(): boolean {
    return this.#position !== null;
  }

  /** PLAY: liga a análise. Não força nenhuma operação. */
  start(nowMs: number): CandlePaperEvent[] {
    if (this.#status === "RUNNING") return [];
    if (this.#status === "STOPPED" && this.#startedAt !== null) throw new Error("Sessão terminada: cria uma nova sessão");
    if (this.#startedAt === null) this.#startedAt = nowMs;
    this.#status = "RUNNING";
    return [{ type: "started", at: nowMs }];
  }

  /** PAUSE: bloqueia novas entradas. Uma operação aberta continua até sair. */
  pause(nowMs: number): CandlePaperEvent[] {
    if (this.#status !== "RUNNING") return [];
    this.#status = "PAUSED";
    return [{ type: "paused", at: nowMs }];
  }

  /** STOP: termina a sessão. Uma operação aberta continua até sair. */
  stop(nowMs: number): CandlePaperEvent[] {
    if (this.#status === "STOPPED") return [];
    return [this.#doStop(nowMs, "manual")];
  }

  #doStop(nowMs: number, reason: StopReason): CandlePaperEvent {
    this.#status = "STOPPED";
    this.#stopReason = reason;
    this.#pending = null;
    return { type: "stopped", at: nowMs, reason };
  }

  /** Recebe cada vela FECHADA, por ordem. Devolve os eventos que aconteceram. */
  onCandle(c: Candle): CandlePaperEvent[] {
    if (![c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) || c.high < c.low) {
      throw new RangeError("Vela inválida");
    }
    if (this.#startedAt === null) return [];
    const now = c.epoch * 1000;
    const events: CandlePaperEvent[] = [];
    const cfg = this.#cfg;

    this.#buffer.push(c);
    const maxBuffer = cfg.maxBuffer ?? 1500;
    if (this.#buffer.length > maxBuffer) this.#buffer.splice(0, this.#buffer.length - maxBuffer);

    // 1) Entrada pendente (sinal da vela anterior): abre na abertura desta vela.
    let entryCandle = false;
    if (this.#pending !== null) {
      const p = this.#pending;
      this.#pending = null;
      if (this.#status === "RUNNING" && this.#position === null) {
        const entry = c.open;
        const dist = cfg.slAtr * p.atr;
        this.#position = {
          dir: p.dir,
          entry,
          sl: entry - p.dir * dist,
          tp: entry + p.dir * cfg.tpR * dist,
          dist,
          cost: (entry * cfg.costFraction) / dist,
          barsHeld: 0,
        };
        this.#opened += 1;
        entryCandle = true;
        events.push({
          type: "trade_opened",
          at: now,
          direction: p.dir,
          entry,
          stopLoss: this.#position.sl,
          takeProfit: this.#position.tp,
          strategy: cfg.strategy.name,
        });
      }
    }

    // 2) Gestão da posição aberta (mesmas regras do backtest).
    if (this.#position !== null) {
      const pos = this.#position;
      if (!entryCandle) pos.barsHeld += 1;
      let exit: number | null = null;
      let reason: ExitReason = "time";
      if (!entryCandle) {
        if (pos.dir === 1 ? c.open <= pos.sl : c.open >= pos.sl) {
          exit = c.open;
          reason = "sl";
        } else if (pos.dir === 1 ? c.open >= pos.tp : c.open <= pos.tp) {
          exit = c.open;
          reason = "tp";
        }
      }
      if (exit === null) {
        const hitSl = pos.dir === 1 ? c.low <= pos.sl : c.high >= pos.sl;
        const hitTp = pos.dir === 1 ? c.high >= pos.tp : c.low <= pos.tp;
        if (hitSl) {
          exit = pos.sl;
          reason = "sl";
        } else if (hitTp) {
          exit = pos.tp;
          reason = "tp";
        } else if (pos.barsHeld >= cfg.maxBars) {
          exit = c.close;
          reason = "time";
        }
      }
      if (exit !== null) {
        const r = (pos.dir * (exit - pos.entry)) / pos.dist - pos.cost;
        const pnl = r * cfg.stake;
        this.#position = null;
        this.#rs.push(r);
        this.#pnl += pnl;
        if (r > 0) {
          this.#consecutiveLosses = 0;
        } else {
          this.#consecutiveLosses += 1;
          this.#cooldown = cfg.cooldownCandles;
        }
        if (this.#pnl > this.#peak) this.#peak = this.#pnl;
        if (this.#peak - this.#pnl > this.#maxDrawdown) this.#maxDrawdown = this.#peak - this.#pnl;
        events.push({ type: "trade_closed", at: now, direction: pos.dir, entry: pos.entry, exit, reason, r, pnl, totalPnl: this.#pnl });
        if (this.#status !== "STOPPED") {
          const why = this.#limitReached();
          if (why !== null) events.push(this.#doStop(now, why));
        }
      }
    }

    if (this.#status !== "RUNNING" || this.#position !== null) return events;

    // 3) Duração máxima.
    if (now - this.#startedAt >= cfg.maxDurationMs) {
      events.push(this.#doStop(now, "max_duration"));
      return events;
    }

    // 4) Cooldown depois de perdas.
    if (this.#cooldown > 0) {
      this.#cooldown -= 1;
      return events;
    }

    // 5) Decide com a vela fechada (NO TRADE é o normal). O sinal vale para a abertura da vela seguinte.
    if (this.#opened >= cfg.maxTrades) return events;
    const sigs = cfg.strategy.signals(this.#buffer);
    const last = this.#buffer.length - 1;
    const sig = sigs[last];
    const dirs = cfg.directions ?? "both";
    const allowed = sig === 1 ? dirs !== "short" : sig === -1 ? dirs !== "long" : false;
    if (!allowed) return events;
    const a = atr(this.#buffer, cfg.atrPeriod ?? 14)[last];
    if (a === null || a === undefined || !(a > 0)) return events;
    this.#pending = { dir: sig as 1 | -1, atr: a };
    return events;
  }

  #limitReached(): StopReason | null {
    const c = this.#cfg;
    if (this.#pnl <= -c.maxLoss) return "max_loss";
    if (this.#consecutiveLosses >= c.maxConsecutiveLosses) return "max_consecutive_losses";
    if (this.#rs.length >= c.maxTrades) return "max_trades";
    return null;
  }

  summary(): CandlePaperSummary {
    return {
      status: this.#status,
      stopReason: this.#stopReason,
      stake: this.#cfg.stake,
      opened: this.#opened,
      closed: this.#rs.length,
      hasOpenPosition: this.#position !== null,
      totalPnl: this.#pnl,
      maxDrawdown: this.#maxDrawdown,
      metrics: summarizeR(this.#rs),
    };
  }
}

// ---------- Texto legível ----------

const REASONS: Record<StopReason, string> = {
  manual: "parada manualmente",
  max_loss: "perda máxima atingida",
  max_trades: "número máximo de operações atingido",
  max_duration: "duração máxima atingida",
  max_consecutive_losses: "perdas seguidas máximas atingidas",
  max_drawdown: "queda máxima atingida",
};

const EXIT_TEXT: Record<ExitReason, string> = { sl: "stop", tp: "alvo", time: "tempo" };
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const price = (x: number): string => String(Number(x.toPrecision(8)));
const signed = (x: number, d = 2): string => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;

export function formatCandleEvent(e: CandlePaperEvent): string {
  switch (e.type) {
    case "started":
      return `${clock(e.at)}  PLAY  sessão iniciada`;
    case "paused":
      return `${clock(e.at)}  PAUSE  novas entradas bloqueadas`;
    case "stopped":
      return `${clock(e.at)}  STOP  ${REASONS[e.reason]}`;
    case "trade_opened":
      return `${clock(e.at)}  ABRE   ${e.direction === 1 ? "COMPRA" : "VENDA"} a ${price(e.entry)} | stop ${price(e.stopLoss)} | alvo ${price(e.takeProfit)}`;
    case "trade_closed":
      return `${clock(e.at)}  FECHA  ${e.direction === 1 ? "COMPRA" : "VENDA"} saída ${price(e.exit)} (${EXIT_TEXT[e.reason]}) -> ${signed(e.r)}R | ${signed(e.pnl)} | total ${signed(e.totalPnl)}`;
  }
}

export function formatCandleSummary(s: CandlePaperSummary): string {
  const m = s.metrics;
  const lines = [
    "=== RESUMO (paper trading em velas, dados reais, sem dinheiro) ===",
    `Estado: ${s.status}${s.stopReason ? ` (${REASONS[s.stopReason]})` : ""}`,
    `Operações: ${s.closed} fechadas de ${s.opened} abertas | risco fixo por operação ${s.stake}`,
  ];
  if (s.hasOpenPosition) lines.push("Há uma posição simulada ainda aberta (não contada no resultado).");
  if (s.closed === 0) {
    lines.push("Sem operações: o bot ficou em NO TRADE (a porta de evidência não abriu ou não houve sinal).");
  } else {
    lines.push(`Wins: ${m.wins} | Perdas: ${m.trades - m.wins} | taxa ${(m.winRate * 100).toFixed(1)}% | média ${signed(m.meanR, 3)}R por operação`);
    lines.push(`Resultado simulado: ${signed(s.totalPnl)} | pior queda: ${s.maxDrawdown.toFixed(2)} | maior sequência de perdas: ${m.longestLosingStreak}`);
  }
  lines.push("Aviso: poucas operações não provam nada. Resultado simulado não garante resultado futuro.");
  return lines.join("\n");
    }
