// Dados de mercado da Deriv (sem login): lista de símbolos e velas.
// Nada é descartado em silêncio: entradas estranhas são contadas em `skipped`.

export interface SymbolInfo {
  symbol: string;
  displayName: string;
  market: string;
  submarket: string;
  open: boolean;
  suspended: boolean;
}

export type SymbolsMessage =
  | { kind: "symbols"; items: SymbolInfo[]; skipped: number }
  | { kind: "error"; code: string; message: string }
  | { kind: "invalid"; reason: string }
  | { kind: "other" };

function flag(v: unknown): boolean {
  return v === 1 || v === true || v === "1";
}

function parseObject(raw: string): Record<string, unknown> | string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "JSON inválido";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return "Mensagem não é um objeto";
  return data as Record<string, unknown>;
}

function errorOf(obj: Record<string, unknown>): { kind: "error"; code: string; message: string } | null {
  if (obj.error && typeof obj.error === "object") {
    const e = obj.error as Record<string, unknown>;
    return { kind: "error", code: String(e.code ?? "unknown"), message: String(e.message ?? "") };
  }
  return null;
}

export function parseActiveSymbols(raw: string): SymbolsMessage {
  const obj = parseObject(raw);
  if (typeof obj === "string") return { kind: "invalid", reason: obj };
  const err = errorOf(obj);
  if (err) return err;
  if (obj.msg_type !== "active_symbols") return { kind: "other" };
  if (!Array.isArray(obj.active_symbols)) return { kind: "invalid", reason: "active_symbols em falta" };

  const items: SymbolInfo[] = [];
  let skipped = 0;
  for (const entry of obj.active_symbols) {
    if (typeof entry !== "object" || entry === null) {
      skipped += 1;
      continue;
    }
    const e = entry as Record<string, unknown>;
    // Options WS moderno: underlying_symbol (+ nome); legado Binary: symbol (+ display_name).
    const symbol =
      typeof e.underlying_symbol === "string"
        ? e.underlying_symbol
        : typeof e.symbol === "string"
          ? e.symbol
          : null;
    if (symbol === null || typeof e.market !== "string") {
      skipped += 1;
      continue;
    }
    const displayName =
      typeof e.underlying_symbol_name === "string"
        ? e.underlying_symbol_name
        : typeof e.display_name === "string"
          ? e.display_name
          : symbol;
    items.push({
      symbol,
      displayName,
      market: e.market,
      submarket: typeof e.submarket === "string" ? e.submarket : "",
      open: flag(e.exchange_is_open),
      suspended: flag(e.is_trading_suspended),
    });
  }
  return { kind: "symbols", items, skipped };
}

export interface MarketSummary {
  market: string;
  total: number;
  open: number;
}

/** Quantos símbolos há por mercado e quantos estão abertos e ativos agora. */
export function summarizeMarkets(items: readonly SymbolInfo[]): MarketSummary[] {
  const map = new Map<string, MarketSummary>();
  for (const it of items) {
    const s = map.get(it.market) ?? { market: it.market, total: 0, open: 0 };
    s.total += 1;
    if (it.open && !it.suspended) s.open += 1;
    map.set(it.market, s);
  }
  return [...map.values()].sort((a, b) => a.market.localeCompare(b.market));
}

// ---------- Velas ----------

export interface Candle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type CandlesMessage =
  | { kind: "candles"; candles: Candle[]; pipSize: number | null }
  | { kind: "error"; code: string; message: string }
  | { kind: "invalid"; reason: string }
  | { kind: "other" };

function num(v: unknown): number | null {
  const x = typeof v === "string" ? Number(v) : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function parseCandlesMessage(raw: string): CandlesMessage {
  const obj = parseObject(raw);
  if (typeof obj === "string") return { kind: "invalid", reason: obj };
  const err = errorOf(obj);
  if (err) return err;
  if (obj.msg_type !== "candles") return { kind: "other" };
  if (!Array.isArray(obj.candles)) return { kind: "invalid", reason: "candles em falta" };

  const candles: Candle[] = [];
  for (const c of obj.candles) {
    if (typeof c !== "object" || c === null) return { kind: "invalid", reason: "vela inválida" };
    const r = c as Record<string, unknown>;
    const epoch = num(r.epoch);
    const open = num(r.open);
    const high = num(r.high);
    const low = num(r.low);
    const close = num(r.close);
    if (epoch === null || open === null || high === null || low === null || close === null) {
      return { kind: "invalid", reason: "vela com campos em falta ou inválidos" };
    }
    if (!Number.isInteger(epoch) || high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      return { kind: "invalid", reason: "vela incoerente (máximo/mínimo)" };
    }
    candles.push({ epoch, open, high, low, close });
  }
  const pip = num(obj.pip_size);
  return { kind: "candles", candles, pipSize: pip !== null && Number.isInteger(pip) ? pip : null };
}
