// NEVER LOSS - teste 4 h pré-registado (notes/preregistro-4h-forward-2026-10-15.md): 5 candidatos de seguimento de tendência.
// Só PAPER / investigação: este módulo NÃO coloca ordens e não é uma porta. Sem evidência até ao fim do protocolo (90 d).

import { runCandleBacktest, expectancyPValue } from "./candle-backtest.ts";
import { atr } from "./indicators.ts";
import { emaCross } from "./strategies.ts";
import type { Signal, Strategy } from "./strategies.ts";
import { feasible } from "./feasible.ts";
import { benjaminiHochberg } from "./fdr.ts";
import type { Candle } from "./market-data.ts";

export const F4H_GRAN = 14400;
export const F4H_SL_ATR = 3;
export const F4H_TP_R = 2;
export const F4H_MAX_BARS = 60;
export const F4H_MAX_STOP = 0.08;
export const F4H_WARMUP = 250;
/** Custo primário pré-registado: taker×2 (0,11 %) + derrapagem SUPOSTA 0,01 %/lado. */
export const F4H_COST = 0.0013;
export const F4H_DURATION_DAYS = 90;
export const F4H_MIN_TRADES = 50;
export const F4H_LABEL = "teste 4 h em PAPER, sem evidência ainda";
export const F4H_SYMBOLS = "BTC ETH SOL XRP DOGE BNB ADA AVAX LINK LTC DOT TRX BCH ATOM NEAR APT ARB OP SUI INJ FIL ETC UNI AAVE XLM HBAR ICP ALGO RUNE CRV"
  .split(" ").map((s) => `${s}USDT`);

type SigFn = (c: readonly Candle[]) => Signal[];
const zeros = (n: number): Signal[] => new Array<Signal>(n).fill(0);

export function donchianSignals(N: number): SigFn {
  return (c) => {
    const s = zeros(c.length);
    for (let i = N; i < c.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - N; j < i; j++) { if (c[j]!.high > hi) hi = c[j]!.high; if (c[j]!.low < lo) lo = c[j]!.low; }
      s[i] = c[i]!.close > hi ? 1 : c[i]!.close < lo ? -1 : 0;
    }
    return s;
  };
}
export function volExpansion(base: SigFn): SigFn {
  return (c) => {
    const raw = base(c);
    const a = atr(c, 14);
    const ratio = c.map((x, i) => (a[i] == null ? NaN : a[i]! / x.close));
    return raw.map((v, i) => {
      if (v === 0 || i < 200 || !Number.isFinite(ratio[i]!)) return 0;
      const w = ratio.slice(i - 200, i).filter(Number.isFinite).sort((x, y) => x - y);
      if (w.length < 100) return 0;
      return ratio[i]! > w[w.length >> 1]! ? v : 0;
    });
  };
}
export function tsmomSignals(L: number): SigFn {
  return (c) => {
    const s = zeros(c.length);
    for (let i = L; i < c.length; i++) { const r = c[i]!.close / c[i - L]!.close - 1; s[i] = r > 0 ? 1 : r < 0 ? -1 : 0; }
    return s;
  };
}

export const F4H_CANDIDATES: readonly { id: string; label: string; sig: SigFn }[] = [
  { id: "A3", label: "Donchian 20", sig: donchianSignals(20) },
  { id: "A4", label: "Donchian 55", sig: donchianSignals(55) },
  { id: "B2", label: "EMA 20/50", sig: (c) => emaCross({ fast: 20, slow: 50 }).signals(c) },
  { id: "C2", label: "Donchian 20 + volatilidade", sig: volExpansion(donchianSignals(20)) },
  { id: "D2", label: "Momentum 90 velas", sig: tsmomSignals(90) },
];

export interface F4hTrade {
  candidate: string;
  symbol: string;
  direction: 1 | -1;
  /** Época (s) da vela de entrada e da vela de saída (null = ainda aberta). */
  entryEpoch: number;
  exitEpoch: number | null;
  entry: number;
  exit: number | null;
  reason: "sl" | "tp" | "time" | null;
  /** R líquido (custo primário); null enquanto aberta. */
  r: number | null;
}

/**
 * Operações de um candidato num símbolo, só com sinais em velas fechadas com época >= fromEpoch
 * (e índice >= aquecimento). Uma operação cuja saída ainda não aconteceu é devolvida como ABERTA (nunca fecho fictício).
 */
export function candidateTrades(candles: readonly Candle[], cand: { id: string; sig: SigFn }, symbol: string, fromEpoch: number, toEpochExclusive = Infinity, cost = F4H_COST): F4hTrade[] {
  const n = candles.length;
  if (n < F4H_WARMUP + 2) return [];
  const strat: Strategy = feasible({ name: cand.id, signals: cand.sig }, { slAtr: F4H_SL_ATR, maxStopFraction: F4H_MAX_STOP });
  const sigs = strat.signals(candles);
  const a = atr(candles, 14);
  let start = candles.findIndex((c) => c.epoch >= fromEpoch);
  if (start < 0) return [];
  start = Math.max(start, F4H_WARMUP);
  let end = n;
  if (Number.isFinite(toEpochExclusive)) { const k = candles.findIndex((c) => c.epoch >= toEpochExclusive); if (k >= 0) end = k; }
  if (start >= end - 1) return [];
  const bt = runCandleBacktest(candles, strat, { slAtr: F4H_SL_ATR, tpR: F4H_TP_R, maxBars: F4H_MAX_BARS, costFraction: cost, start, end }, { signals: sigs, atrs: a });
  return bt.trades.map((t) => {
    const open = t.reason === "time" && t.exitIndex === end - 1 && t.exitIndex - t.entryIndex < F4H_MAX_BARS;
    return {
      candidate: cand.id,
      symbol,
      direction: t.direction,
      entryEpoch: candles[t.entryIndex]!.epoch,
      exitEpoch: open ? null : candles[t.exitIndex]!.epoch,
      entry: t.entry,
      exit: open ? null : t.exit,
      reason: open ? null : t.reason,
      r: open ? null : t.r,
    };
  });
}

export interface F4hCandidateStats {
  id: string;
  label: string;
  closed: number;
  open: number;
  netR: number;
  meanR: number;
  pDaily: number | null;
  adjP: number | null;
}

/** Série diária (soma de R por dia de saída / nº de símbolos), dias [d0, d1). */
export function dailySeries(trades: readonly F4hTrade[], d0: number, d1: number, nSym: number): number[] {
  const arr = new Array<number>(Math.max(0, d1 - d0)).fill(0);
  for (const t of trades) {
    if (t.r === null || t.exitEpoch === null) continue;
    const d = Math.floor(t.exitEpoch / 86400);
    if (d >= d0 && d < d1) arr[d - d0]! += t.r / nSym;
  }
  return arr;
}

/** Estatísticas por candidato (BH sobre os 5 p-values). Só informativo até ao fim do protocolo. */
export function forwardStats(trades: readonly F4hTrade[], fromEpoch: number, nowEpoch: number, nSym: number): F4hCandidateStats[] {
  const d0 = Math.floor(fromEpoch / 86400);
  const d1 = Math.max(d0, Math.floor(nowEpoch / 86400) + 1);
  const rows = F4H_CANDIDATES.map((c) => {
    const mine = trades.filter((t) => t.candidate === c.id);
    const closed = mine.filter((t) => t.r !== null);
    const netR = closed.reduce((s, t) => s + (t.r as number), 0);
    const daily = dailySeries(closed, d0, d1, Math.max(1, nSym));
    return {
      id: c.id, label: c.label, closed: closed.length, open: mine.length - closed.length, netR,
      meanR: closed.length ? netR / closed.length : 0,
      pDaily: closed.length >= 2 ? expectancyPValue(daily) : null,
      adjP: null as number | null,
    };
  });
  const bh = benjaminiHochberg(rows.map((r) => r.pDaily), 0.1);
  rows.forEach((r, i) => { r.adjP = bh.adjP[i] ?? null; });
  return rows;
}

export interface F4hVerdict { id: string; pass: boolean; reasons: string[] }

/** Critério pré-registado ao dia 90. Antes do fim devolve sempre "sem evidência ainda". */
export function forwardVerdict(stats: readonly F4hCandidateStats[], startEpoch: number, nowEpoch: number): { final: boolean; verdicts: F4hVerdict[] } {
  const final = nowEpoch >= startEpoch + F4H_DURATION_DAYS * 86400;
  const verdicts = stats.map((s) => {
    const reasons: string[] = [];
    if (!final) reasons.push("protocolo ainda a decorrer (90 d)");
    if (s.closed < F4H_MIN_TRADES) reasons.push(`só ${s.closed} operações fechadas (mín. ${F4H_MIN_TRADES})`);
    if (!(s.meanR > 0)) reasons.push("R/op ≤ 0");
    if (s.adjP === null || s.adjP > 0.1) reasons.push("p ajustado (BH) > 0,10");
    return { id: s.id, pass: final && reasons.length === 0, reasons };
  });
  return { final, verdicts };
}

/** Primeira vela 4 h que abre DEPOIS de `nowMs` (início fixo do teste). */
export function forwardStartEpoch(nowMs: number): number {
  return (Math.floor(nowMs / 1000 / F4H_GRAN) + 1) * F4H_GRAN;
}

/** Junta operações novas com as já gravadas, preservando `firstSeenAt` (auditoria). */
export function mergeForwardTrades(prev: readonly (F4hTrade & { firstSeenAt?: number })[], next: readonly F4hTrade[], nowMs: number): (F4hTrade & { firstSeenAt: number })[] {
  const key = (t: F4hTrade): string => `${t.candidate}|${t.symbol}|${t.entryEpoch}`;
  const seen = new Map(prev.map((t) => [key(t), t.firstSeenAt ?? nowMs]));
  return next.map((t) => ({ ...t, firstSeenAt: seen.get(key(t)) ?? nowMs }));
}
