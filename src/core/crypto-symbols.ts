// NEVER LOSS - símbolos cripto em USD na Deriv (cry*USD).
import type { SymbolInfo } from "./market-data.ts";

/** Par cripto cotado em USD (ex.: cryBTCUSD, cryETHUSD). */
export function isCryptoUsd(symbol: string): boolean {
  return /^cry[A-Z0-9]+USD$/.test(symbol);
}

/** Todos os cry*USD de active_symbols, ordenados (painel dinâmico). */
export function listAllCryptoUsd(items: readonly SymbolInfo[]): SymbolInfo[] {
  return items
    .filter((it) => isCryptoUsd(it.symbol))
    .slice()
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * Filtra cry*USD a partir de active_symbols.
 * Prefere abertos e não suspensos; se nenhum estiver aberto, devolve todos os cry*USD.
 * Para o painel UI usar listAllCryptoUsd (mostra todos com estado).
 */
export function filterCryptoUsd(items: readonly SymbolInfo[]): SymbolInfo[] {
  const all = listAllCryptoUsd(items);
  const open = all.filter((it) => it.open && !it.suspended);
  return open.length > 0 ? open : all;
}
