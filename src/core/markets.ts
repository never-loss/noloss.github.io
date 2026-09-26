// NEVER LOSS - mercados separados: FOREX, METAIS (ouro...) e CRIPTO. Cada um tem o seu perfil.
// Os custos são SUPOSIÇÕES até medirmos os reais na Deriv.

export type MarketKind = "forex" | "metals" | "crypto";

export interface MarketProfile {
  kind: MarketKind;
  label: string;
  /** Cripto opera sem parar; forex e metais fecham ao fim de semana. */
  alwaysOpen: boolean;
  /** Custo de ida e volta assumido, como fração do preço. */
  assumedCostFraction: number;
}

export const MARKETS: Readonly<Record<MarketKind, MarketProfile>> = {
  forex: { kind: "forex", label: "FOREX (pares de moedas)", alwaysOpen: false, assumedCostFraction: 0.0001 },
  metals: { kind: "metals", label: "METAIS (ouro, prata...)", alwaysOpen: false, assumedCostFraction: 0.0002 },
  crypto: { kind: "crypto", label: "CRIPTO", alwaysOpen: true, assumedCostFraction: 0.001 },
};

export const MARKET_ORDER: readonly MarketKind[] = ["forex", "metals", "crypto"];

/** A que mercado pertence um símbolo da Deriv (null = outro, por exemplo índices sintéticos). */
export function marketOf(symbol: string): MarketKind | null {
  if (/^cry[A-Z0-9]+USD$/.test(symbol)) return "crypto";
  // Binance USDⓈ-M Futures perpetual (ex.: BTCUSDT) — dados públicos fapi; paper por omissão.
  if (/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return "crypto";
  if (/^frx(XAU|XAG|XPD|XPT)[A-Z]{3}$/.test(symbol)) return "metals";
  if (/^frx[A-Z]{6}$/.test(symbol)) return "forex";
  return null;
}

/**
 * Horário aproximado (UTC) de forex e metais: fecha na sexta às 21:00 e reabre no domingo às 22:00.
 * É uma aproximação (muda com a hora de verão); a verificação fiável usa a frescura das velas.
 */
export function isScheduledOpen(kind: MarketKind, now: Date): boolean {
  if (MARKETS[kind].alwaysOpen) return true;
  const day = now.getUTCDay(); // 0 = domingo ... 6 = sábado
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (day === 6) return false;
  if (day === 5 && minutes >= 21 * 60) return false;
  if (day === 0 && minutes < 22 * 60) return false;
  return true;
}

export type MarketStatus = "open" | "closed" | "unknown";

/**
 * Estado real de um símbolo: se a última vela é recente, está aberto. Se é antiga e o horário
 * diz que devia estar fechado, está fechado. Se é antiga e devia estar aberto, não sabemos (pausa ou falha).
 */
export function marketStatus(
  kind: MarketKind,
  lastCandleEpoch: number,
  nowMs: number,
  granularity: number,
): MarketStatus {
  if (!Number.isFinite(lastCandleEpoch) || !Number.isFinite(nowMs) || !(granularity > 0)) {
    throw new RangeError("Argumentos inválidos");
  }
  const ageSeconds = nowMs / 1000 - lastCandleEpoch;
  if (ageSeconds <= 2 * granularity + 60) return "open";
  return isScheduledOpen(kind, new Date(nowMs)) ? "unknown" : "closed";
}
