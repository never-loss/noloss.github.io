// NEVER LOSS - símbolos cripto em USD na Deriv (cry*USD).
import type { SymbolInfo } from "./market-data.ts";

/** Par cripto cotado em USD (ex.: cryBTCUSD, cryETHUSD). */
export function isCryptoUsd(symbol: string): boolean {
  return /^cry[A-Z0-9]+USD$/.test(symbol);
}

/**
 * Filtra cry*USD a partir de active_symbols.
 * Prefere abertos e não suspensos; se nenhum estiver aberto, devolve todos os cry*USD.
 */
export function filterCryptoUsd(items: readonly SymbolInfo[]): SymbolInfo[] {
  const all = items.filter((it) => isCryptoUsd(it.symbol));
  const open = all.filter((it) => it.open && !it.suspended);
  const chosen = open.length > 0 ? open : all;
  return [...chosen].sort((a, b) => a.symbol.localeCompare(b.symbol));
}
