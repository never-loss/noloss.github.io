// NEVER LOSS - cripto USD na Deriv Options (cry*USD).
// active_symbols Options só lista cryBTCUSD + cryETHUSD; o feed de velas público
// ainda serve outros cry*USD (paper/pesquisa). MT5/CFD é outro produto — ver mt5-status.ts.
import type { SymbolInfo } from "./market-data.ts";

/** Origem do símbolo no painel cripto. */
export type CryptoSource = "options_active" | "options_feed";

/**
 * Pares cry*USD com histórico de velas no WS público Options (verificado 2026-09-26).
 * Não são CFD/MT5 (esses usam códigos tipo BTCUSD/AAVUSD e não respondem neste WS).
 * active_symbols pode listar só um subconjunto (hoje tipicamente BTC+ETH).
 */
export const KNOWN_OPTIONS_CRYPTO_FEED: readonly string[] = [
  "cryBTCUSD",
  "cryETHUSD",
  "cryLTCUSD",
  "cryXRPUSD",
  "cryBCHUSD",
  "cryADAUSD",
  "crySOLUSD",
  "cryBNBUSD",
  "cryXLMUSD",
  "cryTRXUSD",
  "cryNEOUSD",
  "cryZECUSD",
  "cryUSDCUSD",
  "cryXMRUSD",
  "cryIOTUSD",
  "cryDSHUSD",
] as const;

/** Par cripto cotado em USD (ex.: cryBTCUSD, cryETHUSD). */
export function isCryptoUsd(symbol: string): boolean {
  return /^cry[A-Z0-9]+USD$/.test(symbol);
}

/** Nome curto para UI (BTC a partir de cryBTCUSD). */
export function cryptoBaseLabel(symbol: string): string {
  const m = /^cry([A-Z0-9]+)USD$/.exec(symbol);
  return m ? m[1]! : symbol;
}

function feedStub(symbol: string): SymbolInfo {
  const base = cryptoBaseLabel(symbol);
  return {
    symbol,
    displayName: `${base}/USD (feed Options)`,
    market: "cryptocurrency",
    submarket: "crypto_usd_feed",
    open: true,
    suspended: false,
  };
}

/**
 * Junta cry*USD de active_symbols com o catálogo de feed conhecido.
 * Entradas de active_symbols ganham prioridade (estado open/suspended real).
 */
export function mergeCryptoUsdListings(activeItems: readonly SymbolInfo[]): SymbolInfo[] {
  const bySym = new Map<string, SymbolInfo>();
  for (const it of activeItems) {
    if (isCryptoUsd(it.symbol)) bySym.set(it.symbol, it);
  }
  for (const sym of KNOWN_OPTIONS_CRYPTO_FEED) {
    if (!bySym.has(sym)) bySym.set(sym, feedStub(sym));
  }
  return [...bySym.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Todos os cry*USD (active + feed conhecido), ordenados — painel dinâmico. */
export function listAllCryptoUsd(items: readonly SymbolInfo[]): SymbolInfo[] {
  return mergeCryptoUsdListings(items);
}

/**
 * Filtra cry*USD para pesquisa/paper.
 * Prefere abertos e não suspensos; se nenhum estiver aberto, devolve a lista completa.
 */
export function filterCryptoUsd(items: readonly SymbolInfo[]): SymbolInfo[] {
  const all = listAllCryptoUsd(items);
  const open = all.filter((it) => it.open && !it.suspended);
  return open.length > 0 ? open : all;
}

/** true se o símbolo veio só do catálogo de feed (não estava em active_symbols). */
export function isOptionsFeedOnly(symbol: string, activeItems: readonly SymbolInfo[]): boolean {
  if (!isCryptoUsd(symbol)) return false;
  return !activeItems.some((it) => it.symbol === symbol);
}

export function cryptoSourceOf(symbol: string, activeItems: readonly SymbolInfo[]): CryptoSource | null {
  if (!isCryptoUsd(symbol)) return null;
  return isOptionsFeedOnly(symbol, activeItems) ? "options_feed" : "options_active";
}
