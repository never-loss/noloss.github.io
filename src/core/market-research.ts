// Pesquisa em velas separada por mercado (forex, metais, cripto), cada um com o seu perfil de custos.
// A correção para múltiplos testes é feita dentro de cada mercado (cada PLAY decide só sobre o seu).

import { runCandleResearch, formatCandleReport } from "./candle-research.ts";
import type { CandleResearchOptions, SymbolReport } from "./candle-research.ts";
import { MARKETS, MARKET_ORDER, marketOf } from "./markets.ts";
import type { MarketKind } from "./markets.ts";
import type { Candle } from "./market-data.ts";

export type MarketResearchOptions = Omit<CandleResearchOptions, "costFor"> & {
  /** Se definido, substitui o custo assumido de todos os mercados. */
  costOverride?: number;
};

export interface MarketGroupReport {
  kind: MarketKind;
  label: string;
  reports: SymbolReport[];
  options: CandleResearchOptions;
}

export function runMarketResearch(
  data: Readonly<Record<string, readonly Candle[]>>,
  opts: MarketResearchOptions,
): MarketGroupReport[] {
  const groups = new Map<MarketKind, Record<string, readonly Candle[]>>();
  for (const symbol of Object.keys(data)) {
    const kind = marketOf(symbol);
    if (kind === null) throw new RangeError(`Símbolo desconhecido: ${symbol}`);
    const g = groups.get(kind) ?? {};
    g[symbol] = data[symbol]!;
    groups.set(kind, g);
  }
  if (groups.size === 0) throw new RangeError("Sem dados");

  const out: MarketGroupReport[] = [];
  for (const kind of MARKET_ORDER) {
    const subset = groups.get(kind);
    if (!subset) continue;
    const cost = opts.costOverride ?? MARKETS[kind].assumedCostFraction;
    const { costOverride: _ignored, ...rest } = opts;
    void _ignored;
    const options: CandleResearchOptions = { ...rest, costFor: () => cost };
    out.push({ kind, label: MARKETS[kind].label, reports: runCandleResearch(subset, options), options });
  }
  return out;
}

export function formatMarketReport(groups: readonly MarketGroupReport[]): string {
  const out: string[] = [];
  for (const g of groups) {
    out.push("");
    out.push(`########## ${g.label} ##########`);
    out.push(formatCandleReport(g.reports, g.options));
  }
  return out.join("\n");
}
