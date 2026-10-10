// Orquestração do cache da porta: lê o Redis, descarrega só o que falta (arranque a frio 90 dias, ou só velas novas),
// recalcula só blocos novos (livro-razão), grava em lote e protege com bloqueio SET NX EX + orçamento global.
// O cálculo é o mesmo em todo o lado (lib/nl-gate.mjs, gerado de src/core/gate-service.ts).
import { fetchDeepHistory, HistoryError, lastClosedStart } from "./history.js";
import {
  readGateEntry,
  writeGateEntry,
  readGateSummary,
  acquireLock,
  releaseLock,
  bumpBudget,
  setJson,
  getJson,
  lockKey,
  negKey,
  budgetKey,
  CURSOR_KEY,
  TOP_KEY,
} from "./gate-store.js";
import {
  computeGateEntry,
  summarizeEntry,
  tailToCandles,
  configInfo,
  gateSetup,
  GATE_PRESET_IDS,
  GATE_GRAN,
  GATE_COLD_DAYS,
  GATE_FRESH_MS,
  GATE_MAX_WARM_GAP_CANDLES,
  GATE_TAIL_KEEP,
  GATE_PRESET_IDS as PRESETS,
} from "./nl-gate.mjs";

export const GATE_SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;
export const COLD_BUDGET_PER_HOUR = 60;
export const WARM_BUDGET_PER_HOUR = 400;
export const LOCK_TTL_SEC = 90;
export const NEG_TTL_SEC = 600;
export const TOP_N = 40;
export const TOP_TTL_SEC = 86400;
/** Lista de recurso se a Bybit não responder aos tickers. */
export const FALLBACK_TOP = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "BNBUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "LTCUSDT", "TRXUSDT", "SUIUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT", "ATOMUSDT", "FILUSDT", "INJUSDT",
];

const HEADERS = { Accept: "application/json", "User-Agent": "never-loss/0.1 (gate-cache; paper)" };

function currentHashes() {
  return configInfo(GATE_PRESET_IDS.map((id) => gateSetup(id))).hashes;
}

function sameHashes(a, b) {
  const ka = Object.keys(b);
  return ka.length === Object.keys(a || {}).length && ka.every((k) => a && a[k] === b[k]);
}

/** Vista pública de um resumo: idade, frescura, e as chaves pedidas (nOOS, p, streak...). */
export function publicGate(summary, nowMs, extra = {}) {
  if (!summary) return null;
  const ageMs = Math.max(0, nowMs - summary.updatedAt);
  const presets = {};
  for (const [id, v] of Object.entries(summary.verdicts || {})) {
    presets[id] = {
      allowed: v.allowed,
      open: v.allowed && v.streak >= 2,
      label: v.label,
      reason: v.reason,
      strategy: v.strategy,
      nOOS: v.nOOS,
      meanR: v.meanR,
      p: v.p,
      folds: v.folds,
      foldsPositive: v.foldsPositive,
      foldsWithTrades: v.foldsWithTrades,
      asOf: v.asOf,
      depthDays: v.depthDays,
      streak: v.streak,
      minLabel: v.minLabel,
      needOos: v.needOos,
    };
  }
  return {
    symbol: summary.symbol,
    gran: summary.gran,
    updatedAt: summary.updatedAt,
    ageMs,
    stale: ageMs > GATE_FRESH_MS,
    lastEpoch: summary.lastEpoch,
    historyFrom: summary.historyFrom,
    historyDays: summary.historyFrom ? Math.round(((summary.lastEpoch - summary.historyFrom) / 86400) * 10) / 10 : null,
    cfg: summary.cfg,
    presets,
    ...extra,
  };
}

/**
 * Actualiza (ou cria) o registo de um símbolo. Nunca lança por falhas da Bybit: devolve { status, ... }.
 * status: "fresh" | "refreshed" | "locked" | "budget" | "invalid" | "nodata" | "error"
 */
export async function refreshGate(symbol, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl; // fetch do Redis (testes)
  const now = deps.now || Date.now;
  const history = deps.history || fetchDeepHistory;
  const gran = GATE_GRAN;
  if (!GATE_SYMBOL_RE.test(symbol)) return { status: "invalid", error: "invalid_symbol" };
  if (await getJson(negKey(symbol), env, fetchImpl)) return { status: "invalid", error: "symbol_unknown_recent" };

  const lock = lockKey(symbol, gran);
  if (!(await acquireLock(lock, LOCK_TTL_SEC, env, fetchImpl))) return { status: "locked" };
  try {
    const nowMs = now();
    const prev = await readGateEntry(symbol, gran, env, fetchImpl);
    if (prev && !deps.force && nowMs - prev.updatedAt <= (deps.freshMs ?? GATE_FRESH_MS)) {
      return { status: "fresh", summary: summarizeEntry(prev) };
    }
    const hashesOk = !!prev && sameHashes(prev.cfg && prev.cfg.hashes, currentHashes());
    const lastClosed = lastClosedStart(nowMs, gran);
    const gap = prev ? Math.round((lastClosed - prev.lastEpoch) / gran) : Infinity;
    const warm = hashesOk && Array.isArray(prev.tail) && prev.tail.length >= 2600 && gap <= GATE_MAX_WARM_GAP_CANDLES;
    const kind = warm ? "warm" : "cold";

    const hour = Math.floor(nowMs / 3_600_000);
    const used = await bumpBudget(budgetKey(kind, hour), 2 * 3600, env, fetchImpl);
    if (used > (kind === "cold" ? COLD_BUDGET_PER_HOUR : WARM_BUDGET_PER_HOUR)) {
      return { status: "budget", kind, summary: prev ? summarizeEntry(prev) : null };
    }

    let candles = null;
    let historyFrom = null;
    let requests = 0;
    let usedKind = kind;
    const coldFetch = async () => {
      const h = await history(symbol, gran, { days: GATE_COLD_DAYS, now, ...(deps.historyOpts || {}) });
      requests += h.requests;
      if (h.candles.length === 0) {
        if (h.complete) await setJson(negKey(symbol), { at: nowMs, why: "no_data" }, NEG_TTL_SEC, env, fetchImpl);
        return { status: "nodata", kind: "cold", error: h.complete ? "no_data" : "incomplete_history" };
      }
      if (!h.complete && h.candles.length < 2600) {
        return { status: "error", error: "incomplete_history", kind: "cold", summary: prev ? summarizeEntry(prev) : null };
      }
      candles = h.candles;
      historyFrom = candles[0].epoch;
      usedKind = "cold";
      return null;
    };
    try {
      if (warm) {
        const count = Math.max(3, gap + 3);
        const h = await history(symbol, gran, { count, now, ...(deps.historyOpts || {}) });
        requests += h.requests;
        if (!h.complete || h.candles.length === 0) return { status: "error", error: "incomplete_history", kind, summary: summarizeEntry(prev) };
        if (h.candles[0].epoch > prev.lastEpoch + gran) {
          // Buraco entre a cauda guardada e as velas novas (ex.: velas sem volume): não colar; refaz a frio.
          const bad = await coldFetch();
          if (bad) return bad;
        } else {
          const map = new Map(tailToCandles(prev.tail).map((c) => [c.epoch, c]));
          for (const c of h.candles) map.set(c.epoch, c);
          candles = [...map.values()].sort((a, b) => a.epoch - b.epoch);
          historyFrom = prev.historyFrom;
        }
      } else {
        const bad = await coldFetch();
        if (bad) return bad;
      }
    } catch (e) {
      if (e instanceof HistoryError && e.fatal && e.code.startsWith("bybit_")) {
        await setJson(negKey(symbol), { at: nowMs, why: e.code }, NEG_TTL_SEC, env, fetchImpl);
        return { status: "invalid", error: e.code };
      }
      return { status: "error", error: e && e.code ? e.code : "history_failed", message: e && e.message ? String(e.message) : "", kind, summary: prev ? summarizeEntry(prev) : null };
    }

    const entry = computeGateEntry(hashesOk ? prev : null, symbol, candles, nowMs, { historyFrom });
    if (entry.tail.length > GATE_TAIL_KEEP) throw new Error("tail_too_long");
    const summary = summarizeEntry(entry);
    await writeGateEntry(entry, summary, env, fetchImpl);
    return { status: "refreshed", kind: usedKind, requests, summary };
  } finally {
    await releaseLock(lock, env, fetchImpl).catch(() => {});
  }
}

/** Resumo em cache (1 comando). Se `refresh` e estiver em falta/velho, actualiza na hora (limitado por bloqueio/orçamento). */
export async function getGate(symbol, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl;
  const now = deps.now || Date.now;
  const gran = GATE_GRAN;
  if (!GATE_SYMBOL_RE.test(symbol)) return { ok: false, error: "invalid_symbol" };
  let summary = await readGateSummary(symbol, gran, env, fetchImpl);
  let source = summary ? "cache" : "none";
  let refreshStatus = null;
  const needs = !summary || now() - summary.updatedAt > GATE_FRESH_MS;
  if (needs && deps.refresh !== false) {
    const r = await refreshGate(symbol, deps);
    refreshStatus = r.status;
    if (r.summary && (r.status === "refreshed" || r.status === "fresh")) {
      summary = r.summary;
      source = r.status === "refreshed" ? "refreshed" : "cache";
    }
    if (r.status === "invalid") return { ok: false, error: r.error, status: 404 };
  }
  if (!summary) return { ok: true, known: false, symbol, refresh: refreshStatus };
  return { ok: true, known: true, gate: publicGate(summary, now(), { source, refresh: refreshStatus }) };
}

async function fetchTop(n, deps) {
  const f = deps.topFetch || globalThis.fetch;
  const bases = ["https://api.bybit.com", "https://api.bytick.com"];
  for (const base of bases) {
    try {
      const res = await f(`${base}/v5/market/tickers?category=linear`, { headers: HEADERS });
      if (!res.ok) continue;
      const json = await res.json();
      const list = json && json.result && Array.isArray(json.result.list) ? json.result.list : [];
      const rows = list
        .filter((t) => t && GATE_SYMBOL_RE.test(String(t.symbol)))
        .map((t) => ({ symbol: String(t.symbol), turnover: Number(t.turnover24h) }))
        .filter((t) => Number.isFinite(t.turnover) && t.turnover > 0)
        .sort((a, b) => b.turnover - a.turnover)
        .slice(0, n);
      if (rows.length >= 5) return rows.map((r) => r.symbol);
    } catch {
      /* tenta a base seguinte */
    }
  }
  return null;
}

/** Símbolos mais líquidos (por turnover 24h), em cache 24 h; lista de recurso se a Bybit falhar. */
export async function topSymbols(deps = {}) {
  const env = deps.env || process.env;
  const cached = await getJson(TOP_KEY, env, deps.fetchImpl);
  if (cached && Array.isArray(cached.symbols) && cached.symbols.length) return cached.symbols;
  const fresh = await fetchTop(deps.topN || TOP_N, deps);
  const symbols = fresh || FALLBACK_TOP;
  if (fresh) await setJson(TOP_KEY, { symbols, at: (deps.now || Date.now)() }, TOP_TTL_SEC, env, deps.fetchImpl);
  return symbols;
}

/**
 * Backfill diário em lotes com cursor: processa símbolos a partir do cursor até esgotar o tempo (`budgetMs`),
 * grava o cursor e continua na chamada seguinte. Sem repetir símbolos já frescos.
 */
export async function backfillGate(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl;
  const now = deps.now || Date.now;
  const budgetMs = deps.budgetMs ?? 40_000;
  const clock = deps.clock || Date.now;
  const started = clock();
  const symbols = deps.symbols || (await topSymbols(deps));
  const cur = (await getJson(CURSOR_KEY, env, fetchImpl)) || { i: 0 };
  let i = Number.isInteger(cur.i) && cur.i >= 0 && cur.i < symbols.length ? cur.i : 0;
  const done = [];
  const failed = [];
  let cycleComplete = false;
  let budgetHit = false;
  while (i < symbols.length && clock() - started < budgetMs) {
    const batch = symbols.slice(i, i + (deps.concurrency ?? 2));
    const results = await Promise.all(batch.map((s) => refreshGate(s, deps).then((r) => ({ s, r }))));
    for (const { s, r } of results) {
      if (r.status === "refreshed" || r.status === "fresh") done.push({ symbol: s, status: r.status, kind: r.kind || null });
      else failed.push({ symbol: s, status: r.status, error: r.error || null });
    }
    // Sem orçamento: o cursor fica NO primeiro símbolo que ficou por fazer (não o salta) e retoma-se depois.
    const firstBudget = results.findIndex(({ r }) => r.status === "budget");
    if (firstBudget >= 0) {
      i += firstBudget;
      budgetHit = true;
      break;
    }
    i += batch.length;
  }
  if (!budgetHit && i >= symbols.length) {
    cycleComplete = true;
    i = 0;
  }
  await setJson(CURSOR_KEY, { i, total: symbols.length, updatedAt: now(), lastCycleComplete: cycleComplete ? now() : cur.lastCycleComplete || null }, 7 * 86400, env, fetchImpl);
  return { total: symbols.length, processed: done.length + failed.length, done, failed, nextIndex: i, cycleComplete, budgetHit, elapsedMs: clock() - started };
}

/** Início (s) da fronteira de bloco mais recente já fechada à data `nowMs` (blocos de 500 velas alinhados à época). */
export function lastBlockBoundary(nowMs, gran = GATE_GRAN, blockCandles = 500) {
  const lastEnd = lastClosedStart(nowMs, gran) + gran;
  const span = blockCandles * gran;
  return Math.floor(lastEnd / span) * span;
}

/**
 * Contexto da porta para o arm na nuvem (modo "ledger"): livro-razão do preset + velas fechadas (cauda guardada +
 * novas, até agora). Devolve null se não for possível ter um livro COMPLETO e velas contíguas — o chamador decide
 * (job novo → legacy; job em modo ledger → salta o tick em vez de usar dados parciais).
 */
export async function loadArmGateContext(symbol, presetId, granularity, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl;
  const now = deps.now || Date.now;
  const history = deps.history || fetchDeepHistory;
  if (granularity !== GATE_GRAN || !PRESETS.includes(presetId) || !GATE_SYMBOL_RE.test(symbol)) return null;
  const hashes = currentHashes();
  const usable = (e) =>
    !!e && sameHashes(e.cfg && e.cfg.hashes, hashes) && !!e.ledgers && !!e.ledgers[presetId] &&
    Array.isArray(e.tail) && e.tail.length >= 2600 &&
    // o livro já viu a última fronteira de bloco → está completo para "agora" (determinismo do arm)
    e.lastEpoch + GATE_GRAN >= lastBlockBoundary(now());
  let entry = await readGateEntry(symbol, GATE_GRAN, env, fetchImpl);
  if (!usable(entry)) {
    await refreshGate(symbol, { ...deps, force: true });
    entry = await readGateEntry(symbol, GATE_GRAN, env, fetchImpl);
    if (!usable(entry)) return null;
  }
  const nowMs = now();
  const lastClosed = lastClosedStart(nowMs, GATE_GRAN);
  const gap = Math.round((lastClosed - entry.lastEpoch) / GATE_GRAN);
  let candles = tailToCandles(entry.tail);
  if (gap > 0) {
    if (gap > GATE_MAX_WARM_GAP_CANDLES) return null;
    let h;
    try {
      h = await history(symbol, GATE_GRAN, { count: gap + 3, now, ...(deps.historyOpts || {}) });
    } catch {
      return null;
    }
    if (!h.complete || h.candles.length === 0 || h.candles[0].epoch > entry.lastEpoch + GATE_GRAN) return null;
    const map = new Map(candles.map((c) => [c.epoch, c]));
    for (const c of h.candles) map.set(c.epoch, c);
    candles = [...map.values()].sort((a, b) => a.epoch - b.epoch);
  }
  return {
    ledger: entry.ledgers[presetId],
    candles,
    asOf: entry.lastEpoch,
    updatedAt: entry.updatedAt,
  };
}
