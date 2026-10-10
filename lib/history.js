// NEVER LOSS — histórico profundo de velas Bybit (linear USDT), servidor.
// Janelas de tempo FIXAS alinhadas à época (1000 velas cada): o mesmo pedido dá sempre o mesmo resultado
// (janelas fechadas são imutáveis → cacheáveis) e as janelas podem ir em paralelo (concorrência limitada).
// Só devolve velas FECHADAS com volume > 0, sem duplicados, e diz honestamente se ficou algum buraco.
// Sem chaves, sem ordens: só dados públicos de mercado.

export const HISTORY_BASES = ["https://api.bybit.com", "https://api.bytick.com"];
export const HISTORY_PAGE = 1000; // limite da API Bybit por pedido
export const HISTORY_GRAN_TO_INTERVAL = { 60: "1", 300: "5", 900: "15", 3600: "60" };

const HEADERS = { Accept: "application/json", "User-Agent": "never-loss/0.1 (history; paper)" };

// retCode Bybit: limite de pedidos / erros temporários do servidor
const RATE_LIMIT_CODES = new Set([10006, 10018]);
const TRANSIENT_CODES = new Set([10000, 10016, 10019]);

export class HistoryError extends Error {
  constructor(code, message, fatal = false) {
    super(message || code);
    this.name = "HistoryError";
    this.code = code;
    /** Permanente (símbolo inválido, IP bloqueada): repetir não ajuda. */
    this.fatal = fatal;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Duração de uma janela, em segundos (1000 velas). */
export function windowSeconds(granSec) {
  if (!HISTORY_GRAN_TO_INTERVAL[granSec]) throw new RangeError("intervalo inválido");
  return HISTORY_PAGE * granSec;
}

/** Início (s) da janela alinhada que contém `epochSec`. */
export function windowStartOf(epochSec, granSec) {
  const w = windowSeconds(granSec);
  return Math.floor(epochSec / w) * w;
}

/** Época (s) de início da última vela FECHADA no instante `nowMs`. */
export function lastClosedStart(nowMs, granSec) {
  return Math.floor(nowMs / 1000 / granSec) * granSec - granSec;
}

/**
 * Janelas alinhadas (mais recente primeiro) necessárias para cobrir `count` velas fechadas até `nowMs`.
 * Cada janela: { start, end } em segundos; end exclusivo.
 */
export function planWindows(nowMs, granSec, count) {
  if (!Number.isInteger(count) || count < 1) throw new RangeError("count inválido");
  const w = windowSeconds(granSec);
  const newest = lastClosedStart(nowMs, granSec);
  const oldestWanted = newest - (count - 1) * granSec;
  const out = [];
  for (let s = windowStartOf(newest, granSec); s + w > oldestWanted; s -= w) out.push({ start: s, end: s + w });
  return out;
}

function parseRows(list, win, granSec, closedBefore, dropZeroVolume) {
  const out = [];
  let zeroVol = 0;
  let open = 0;
  for (const row of Array.isArray(list) ? list : []) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const startMs = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    if (![startMs, o, h, l, c].every(Number.isFinite)) continue;
    const epoch = Math.floor(startMs / 1000);
    if (epoch < win.start || epoch >= win.end) continue; // fora da janela pedida: ignora
    if (epoch % granSec !== 0) continue;
    if (epoch + granSec > closedBefore) {
      open += 1; // vela ainda a formar-se: nunca entra
      continue;
    }
    const vol = row.length > 5 ? Number(row[5]) : NaN;
    if (dropZeroVolume && !(vol > 0)) {
      zeroVol += 1;
      continue;
    }
    if (!(h >= l) || !(o > 0) || !(c > 0)) continue;
    out.push({ epoch, open: o, high: h, low: l, close: c });
  }
  return { candles: out, zeroVol, open };
}

/**
 * Descarrega e valida UMA janela alinhada. Repete com recuo exponencial (e Retry-After) em erros temporários /
 * limite de pedidos; passa à base alternativa em 403/451; falha de imediato em erros permanentes (símbolo inválido).
 * `limiter` partilha o tempo de pausa entre trabalhadores quando a API pede abrandamento.
 */
export async function fetchWindow(symbol, granSec, win, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const sleep = opts.sleep || defaultSleep;
  const now = opts.now || Date.now;
  const rng = opts.random || Math.random;
  const bases = opts.bases || HISTORY_BASES;
  const retries = opts.retries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 300;
  const maxDelay = opts.maxDelayMs ?? 8000;
  const limiter = opts.limiter || { until: 0 };
  const dropZero = opts.dropZeroVolume !== false;
  const interval = HISTORY_GRAN_TO_INTERVAL[granSec];
  if (!interval) throw new RangeError("intervalo inválido");
  const closedBefore = Math.floor(now() / 1000);
  const path =
    `/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&start=${win.start * 1000}&end=${win.end * 1000 - 1}&limit=${HISTORY_PAGE}`;

  let lastErr = new HistoryError("unknown", "pedido falhou");
  let emptyRetried = false;
  const stats = opts.stats || { requests: 0 };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = limiter.until - now();
    if (wait > 0) await sleep(wait);
    let retryAfterMs = 0;
    let transient = false;
    let blockedAll = true;
    for (const base of bases) {
      let res;
      try {
        stats.requests += 1;
        res = await fetchImpl(`${base}${path}`, { headers: HEADERS });
      } catch (e) {
        lastErr = new HistoryError("network", e && e.message ? String(e.message) : "rede");
        transient = true;
        blockedAll = false;
        continue;
      }
      if (res.status === 403 || res.status === 451) {
        lastErr = new HistoryError("blocked", `${base} HTTP ${res.status}`);
        continue; // tenta a base alternativa
      }
      blockedAll = false;
      if (res.status === 429) {
        const ra = Number(res.headers && res.headers.get ? res.headers.get("retry-after") : NaN);
        retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt;
        lastErr = new HistoryError("rate_limit", `${base} HTTP 429`);
        transient = true;
        break; // o limite é por IP: outra base não ajuda
      }
      if (res.status >= 500) {
        lastErr = new HistoryError("http_" + res.status, `${base} HTTP ${res.status}`);
        transient = true;
        continue;
      }
      let json;
      try {
        json = JSON.parse(await res.text());
      } catch {
        lastErr = new HistoryError("bad_json", `${base} resposta inválida`);
        transient = true;
        continue;
      }
      const code = Number(json && json.retCode);
      if (code !== 0) {
        const msg = (json && json.retMsg) || "bybit_error";
        if (RATE_LIMIT_CODES.has(code)) {
          retryAfterMs = 1000 * 2 ** attempt;
          lastErr = new HistoryError("rate_limit", msg);
          transient = true;
          break;
        }
        if (TRANSIENT_CODES.has(code)) {
          lastErr = new HistoryError("bybit_" + code, msg);
          transient = true;
          continue;
        }
        throw new HistoryError("bybit_" + code, msg, true); // permanente (ex.: símbolo inválido): não repete
      }
      const parsed = parseRows(json.result && json.result.list, win, granSec, closedBefore, dropZero);
      if (parsed.candles.length === 0 && parsed.open === 0 && !emptyRetried) {
        // Janela vazia: confirma uma vez (podia ser falha temporária); depois aceita como vazia.
        emptyRetried = true;
        transient = true;
        lastErr = new HistoryError("empty", "janela vazia");
        break;
      }
      parsed.candles.sort((a, b) => a.epoch - b.epoch);
      const seen = new Set();
      const candles = parsed.candles.filter((c) => (seen.has(c.epoch) ? false : (seen.add(c.epoch), true)));
      return { win, candles, zeroVolume: parsed.zeroVol, openDropped: parsed.open };
    }
    if (blockedAll) {
      lastErr.fatal = true; // todas as bases bloqueadas (403/451): repetir não ajuda
      throw lastErr;
    }
    if (!transient || attempt === retries) break;
    const backoff = Math.min(maxDelay, baseDelay * 2 ** attempt) * (0.75 + 0.5 * rng());
    const delay = Math.max(retryAfterMs, backoff);
    if (retryAfterMs > 0) limiter.until = Math.max(limiter.until, now() + delay);
    await sleep(delay);
  }
  if (lastErr.code === "empty") {
    return { win, candles: [], zeroVolume: 0, openDropped: 0 };
  }
  throw lastErr;
}

/**
 * Histórico profundo: até `count` velas fechadas (mais antigas → mais recentes).
 * Devolve { candles, complete, failedWindows, windows, requests, ... }. Se alguma janela falhar, `candles` traz só a cauda
 * CONTÍGUA mais recente (depois da janela falhada mais recente): nunca se cola história com buracos.
 */
export async function fetchDeepHistory(symbol, granSec, opts = {}) {
  const now = opts.now || Date.now;
  const nowMs = now();
  const count = opts.count ?? Math.ceil(((opts.days ?? 90) * 86400) / granSec);
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 5));
  const windows = planWindows(nowMs, granSec, count);
  const limiter = { until: 0 };
  const results = new Array(windows.length).fill(null);
  const failed = [];
  let next = 0;
  let exhaustedFrom = Infinity; // índice a partir do qual já se sabe que não há mais história
  const stats = { requests: 0 };
  let fatal = null;

  async function worker() {
    for (;;) {
      const idx = next++;
      if (fatal || idx >= windows.length || idx >= exhaustedFrom) return;
      try {
        const r = await fetchWindow(symbol, granSec, windows[idx], { ...opts, limiter, now, stats });
        results[idx] = r;
        if (r.candles.length === 0 && r.openDropped === 0 && r.zeroVolume === 0) {
          exhaustedFrom = Math.min(exhaustedFrom, idx); // antes disto o símbolo não existia
        }
      } catch (e) {
        if (e instanceof HistoryError && e.fatal) {
          fatal = fatal || e; // erro permanente (símbolo inválido / bloqueio): aborta tudo
          return;
        }
        failed.push({ start: windows[idx].start, end: windows[idx].end, code: e && e.code ? e.code : "error", message: e && e.message ? String(e.message) : "" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));
  if (fatal) throw fatal;

  // Janelas efectivamente descarregadas, da mais antiga para a mais recente.
  failed.sort((a, b) => b.start - a.start); // mais recente primeiro
  const newestFailedStart = failed.length ? failed[0].start : -Infinity;
  const merged = new Map();
  let zeroVolume = 0;
  let openDropped = 0;
  for (const r of results) {
    if (!r) continue;
    zeroVolume += r.zeroVolume;
    openDropped += r.openDropped;
    if (r.win.start < newestFailedStart) continue; // antes de um buraco: descartado
    for (const c of r.candles) merged.set(c.epoch, c);
  }
  const all = [...merged.values()].sort((a, b) => a.epoch - b.epoch);
  const candles = all.length > count ? all.slice(all.length - count) : all;
  return {
    candles,
    complete: failed.length === 0,
    failedWindows: failed,
    windows: windows.length,
    requested: count,
    requests: stats.requests,
    zeroVolumeDropped: zeroVolume,
    openDropped,
    oldestEpoch: candles.length ? candles[0].epoch : null,
    newestEpoch: candles.length ? candles[candles.length - 1].epoch : null,
    fetchedAt: nowMs,
  };
}
