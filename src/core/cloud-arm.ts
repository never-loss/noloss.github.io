// NEVER LOSS — cloud timed PAPER|REAL arm jobs (Bybit linear USDT).
// Persist config + advance lazily from real closed klines (deterministic paper replay).
// SAME paper session logic for both modes; REAL mirroring is API-layer (pendingRealMirrors).
// Fixed stake. Evidence gate via CandleGateController. Max session 3h. No martingale.

import { MAX_SESSION_MS, MIN_STAKE } from "./paper.ts";
import { CandlePaperSession } from "./candle-paper.ts";
import type { CandlePaperEvent, CandlePaperSummary } from "./candle-paper.ts";
import { CandleGateController } from "./candle-gate.ts";
import type { CandleGateOptions, CandleGateResult } from "./candle-gate.ts";
import { strategiesForPreset, strategyPreset } from "./strategies.ts";
import type { StrategyPresetId } from "./strategies.ts";
import { feasible } from "./feasible.ts";
import { MARKETS, marketOf } from "./markets.ts";
import type { Candle } from "./market-data.ts";

/** Default mode when create omits mode. */
export const CLOUD_ARM_MODE = "PAPER" as const;
export type CloudArmMode = "PAPER" | "REAL";
export const CLOUD_ARM_WARMUP = 1500;
export const CLOUD_ARM_MAX_EVENTS = 80;
export const CLOUD_ARM_REVALIDATE_EVERY = 12;
export const CLOUD_ARM_MIN_MULTIPLIER = 100;
export const CLOUD_ARM_MAX_MIRROR_KEYS = 40;

export type CloudArmStatus = "RUNNING" | "STOPPED" | "CANCELLED";

export interface CloudArmCreateInput {
  symbol: string;
  strategyPreset: string;
  stake: number;
  leverage: number;
  granularity: number;
  durationMinutes: number;
  clientId: string;
  /** PAPER (default) | REAL. REAL orders placed by API layer via pendingRealMirrors. */
  mode?: CloudArmMode | string;
}

export interface CloudArmGateSnap {
  allowed: boolean;
  label: string;
  reason: string;
  strategyName: string | null;
  oosTrades: number;
  meanR: number;
}

export interface CloudArmEventSnap {
  type: string;
  at: number;
  text: string;
  direction?: number;
  r?: number;
  pnl?: number;
  entry?: number;
}

export interface CloudArmSummarySnap {
  status: string;
  stopReason: string | null;
  maxTrades: number;
  opened: number;
  closed: number;
  hasOpenPosition: boolean;
  totalPnl: number;
  maxDrawdown: number;
}

export interface CloudArmJob {
  id: string;
  clientId: string;
  symbol: string;
  strategyPreset: StrategyPresetId;
  stake: number;
  leverage: number;
  granularity: number;
  durationMs: number;
  mode: CloudArmMode;
  status: CloudArmStatus;
  stopReason: string | null;
  createdAt: number;
  startedAt: number;
  endsAt: number;
  updatedAt: number;
  lastTickAt: number | null;
  events: CloudArmEventSnap[];
  summary: CloudArmSummarySnap;
  gate: CloudArmGateSnap | null;
  /** REAL: last mirrored open qty string (Bybit qty). */
  realOpenQty: string | null;
  /** REAL: last mirrored open side. */
  realOpenSide: "BUY" | "SELL" | null;
  /** REAL: event keys already sent to Bybit (capped). */
  realAppliedEventKeys: string[];
  /** REAL: cancel while a mirrored position may still be open → API should reduceOnly flatten. */
  needsRealFlatten: boolean;
}

export interface CloudArmRealMirror {
  action: "open" | "close";
  side: "BUY" | "SELL";
  key: string;
  entry?: number;
  evidenceAllowed: boolean;
}

const PRESET_IDS = new Set(["lucro_rapido", "loss_zero", "blitz_zero", "tendencia_diaria", "biblioteca"]);

function positiveInt(v: number, label: string): void {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${label} inválido`);
}

function parseMode(raw: unknown): CloudArmMode {
  const m = String(raw == null || raw === "" ? CLOUD_ARM_MODE : raw).trim().toUpperCase();
  if (m === "PAPER" || m === "REAL") return m;
  throw new RangeError("mode inválido (PAPER|REAL)");
}

export function validateCloudArmCreate(input: CloudArmCreateInput): {
  symbol: string;
  strategyPreset: StrategyPresetId;
  stake: number;
  leverage: number;
  granularity: number;
  durationMs: number;
  clientId: string;
  mode: CloudArmMode;
} {
  const symbol = String(input.symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new RangeError("símbolo inválido (só Linear USDT)");
  const strategyPreset = String(input.strategyPreset || "").trim();
  if (!PRESET_IDS.has(strategyPreset)) throw new RangeError("estratégia inválida");
  const stake = Number(input.stake);
  if (!Number.isFinite(stake) || stake < MIN_STAKE) throw new RangeError(`stake mínima ${MIN_STAKE}`);
  const leverage = Number(input.leverage);
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 100) throw new RangeError("alavancagem inválida");
  const granularity = Number(input.granularity);
  if (![60, 300, 900, 3600].includes(granularity)) throw new RangeError("intervalo de vela inválido");
  const durationMinutes = Math.floor(Number(input.durationMinutes));
  positiveInt(durationMinutes, "duração");
  if (durationMinutes > 180) throw new RangeError("duração máxima é 180 minutos (3 h)");
  const durationMs = durationMinutes * 60 * 1000;
  if (durationMs > MAX_SESSION_MS) throw new RangeError("duração máxima é 3 horas");
  const clientId = String(input.clientId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(clientId)) throw new RangeError("clientId inválido");
  const mode = parseMode(input.mode);
  return {
    symbol,
    strategyPreset: strategyPreset as StrategyPresetId,
    stake,
    leverage,
    granularity,
    durationMs,
    clientId,
    mode,
  };
}

export function newCloudArmId(nowMs: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `arm_${nowMs.toString(36)}_${rand}`;
}

export function createCloudArmJob(input: CloudArmCreateInput, nowMs: number = Date.now()): CloudArmJob {
  const v = validateCloudArmCreate(input);
  return {
    id: newCloudArmId(nowMs),
    clientId: v.clientId,
    symbol: v.symbol,
    strategyPreset: v.strategyPreset,
    stake: v.stake,
    leverage: v.leverage,
    granularity: v.granularity,
    durationMs: v.durationMs,
    mode: v.mode,
    status: "RUNNING",
    stopReason: null,
    createdAt: nowMs,
    startedAt: nowMs,
    endsAt: nowMs + v.durationMs,
    updatedAt: nowMs,
    lastTickAt: null,
    events: [],
    summary: {
      status: "RUNNING",
      stopReason: null,
      maxTrades: v.strategyPreset === "blitz_zero" ? 10 : 50,
      opened: 0,
      closed: 0,
      hasOpenPosition: false,
      totalPnl: 0,
      maxDrawdown: 0,
    },
    gate: null,
    realOpenQty: null,
    realOpenSide: null,
    realAppliedEventKeys: [],
    needsRealFlatten: false,
  };
}

function costFractionFor(symbol: string): number {
  const kind = marketOf(symbol);
  return kind && MARKETS[kind] ? MARKETS[kind].assumedCostFraction : 0.001;
}

function gateOptsFor(
  presetId: StrategyPresetId,
  costFraction: number,
  trainSize: number,
  testSize: number,
): CandleGateOptions {
  const preset = strategyPreset(presetId);
  const g = (preset && preset.preferredGate) || {};
  return {
    slAtr: g.slAtr || 1.5,
    tpR: g.tpR || 2,
    maxBars: g.maxBars || 24,
    costFraction,
    trainSize,
    testSize,
    minLabel: g.minLabel || "PRELIMINARY",
  };
}

function strategiesFor(presetId: StrategyPresetId) {
  const raw = strategiesForPreset(presetId);
  const preset = strategyPreset(presetId);
  const slAtr = (preset && preset.preferredGate && preset.preferredGate.slAtr) || 1.5;
  return raw.map((s) => feasible(s, { slAtr, maxStopFraction: 1 / CLOUD_ARM_MIN_MULTIPLIER }));
}

function snapGate(res: CandleGateResult, open: boolean): CloudArmGateSnap {
  return {
    allowed: open && res.allowed,
    label: res.label,
    reason: res.reason,
    strategyName: res.strategy ? res.strategy.name : null,
    oosTrades: res.oosTrades,
    meanR: res.meanR,
  };
}

function snapSummary(s: CandlePaperSummary): CloudArmSummarySnap {
  return {
    status: s.status,
    stopReason: s.stopReason,
    maxTrades: s.maxTrades,
    opened: s.opened,
    closed: s.closed,
    hasOpenPosition: s.hasOpenPosition,
    totalPnl: s.totalPnl,
    maxDrawdown: s.maxDrawdown,
  };
}

function eventText(ev: CandlePaperEvent, mode: CloudArmMode): string {
  switch (ev.type) {
    case "started":
      return `PLAY sessão (nuvem ${mode})`;
    case "paused":
      return "PAUSE";
    case "stopped":
      return `STOP ${ev.reason}`;
    case "trade_opened":
      return `ABRE ${ev.direction === 1 ? "COMPRA" : "VENDA"} @ ${ev.entry}`;
    case "trade_closed":
      return `FECHA ${ev.reason} ${ev.r >= 0 ? "+" : ""}${ev.r.toFixed(2)}R pnl=${ev.pnl.toFixed(2)}`;
    default:
      return String((ev as { type: string }).type);
  }
}

function snapEvent(ev: CandlePaperEvent, mode: CloudArmMode): CloudArmEventSnap {
  const base: CloudArmEventSnap = { type: ev.type, at: ev.at, text: eventText(ev, mode) };
  if (ev.type === "trade_opened") {
    base.direction = ev.direction;
    base.entry = ev.entry;
  }
  if (ev.type === "trade_closed") {
    base.direction = ev.direction;
    base.r = ev.r;
    base.pnl = ev.pnl;
    base.entry = ev.entry;
  }
  return base;
}

/** Stable key for REAL mirror de-dupe across rebuild ticks. */
export function cloudArmEventKey(ev: Pick<CloudArmEventSnap, "type" | "at" | "direction" | "r">): string {
  const dir = ev.direction != null ? String(ev.direction) : "";
  const r = ev.r != null && Number.isFinite(ev.r) ? String(ev.r) : "";
  return `${ev.type}:${ev.at}:${dir}:${r}`;
}

/**
 * New trade_opened / trade_closed on jobAfter that are not yet in realAppliedEventKeys.
 * Pure — does not place orders. PAPER jobs return [].
 */
export function pendingRealMirrors(jobBefore: CloudArmJob, jobAfter: CloudArmJob): CloudArmRealMirror[] {
  if (jobAfter.mode !== "REAL") return [];
  const applied = new Set(jobAfter.realAppliedEventKeys || jobBefore.realAppliedEventKeys || []);
  const out: CloudArmRealMirror[] = [];
  for (const ev of jobAfter.events) {
    if (ev.type !== "trade_opened" && ev.type !== "trade_closed") continue;
    const key = cloudArmEventKey(ev);
    if (applied.has(key)) continue;
    if (ev.type === "trade_opened") {
      const side: "BUY" | "SELL" = ev.direction === 1 ? "BUY" : "SELL";
      out.push({
        action: "open",
        side,
        key,
        entry: ev.entry,
        // Paper session only opens when gate was open; trust historical open.
        evidenceAllowed: true,
      });
    } else {
      // Close opposite of the open direction on the event (paper direction = original open).
      const openSide: "BUY" | "SELL" = ev.direction === 1 ? "BUY" : "SELL";
      const closeSide: "BUY" | "SELL" = openSide === "BUY" ? "SELL" : "BUY";
      out.push({
        action: "close",
        side: closeSide,
        key,
        entry: ev.entry,
        evidenceAllowed: true,
      });
    }
  }
  return out;
}

/** Persist mirror attempt markers + optional open position state (capped keys). */
export function markRealMirrorsApplied(
  job: CloudArmJob,
  keys: readonly string[],
  position?: { qty: string | null; side: "BUY" | "SELL" | null },
): CloudArmJob {
  const prev = job.realAppliedEventKeys || [];
  const merged = [...prev];
  for (const k of keys) {
    if (!merged.includes(k)) merged.push(k);
  }
  const capped = merged.length > CLOUD_ARM_MAX_MIRROR_KEYS
    ? merged.slice(-CLOUD_ARM_MAX_MIRROR_KEYS)
    : merged;
  return {
    ...job,
    realAppliedEventKeys: capped,
    realOpenQty: position ? position.qty : job.realOpenQty,
    realOpenSide: position ? position.side : job.realOpenSide,
  };
}

/** Closed candles only: epoch + granularity <= nowSec. */
export function closedCandlesOnly(candles: readonly Candle[], granularity: number, nowMs: number): Candle[] {
  const nowSec = nowMs / 1000;
  return candles.filter((c) => c.epoch + granularity <= nowSec);
}

/**
 * Deterministic PAPER|REAL advance from real closed klines.
 * Warmup candles (before startedAt) seed the evidence gate; live candles drive the session.
 * Does NOT place Bybit orders — API uses pendingRealMirrors after save.
 */
export function advanceCloudArmJob(
  job: CloudArmJob,
  candlesAsc: readonly Candle[],
  nowMs: number = Date.now(),
): CloudArmJob {
  if (job.mode !== "PAPER" && job.mode !== "REAL") {
    throw new Error("cloud arm mode must be PAPER or REAL");
  }
  if (job.status === "CANCELLED") {
    return { ...job, updatedAt: nowMs, lastTickAt: nowMs };
  }

  const closed = closedCandlesOnly(candlesAsc, job.granularity, nowMs)
    .slice()
    .sort((a, b) => a.epoch - b.epoch);

  const warmup = closed.filter((c) => c.epoch * 1000 < job.startedAt);
  const live = closed.filter((c) => c.epoch * 1000 >= job.startedAt);

  const costFraction = costFractionFor(job.symbol);
  const n = Math.max(warmup.length, 100);
  const trainSize = Math.min(1000, Math.floor(n * 0.4));
  const testSize = Math.min(500, Math.floor(n * 0.2));
  const strategies = strategiesFor(job.strategyPreset);
  const gate = gateOptsFor(job.strategyPreset, costFraction, Math.max(50, trainSize), Math.max(30, testSize));

  const controller = new CandleGateController({
    strategies,
    gate,
    revalidateEvery: CLOUD_ARM_REVALIDATE_EVERY,
    maxBuffer: CLOUD_ARM_WARMUP,
    initial: warmup.slice(-CLOUD_ARM_WARMUP),
  });

  const maxTrades = job.strategyPreset === "blitz_zero" ? 10 : 50;
  const session = new CandlePaperSession({
    strategy: controller.asStrategy(),
    stake: job.stake,
    slAtr: gate.slAtr,
    tpR: gate.tpR,
    maxBars: gate.maxBars,
    costFraction,
    maxLoss: job.stake * 10,
    maxTrades,
    maxDurationMs: job.durationMs,
    maxConsecutiveLosses: 6,
    cooldownCandles: 0,
  });

  const events: CloudArmEventSnap[] = [];
  for (const ev of session.start(job.startedAt)) events.push(snapEvent(ev, job.mode));

  for (const c of live) {
    controller.push(c);
    for (const ev of session.onCandle(c)) events.push(snapEvent(ev, job.mode));
  }

  // Wall-clock timer: crypto may have candles, but still end when endsAt passes.
  let forcedMaxDuration = false;
  if (nowMs >= job.endsAt && session.status === "RUNNING") {
    forcedMaxDuration = true;
    for (const ev of session.stop(nowMs)) {
      const snap = snapEvent(ev, job.mode);
      if (ev.type === "stopped") {
        events.push({ ...snap, text: "STOP max_duration", type: "stopped" });
      } else {
        events.push(snap);
      }
    }
  }

  const summary = snapSummary(session.summary());
  let status: CloudArmStatus = job.status === "CANCELLED" ? "CANCELLED" : "RUNNING";
  let stopReason = job.stopReason;
  if (summary.status === "STOPPED") {
    status = "STOPPED";
    stopReason = forcedMaxDuration ? "max_duration" : summary.stopReason;
  } else if (nowMs >= job.endsAt && !summary.hasOpenPosition) {
    status = "STOPPED";
    stopReason = stopReason || "max_duration";
  }

  const capped = events.length > CLOUD_ARM_MAX_EVENTS ? events.slice(-CLOUD_ARM_MAX_EVENTS) : events;
  const summaryOut: CloudArmSummarySnap = {
    ...summary,
    status: status === "RUNNING" ? summary.status : "STOPPED",
    stopReason: status === "RUNNING" ? summary.stopReason : stopReason,
  };

  return {
    ...job,
    status,
    stopReason,
    updatedAt: nowMs,
    lastTickAt: nowMs,
    events: capped,
    summary: summaryOut,
    gate: snapGate(controller.result, controller.isOpen),
    // Preserve REAL mirror state across deterministic rebuilds
    realOpenQty: job.realOpenQty ?? null,
    realOpenSide: job.realOpenSide ?? null,
    realAppliedEventKeys: job.realAppliedEventKeys ? [...job.realAppliedEventKeys] : [],
    needsRealFlatten: job.needsRealFlatten === true,
  };
}

export function cancelCloudArmJob(job: CloudArmJob, nowMs: number = Date.now()): CloudArmJob {
  if (job.status !== "RUNNING") {
    return { ...job, updatedAt: nowMs };
  }
  const hadRealOpen =
    job.mode === "REAL" &&
    !!(job.realOpenQty && job.realOpenSide);
  return {
    ...job,
    status: "CANCELLED",
    stopReason: "manual",
    updatedAt: nowMs,
    lastTickAt: nowMs,
    needsRealFlatten: hadRealOpen || job.needsRealFlatten === true,
    summary: {
      ...job.summary,
      status: "STOPPED",
      stopReason: "manual",
    },
    events: [
      ...job.events,
      { type: "stopped", at: nowMs, text: "STOP manual (nuvem)" },
    ].slice(-CLOUD_ARM_MAX_EVENTS),
  };
}

export function publicCloudArmJob(job: CloudArmJob): Record<string, unknown> {
  return {
    id: job.id,
    symbol: job.symbol,
    strategyPreset: job.strategyPreset,
    stake: job.stake,
    leverage: job.leverage,
    granularity: job.granularity,
    durationMs: job.durationMs,
    mode: job.mode,
    status: job.status,
    stopReason: job.stopReason,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endsAt: job.endsAt,
    updatedAt: job.updatedAt,
    lastTickAt: job.lastTickAt,
    events: job.events,
    summary: job.summary,
    gate: job.gate,
    remainingMs: job.status === "RUNNING" ? Math.max(0, job.endsAt - Date.now()) : 0,
    needsRealFlatten: job.needsRealFlatten === true,
    realOpenSide: job.realOpenSide || null,
    hasRealOpen: !!(job.realOpenQty && job.realOpenSide),
  };
}
