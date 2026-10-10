// NEVER LOSS - modo sombra: compara a porta NOVA (livro-razão, histórico profundo) com a ANTIGA (walk-forward curto)
// e acrescenta um critério mais estrito (FDR) — tudo INFORMATIVO. Nada aqui abre ou fecha portas nem muda o arm.

import { evaluateCandleGate } from "./candle-gate.ts";
import { benjaminiHochberg } from "./fdr.ts";
import type { Strategy } from "./strategies.ts";
import type { Candle } from "./market-data.ts";
import type { CandleMinLabel } from "./candle-gate.ts";

export { benjaminiHochberg } from "./fdr.ts";

/** Veredicto da porta antiga (walk-forward curto sobre a cauda), na forma pequena que se guarda. */
export interface LegacyVerdict {
  allowed: boolean;
  label: string;
  nOOS: number;
  meanR: number;
  p: number | null;
  /** nº de velas usadas (a cauda guardada). */
  candles: number;
}

export interface LegacyGateConfig {
  slAtr: number;
  tpR: number;
  maxBars: number;
  costFraction: number;
  minLabel: CandleMinLabel;
}

/** Porta antiga = a do painel antes do livro: walk-forward sobre as velas disponíveis (treino 40 %, teste 20 %, máx. 1000/500). */
export function legacyVerdict(candles: readonly Candle[], strategies: readonly Strategy[], cfg: LegacyGateConfig): LegacyVerdict {
  const n = candles.length;
  if (n < 1500) return { allowed: false, label: "INSUFFICIENT", nOOS: 0, meanR: 0, p: null, candles: n };
  const trainSize = Math.min(1000, Math.floor(n * 0.4));
  const testSize = Math.min(500, Math.floor(n * 0.2));
  const r = evaluateCandleGate(candles, strategies, { ...cfg, trainSize, testSize });
  return { allowed: r.allowed, label: r.label, nOOS: r.oosTrades, meanR: r.meanR, p: r.pValue, candles: n };
}

export type ShadowRelation = "both_open" | "new_only" | "old_only" | "both_closed";

export function shadowRelation(newAllowed: boolean, oldAllowed: boolean): ShadowRelation {
  if (newAllowed && oldAllowed) return "both_open";
  if (newAllowed) return "new_only";
  if (oldAllowed) return "old_only";
  return "both_closed";
}

/** Mínimo de operações OOS para um p-value entrar na família do FDR (abaixo disto o p-value é ruído). */
export const FDR_MIN_OOS = 30;
export const FDR_Q = 0.1;

/** Parte do registo que o modo sombra precisa (compatível com GateSummary.verdicts[preset]). */
export interface ShadowVerdictIn {
  allowed: boolean;
  label: string;
  nOOS: number;
  /** p-value do OOS agregado, sempre que há operações (mesmo abaixo do mínimo do preset). */
  oosP?: number | null;
  p: number | null;
  streak: number;
  legacy?: LegacyVerdict | null;
}

export interface ShadowSummaryIn {
  symbol: string;
  verdicts: Record<string, ShadowVerdictIn | undefined>;
}

export interface FdrFlag {
  /** nº de símbolos na família (mesmo preset, nOOS >= FDR_MIN_OOS e p-value disponível). */
  m: number;
  q: number;
  /** p-value ajustado (BH) ou null se o símbolo não entrou na família. */
  adjP: number | null;
  /** true se entrou na família e sobreviveu ao BH. */
  pass: boolean;
}

/** FDR por preset entre os símbolos: devolve { preset: { SYM: FdrFlag } }. Informativo. */
export function fdrByPreset(summaries: readonly ShadowSummaryIn[], presetIds: readonly string[], q: number = FDR_Q): Record<string, Record<string, FdrFlag>> {
  const out: Record<string, Record<string, FdrFlag>> = {};
  for (const id of presetIds) {
    const members: { sym: string; p: number }[] = [];
    for (const s of summaries) {
      const v = s.verdicts[id];
      if (!v || v.nOOS < FDR_MIN_OOS) continue;
      const p = v.oosP ?? v.p;
      if (p === null || p === undefined || !Number.isFinite(p)) continue;
      members.push({ sym: s.symbol, p });
    }
    const bh = benjaminiHochberg(members.map((x) => x.p), q);
    const byId: Record<string, FdrFlag> = {};
    for (const s of summaries) byId[s.symbol] = { m: bh.m, q, adjP: null, pass: false };
    members.forEach((mem, i) => {
      byId[mem.sym] = { m: bh.m, q, adjP: bh.adjP[i], pass: bh.reject[i]! };
    });
    out[id] = byId;
  }
  return out;
}

export interface ShadowPresetStats {
  tested: number;
  bothOpen: number;
  newOnly: number;
  oldOnly: number;
  bothClosed: number;
  /** símbolos com porta nova aberta (allowed) */
  newOpen: number;
  /** ... e que também passam o FDR (critério mais estrito). */
  newOpenFdrPass: number;
  fdrFamily: number;
  fdrPass: number;
  /** lista das discordâncias e das portas novas abertas (para auditoria). */
  disagreements: { symbol: string; relation: ShadowRelation; newLabel: string; oldLabel: string; newN: number; oldN: number }[];
  open: { symbol: string; label: string; nOOS: number; streak: number; adjP: number | null; fdrPass: boolean }[];
}

export function summarizeShadow(summaries: readonly ShadowSummaryIn[], presetIds: readonly string[], q: number = FDR_Q): Record<string, ShadowPresetStats> {
  const fdr = fdrByPreset(summaries, presetIds, q);
  const out: Record<string, ShadowPresetStats> = {};
  for (const id of presetIds) {
    const st: ShadowPresetStats = {
      tested: 0, bothOpen: 0, newOnly: 0, oldOnly: 0, bothClosed: 0, newOpen: 0, newOpenFdrPass: 0, fdrFamily: 0, fdrPass: 0, disagreements: [], open: [],
    };
    for (const s of summaries) {
      const v = s.verdicts[id];
      if (!v || !v.legacy) continue;
      st.tested += 1;
      const rel = shadowRelation(v.allowed, v.legacy.allowed);
      if (rel === "both_open") st.bothOpen += 1;
      else if (rel === "new_only") st.newOnly += 1;
      else if (rel === "old_only") st.oldOnly += 1;
      else st.bothClosed += 1;
      if (rel === "new_only" || rel === "old_only") {
        st.disagreements.push({ symbol: s.symbol, relation: rel, newLabel: v.label, oldLabel: v.legacy.label, newN: v.nOOS, oldN: v.legacy.nOOS });
      }
      const f = fdr[id]![s.symbol]!;
      if (f.adjP !== null) st.fdrFamily += 1;
      if (f.pass) st.fdrPass += 1;
      if (v.allowed) {
        st.newOpen += 1;
        if (f.pass) st.newOpenFdrPass += 1;
        st.open.push({ symbol: s.symbol, label: v.label, nOOS: v.nOOS, streak: v.streak, adjP: f.adjP, fdrPass: f.pass });
      }
    }
    out[id] = st;
  }
  return out;
}
