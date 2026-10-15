// Teste 4 h pré-registado em PAPER (notes/preregistro-4h-forward-2026-10-15.md).
// SÓ PAPER: este módulo não importa nem chama nada que coloque ordens. Não é uma porta e não muda nenhum preset.
// O resultado é determinístico a partir das velas 4 h reais da Bybit desde o início fixo; cada tick grava o estado (Upstash).

import {
  F4H_CANDIDATES,
  F4H_SYMBOLS,
  F4H_GRAN,
  F4H_COST,
  F4H_DURATION_DAYS,
  F4H_LABEL,
  candidateTrades,
  forwardStats,
  forwardVerdict,
  forwardStartEpoch,
  mergeForwardTrades,
} from "./nl-cloud.mjs";
import { getForward4hState, saveForward4hState } from "./arm-store.js";
import { fetchArmCandleHistory } from "./arm-klines.js";

export const F4H_MIN_REFRESH_MS = 15 * 60 * 1000;
const PREREG = "notes/preregistro-4h-forward-2026-10-15.md";

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = { ok: true, value: await fn(items[k]) }; } catch (e) { out[k] = { ok: false, error: e && e.message ? String(e.message) : "erro" }; }
    }
  }));
  return out;
}

/** Vista pública (sem nada de REAL). */
export function publicForward4h(state, nowMs = Date.now()) {
  if (!state || !state.startEpoch) {
    return { started: false, mode: "PAPER", label: F4H_LABEL, preregistration: PREREG, durationDays: F4H_DURATION_DAYS };
  }
  const nowEpoch = Math.floor(nowMs / 1000);
  const stats = forwardStats(state.trades || [], state.startEpoch, nowEpoch, F4H_SYMBOLS.length);
  const verdict = forwardVerdict(stats, state.startEpoch, nowEpoch);
  const closed = (state.trades || []).filter((t) => t.r !== null);
  return {
    started: true,
    mode: "PAPER",
    label: verdict.final ? "teste 4 h em PAPER — protocolo terminado" : F4H_LABEL,
    preregistration: PREREG,
    startedAt: state.startedAt,
    startEpoch: state.startEpoch,
    endsEpoch: state.startEpoch + F4H_DURATION_DAYS * 86400,
    daysElapsed: Math.max(0, Math.floor((nowEpoch - state.startEpoch) / 86400)),
    durationDays: F4H_DURATION_DAYS,
    costFraction: F4H_COST,
    symbols: F4H_SYMBOLS.length,
    updatedAt: state.updatedAt || null,
    lastErrors: state.lastErrors || [],
    totals: { closed: closed.length, open: (state.trades || []).length - closed.length, netR: closed.reduce((s, t) => s + t.r, 0) },
    candidates: stats,
    verdict,
    recentTrades: closed.slice().sort((a, b) => b.exitEpoch - a.exitEpoch).slice(0, 10),
  };
}

/** Inicia o teste (uma vez). Se já começou, devolve o estado existente: o início nunca é reposto. */
export async function startForward4h(nowMs = Date.now(), deps = {}) {
  const get = deps.getState || getForward4hState;
  const save = deps.saveState || saveForward4hState;
  const prev = await get();
  if (prev && prev.startEpoch) return { created: false, state: prev };
  const state = { version: 1, mode: "PAPER", startedAt: nowMs, startEpoch: forwardStartEpoch(nowMs), trades: [], updatedAt: null, lastErrors: [] };
  await save(state);
  return { created: true, state };
}

/**
 * Avança o teste (cron ou GET preguiçoso). Sem início → nada. Recalcula tudo desde o início a partir das velas reais;
 * se um símbolo falhar, mantém as operações já gravadas desse símbolo (nunca apaga por falha de rede).
 */
export async function advanceForward4h(nowMs = Date.now(), deps = {}) {
  const get = deps.getState || getForward4hState;
  const save = deps.saveState || saveForward4hState;
  const fetchCandles = deps.fetchCandles || ((sym) => fetchArmCandleHistory(sym, F4H_GRAN, 1000));
  const state = await get();
  if (!state || !state.startEpoch) return { advanced: false, state: null };
  if (!deps.force && state.updatedAt && nowMs - state.updatedAt < F4H_MIN_REFRESH_MS) return { advanced: false, state };
  if (Math.floor(nowMs / 1000) < state.startEpoch) return { advanced: false, state };
  const endEpoch = state.startEpoch + F4H_DURATION_DAYS * 86400;
  const results = await mapLimit(F4H_SYMBOLS, 6, fetchCandles);
  const prev = state.trades || [];
  const next = [];
  const errors = [];
  F4H_SYMBOLS.forEach((sym, k) => {
    const r = results[k];
    if (!r || !r.ok) {
      errors.push(`${sym}: ${r ? r.error : "erro"}`);
      next.push(...prev.filter((t) => t.symbol === sym));
      return;
    }
    // só velas FECHADAS (a vela em formação nunca entra)
    const closed = r.value.filter((c) => c.epoch + F4H_GRAN <= Math.floor(nowMs / 1000));
    for (const cand of F4H_CANDIDATES) next.push(...candidateTrades(closed, cand, sym, state.startEpoch, endEpoch, F4H_COST));
  });
  const trades = mergeForwardTrades(prev, next, nowMs);
  const out = { ...state, trades, updatedAt: nowMs, lastErrors: errors.slice(0, 10) };
  await save(out);
  return { advanced: true, state: out };
}
