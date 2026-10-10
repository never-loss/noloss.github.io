// NEVER LOSS - vista da porta em cache para a UI (puro, testável): converte o veredicto do servidor no formato que o
// painel já usa e gera as etiquetas HONESTAS (profundidade do histórico, idade, n OOS). Nada aqui promete lucro.

/** Veredicto de um preset, como devolve /api/bybit-klines?mode=gate (campos usados pela UI). */
export interface CachedPresetView {
  allowed: boolean;
  open?: boolean;
  label: string;
  reason: string;
  strategy: string | null;
  nOOS: number;
  meanR: number;
  p: number | null;
  folds: number;
  foldsPositive?: number;
  foldsWithTrades?: number;
  asOf: number | null;
  depthDays: number;
  streak: number;
  needOos?: number;
}

export interface CachedGateView {
  symbol: string;
  updatedAt: number;
  ageMs: number;
  stale: boolean;
  historyDays: number | null;
  presets: Record<string, CachedPresetView>;
}

/** Resultado no formato de CandleGateResult + metadados de origem (a UI usa os mesmos campos de sempre). */
export interface CachedGateResult {
  allowed: boolean;
  label: string;
  reason: string;
  strategy: { name: string } | null;
  oosTrades: number;
  meanR: number;
  pValue: number | null;
  source: "cache";
  folds: number;
  foldsPositive: number;
  foldsWithTrades: number;
  depthDays: number;
  historyDays: number | null;
  asOf: number | null;
  ageMs: number;
  stale: boolean;
  streak: number;
  /** Porta passou mas ainda não tem 2 validações seguidas (histerese): não está "confirmada". */
  confirming: boolean;
  needOos: number;
}

/** Idade (ms) → texto PT curto: "agora", "há 3 min", "há 5 h", "há 2 d". */
export function formatAgePt(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "agora";
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

/** Cache utilizável: tem o preset e não é mais velha que `maxAgeMs` (por omissão 6 h). Senão: cálculo local. */
export function isCacheUsable(gate: CachedGateView | null | undefined, presetId: string, maxAgeMs: number = 6 * 3600 * 1000): boolean {
  if (!gate || !gate.presets || !gate.presets[presetId]) return false;
  if (!Number.isFinite(gate.ageMs) || gate.ageMs > maxAgeMs) return false;
  const v = gate.presets[presetId]!;
  return typeof v.allowed === "boolean" && typeof v.nOOS === "number" && typeof v.label === "string";
}

export function cachedVerdictToResult(gate: CachedGateView, presetId: string): CachedGateResult | null {
  const v = gate.presets[presetId];
  if (!v) return null;
  const confirming = v.allowed && v.streak < 2;
  const reason = confirming ? `${v.reason} · a confirmar (validação ${v.streak}/2)` : v.reason;
  return {
    allowed: v.allowed,
    label: v.label,
    reason,
    strategy: v.strategy ? { name: v.strategy } : null,
    oosTrades: v.nOOS,
    meanR: v.meanR,
    pValue: v.p,
    source: "cache",
    folds: v.folds,
    foldsPositive: v.foldsPositive ?? 0,
    foldsWithTrades: v.foldsWithTrades ?? 0,
    depthDays: v.depthDays,
    historyDays: gate.historyDays,
    asOf: v.asOf,
    ageMs: gate.ageMs,
    stale: gate.stale,
    streak: v.streak,
    confirming,
    needOos: v.needOos ?? 0,
  };
}

const days = (d: number | null | undefined): string => (d === null || d === undefined || !Number.isFinite(d) ? "?" : String(Math.round(d)));

/**
 * Etiqueta honesta sob a porta. Cache: "histórico: 90d · OOS 83d (48 blocos) · n OOS 610 · atualizado há 3 min".
 * Local: "cálculo local: 3500 velas (≈12d) · n OOS 85".
 */
export function gateProvenanceLabel(
  r: { source?: string; oosTrades?: number; depthDays?: number; historyDays?: number | null; folds?: number; ageMs?: number; stale?: boolean; candlesUsed?: number; gran?: number } | null | undefined,
): string {
  if (!r) return "";
  const n = typeof r.oosTrades === "number" ? ` · n OOS ${r.oosTrades}` : "";
  if (r.source === "cache") {
    const age = typeof r.ageMs === "number" ? formatAgePt(r.ageMs) : "—";
    const blocks = typeof r.folds === "number" ? ` (${r.folds} blocos)` : "";
    return `histórico: ${days(r.historyDays)}d · OOS ${days(r.depthDays)}d${blocks}${n} · atualizado ${age}${r.stale ? " · desatualizado" : ""} · cache do servidor`;
  }
  if (typeof r.candlesUsed === "number") {
    const g = r.gran && r.gran > 0 ? r.gran : 300;
    return `cálculo local: ${r.candlesUsed} velas (≈${days((r.candlesUsed * g) / 86400)}d)${n} · sem cache`;
  }
  return "";
}
