// NEVER LOSS — live proximity to strategy entry (same indicators as strategies.ts).
// Informativo: NÃO substitui a porta de evidência. 100% = sinal no último bar OU
// indicadores no limiar de cruzamento/threshold. Radar usa isto (leve); PLAY usa a porta.

import { ema, rsi, macd, bollinger, stochastic, adx, atr } from "./indicators.ts";
import type { Series } from "./indicators.ts";
import type { Candle } from "./market-data.ts";
import type { Signal, Strategy } from "./strategies.ts";

export interface LiveEntryMetrics {
  /** 0–100: proximidade ao alvo de entrada (indicadores reais). */
  proximityPct: number;
  lastSignal: Signal;
  /** Barras desde o último sinal ≠ 0 (Infinity se nunca). */
  barsSinceSignal: number;
  agreeingLong: number;
  agreeingShort: number;
  total: number;
  bias: "long" | "short" | "neutral";
  /** true se alguma estratégia sinalizou na última vela. */
  atTarget: boolean;
  detail: string;
}

function lastDefined(s: Series, i: number): number | null {
  const v = s[i];
  return v == null ? null : v;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function pct(x: number): number {
  return Math.round(clamp01(x) * 100);
}

/** Proximidade 0..1: quanto mais perto de 0 a distância normalizada, mais alto. */
function nearZero(dist: number, scale: number): number {
  if (!(scale > 0) || !Number.isFinite(dist)) return 0;
  return clamp01(1 - Math.abs(dist) / scale);
}

function closes(candles: readonly Candle[]): number[] {
  return candles.map((c) => c.close);
}

/** Proximidade EMA cross: gap fast−slow relativo ao ATR. */
function proxEmaCross(candles: readonly Candle[], fast: number, slow: number): number {
  const i = candles.length - 1;
  if (i < slow + 2) return 0;
  const c = closes(candles);
  const f = ema(c, fast);
  const s = ema(c, slow);
  const a = atr(candles, 14);
  const fv = lastDefined(f, i);
  const sv = lastDefined(s, i);
  const av = lastDefined(a, i);
  if (fv == null || sv == null || av == null || av <= 0) return 0;
  return nearZero(fv - sv, av * 0.35);
}

function proxRsi(candles: readonly Candle[], period: number, low: number, high: number): number {
  const i = candles.length - 1;
  const r = rsi(closes(candles), period);
  const v = lastDefined(r, i);
  if (v == null) return 0;
  const dLow = Math.abs(v - low);
  const dHigh = Math.abs(v - high);
  const d = Math.min(dLow, dHigh);
  return clamp01(1 - d / 25);
}

function proxMacd(candles: readonly Candle[], fast: number, slow: number, signal: number): number {
  const i = candles.length - 1;
  if (i < slow + signal) return 0;
  const m = macd(closes(candles), fast, slow, signal);
  const mv = lastDefined(m.macd, i);
  const sv = lastDefined(m.signal, i);
  const a = atr(candles, 14);
  const av = lastDefined(a, i);
  const px = candles[i]!.close;
  if (mv == null || sv == null || av == null || av <= 0 || !(px > 0)) return 0;
  const scale = (av / px) * px * 0.002 + Math.abs(mv) * 0.15 + 1e-12;
  return nearZero(mv - sv, Math.max(scale, av * 0.0005 * px));
}

function proxBollinger(candles: readonly Candle[], period: number, k: number, mode: "reversion" | "breakout"): number {
  const i = candles.length - 1;
  if (i < period) return 0;
  const c = closes(candles);
  const b = bollinger(c, period, k);
  const lo = lastDefined(b.lower, i);
  const up = lastDefined(b.upper, i);
  const mid = lastDefined(b.mid, i);
  if (lo == null || up == null || mid == null) return 0;
  const px = c[i]!;
  const half = (up - lo) / 2 || 1e-12;
  if (mode === "reversion") {
    const d = Math.min(Math.abs(px - lo), Math.abs(px - up));
    return clamp01(1 - d / half);
  }
  // breakout: perto de romper (acima mid, perto de upper ou abaixo mid perto de lower)
  if (px >= mid) return clamp01(1 - Math.abs(up - px) / half);
  return clamp01(1 - Math.abs(px - lo) / half);
}

function proxStoch(candles: readonly Candle[], kPeriod: number, dPeriod: number, low: number, high: number): number {
  const i = candles.length - 1;
  const s = stochastic(candles, kPeriod, dPeriod);
  const kv = lastDefined(s.k, i);
  const dv = lastDefined(s.d, i);
  if (kv == null || dv == null) return 0;
  const zone = Math.min(Math.abs(kv - low), Math.abs(kv - high));
  const zoneScore = clamp01(1 - zone / 25);
  const crossScore = nearZero(kv - dv, 8);
  return clamp01(0.55 * zoneScore + 0.45 * crossScore);
}

function proxAdx(candles: readonly Candle[], period: number, minAdx: number): number {
  const i = candles.length - 1;
  const a = adx(candles, period);
  const adxV = lastDefined(a.adx, i);
  const p = lastDefined(a.plusDI, i);
  const m = lastDefined(a.minusDI, i);
  if (adxV == null || p == null || m == null) return 0;
  const adxScore = clamp01(adxV / Math.max(minAdx, 1));
  const diScore = nearZero(p - m, 8);
  return clamp01(0.5 * Math.min(1, adxScore) + 0.5 * diScore);
}

function proxAtrBreakout(
  candles: readonly Candle[],
  lookback: number,
  atrPeriod: number,
  atrMult: number,
  minAdx?: number,
): number {
  const i = candles.length - 1;
  if (i < lookback) return 0;
  const a = atr(candles, atrPeriod);
  const atrV = lastDefined(a, i);
  if (atrV == null || atrV <= 0) return 0;
  if (minAdx != null) {
    const t = adx(candles, 14);
    const adxV = lastDefined(t.adx, i);
    if (adxV == null || adxV < minAdx * 0.7) return clamp01((adxV ?? 0) / minAdx) * 0.4;
  }
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = i - lookback; j < i; j++) {
    const c = candles[j]!;
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  const close = candles[i]!.close;
  const pad = atrMult * atrV;
  const upDist = hi + pad - close;
  const dnDist = close - (lo - pad);
  const best = Math.min(Math.max(upDist, 0), Math.max(dnDist, 0));
  return nearZero(best, pad + atrV * 0.5);
}

/** Cap history for live UI — enough for EMA50 / ATR48, cheap per tick. */
export const LIVE_ENTRY_MAX_CANDLES = 160;

function windowCandles(candles: readonly Candle[], max = LIVE_ENTRY_MAX_CANDLES): readonly Candle[] {
  if (candles.length <= max) return candles;
  return candles.slice(-max);
}

/**
 * Proximidade 0..1 para uma estratégia nomeada (mesmos parâmetros que strategies.ts).
 * Fallback: 0 se o nome não for reconhecido.
 */
export function proximityForStrategyName(name: string, candles: readonly Candle[]): number {
  if (candles.length < 30) return 0;
  // Caller usually already windowed; re-window is cheap (slice only if over cap).
  candles = windowCandles(candles);
  let m: RegExpMatchArray | null;

  m = /^ema-cruza (\d+)\/(\d+)$/.exec(name);
  if (m) return proxEmaCross(candles, Number(m[1]), Number(m[2]));

  m = /^rsi-reversao (\d+) ([\d.]+)\/([\d.]+)$/.exec(name);
  if (m) return proxRsi(candles, Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^macd-cruza (\d+)\/(\d+)\/(\d+)$/.exec(name);
  if (m) return proxMacd(candles, Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^bollinger-reversao (\d+) k([\d.]+)$/.exec(name);
  if (m) return proxBollinger(candles, Number(m[1]), Number(m[2]), "reversion");

  m = /^bollinger-rompe (\d+) k([\d.]+)$/.exec(name);
  if (m) return proxBollinger(candles, Number(m[1]), Number(m[2]), "breakout");

  m = /^estocastico (\d+)\/(\d+) ([\d.]+)\/([\d.]+)$/.exec(name);
  if (m) return proxStoch(candles, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));

  m = /^adx-tendencia (\d+) min([\d.]+)$/.exec(name);
  if (m) return proxAdx(candles, Number(m[1]), Number(m[2]));

  m = /^tendência-diária breakout-ATR (\d+)×([\d.]+)(?: adx([\d.]+))?$/.exec(name);
  if (m) {
    const minAdx = m[3] != null ? Number(m[3]) : undefined;
    return proxAtrBreakout(candles, Number(m[1]), 14, Number(m[2]), minAdx);
  }

  if (name.startsWith("confluencia(")) {
    // Confluence: average proximity isn't available from name alone — caller should
    // pass child strategies. Treat as signal-only fallback.
    return 0;
  }
  return 0;
}

function signalStats(strategies: readonly Strategy[], candles: readonly Candle[], hold: number) {
  const win = windowCandles(candles);
  const n = win.length;
  let lastSignal: Signal = 0;
  let barsSince = Infinity;
  let agreeingLong = 0;
  let agreeingShort = 0;
  let maxProx = 0;
  const details: string[] = [];
  // Scan only recent bars for "since signal" — avoid full-history walks.
  const sinceScan = Math.min(24, n);

  for (const s of strategies) {
    // strategies.signals is O(n); keep n bounded via windowCandles.
    const sigs = s.signals(win);
    const last = (sigs[n - 1] ?? 0) as Signal;
    if (last !== 0) {
      lastSignal = last;
      barsSince = 0;
    } else if (barsSince > 0) {
      for (let j = n - 1; j >= 0 && j >= n - sinceScan; j--) {
        if (sigs[j] !== 0) {
          barsSince = Math.min(barsSince, n - 1 - j);
          break;
        }
      }
    }

    let recent: Signal = 0;
    for (let j = n - 1; j >= 0 && j >= n - hold; j--) {
      if (sigs[j] !== 0) {
        recent = sigs[j] as Signal;
        break;
      }
    }
    if (recent === 1) agreeingLong += 1;
    else if (recent === -1) agreeingShort += 1;

    let p = 0;
    if (last !== 0) p = 1;
    else if (s.name.startsWith("confluencia(")) {
      // approximate: fraction of hold-window agreement toward one side
      p = Math.max(agreeingLong, agreeingShort) / Math.max(1, strategies.length);
    } else {
      // Cheap tip-only proximity on the same window (no second full-history pass).
      p = proximityForStrategyName(s.name, win);
    }
    if (p > maxProx) {
      maxProx = p;
      if (p >= 0.55) details.push(`${s.name.slice(0, 28)}… ${pct(p)}%`);
    }
  }

  return { lastSignal, barsSince, agreeingLong, agreeingShort, maxProx, details };
}

/**
 * Avalia proximidade ao alvo de entrada com indicadores REAIS + sinais das estratégias.
 * Não abre a porta — só mede quão perto estamos de um sinal de entrada.
 */
export function evaluateLiveEntry(
  candles: readonly Candle[],
  strategies: readonly Strategy[],
  opts?: { hold?: number },
): LiveEntryMetrics {
  if (!strategies.length) {
    return {
      proximityPct: 0,
      lastSignal: 0,
      barsSinceSignal: Infinity,
      agreeingLong: 0,
      agreeingShort: 0,
      total: 0,
      bias: "neutral",
      atTarget: false,
      detail: "sem estratégias",
    };
  }
  if (candles.length < 40) {
    return {
      proximityPct: 0,
      lastSignal: 0,
      barsSinceSignal: Infinity,
      agreeingLong: 0,
      agreeingShort: 0,
      total: strategies.length,
      bias: "neutral",
      atTarget: false,
      detail: `poucas velas (${candles.length})`,
    };
  }

  const hold = opts?.hold ?? 3;
  const st = signalStats(strategies, candles, hold);
  const atTarget = st.lastSignal !== 0;
  const agree = Math.max(st.agreeingLong, st.agreeingShort);
  const agreeFrac = agree / strategies.length;
  // Blend: signal at bar = 100; else max(indicator prox, agreement)
  let proximityPct = atTarget
    ? 100
    : pct(Math.max(st.maxProx, agreeFrac * 0.85));

  // Boost slightly if a recent signal is still "warm"
  if (!atTarget && Number.isFinite(st.barsSince) && st.barsSince <= hold) {
    proximityPct = Math.max(proximityPct, 70 + Math.round((hold - st.barsSince) * 8));
    proximityPct = Math.min(95, proximityPct);
  }

  const bias: LiveEntryMetrics["bias"] =
    st.agreeingLong > st.agreeingShort && st.agreeingLong > 0
      ? "long"
      : st.agreeingShort > st.agreeingLong && st.agreeingShort > 0
        ? "short"
        : st.lastSignal === 1
          ? "long"
          : st.lastSignal === -1
            ? "short"
            : "neutral";

  let detail: string;
  if (atTarget) {
    detail =
      st.lastSignal === 1
        ? `ALVO · sinal COMPRA (${agree}/${strategies.length} concordam)`
        : `ALVO · sinal VENDA (${agree}/${strategies.length} concordam)`;
  } else if (proximityPct >= 55) {
    detail = `Quase no alvo · ${bias === "long" ? "compra" : bias === "short" ? "venda" : "neutro"} · ${agree}/${strategies.length}` +
      (st.details[0] ? ` · ${st.details[0]}` : "");
  } else {
    detail = `A afastar/aguardar · ${agree}/${strategies.length} · prox ${proximityPct}%`;
  }

  return {
    proximityPct,
    lastSignal: st.lastSignal,
    barsSinceSignal: st.barsSince,
    agreeingLong: st.agreeingLong,
    agreeingShort: st.agreeingShort,
    total: strategies.length,
    bias,
    atTarget,
    detail,
  };
}

/** Combina porta (evidência) + proximidade de entrada para HUD. */
export function combineGateAndLive(
  gateAllowed: boolean,
  gateScore: number,
  live: LiveEntryMetrics,
): { score: number; label: string; ready: boolean } {
  if (gateAllowed && live.atTarget) {
    return { score: 100, label: "PORTA + ALVO", ready: true };
  }
  if (gateAllowed) {
    const score = Math.max(gateScore, Math.min(95, 55 + Math.round(live.proximityPct * 0.4)));
    return {
      score,
      label: live.atTarget ? "PORTA ABERTA · alvo" : "PORTA ABERTA · à espera do sinal",
      ready: false,
    };
  }
  // Gate closed: show live proximity but cap below "ready"
  const score = Math.min(70, Math.round(gateScore * 0.5 + live.proximityPct * 0.5));
  return { score, label: "NO TRADE · " + live.detail, ready: false };
}
