// Pesquisa em velas só com operações EXECUTÁVEIS nos multiplicadores da Deriv, separada por mercado.

import { runCandleResearch } from "./candle-research.ts";
import type { CandleResearchOptions } from "./candle-research.ts";
import { feasible, signalShare } from "./feasible.ts";
import type { SignalShare } from "./feasible.ts";
import { strategyLibrary } from "./strategies.ts";
import { MARKETS, MARKET_ORDER, marketOf } from "./markets.ts";
import type { MarketKind } from "./markets.ts";
import type { MarketGroupReport, MarketResearchOptions } from "./market-research.ts";
import type { Candle } from "./market-data.ts";

export interface ExecutableOptions extends MarketResearchOptions {
  /** Menor multiplicador permitido pela Deriv (ex.: 100). */
  minMultiplier: number;
}

export interface ExecutableResult {
  groups: MarketGroupReport[];
  /** Sinais executáveis por símbolo. */
  shares: Record<string, SignalShare>;
  maxStopFraction: number;
}

export function runExecutableResearch(
  data: Readonly<Record<string, readonly Candle[]>>,
  opts: ExecutableOptions,
): ExecutableResult {
  if (!(opts.minMultiplier > 0)) throw new RangeError(`minMultiplier inválido: ${opts.minMultiplier}`);
  const maxStopFraction = 1 / opts.minMultiplier;
  const feas = { slAtr: opts.slAtr, maxStopFraction };
  const strategies = strategyLibrary().map((s) => feasible(s, feas));

  const byMarket = new Map<MarketKind, Record<string, readonly Candle[]>>();
  for (const symbol of Object.keys(data)) {
    const kind = marketOf(symbol);
    if (kind === null) throw new RangeError(`Símbolo desconhecido: ${symbol}`);
    const g = byMarket.get(kind) ?? {};
    g[symbol] = data[symbol]!;
    byMarket.set(kind, g);
  }
  if (byMarket.size === 0) throw new RangeError("Sem dados");

  const shares: Record<string, SignalShare> = {};
  const groups: MarketGroupReport[] = [];
  for (const kind of MARKET_ORDER) {
    const subset = byMarket.get(kind);
    if (!subset) continue;
    const cost = opts.costOverride ?? MARKETS[kind].assumedCostFraction;
    const { costOverride: _c, minMultiplier: _m, ...rest } = opts;
    void _c;
    void _m;
    const options: CandleResearchOptions = { ...rest, costFor: () => cost };
    for (const [symbol, candles] of Object.entries(subset)) {
      shares[symbol] = signalShare(strategyLibrary(), candles, feas);
    }
    groups.push({ kind, label: MARKETS[kind].label, reports: runCandleResearch(subset, options, strategies), options });
  }
  return { groups, shares, maxStopFraction };
}

export function formatShares(result: ExecutableResult): string {
  const lines = [
    `=== VIABILIDADE (stop máximo executável ${(result.maxStopFraction * 100).toFixed(2)}% do preço) ===`,
  ];
  for (const [symbol, s] of Object.entries(result.shares)) {
    const pct = s.total === 0 ? 0 : (100 * s.kept) / s.total;
    lines.push(`${symbol}: ${s.kept} de ${s.total} sinais executáveis (${pct.toFixed(0)}%)`);
  }
  return lines.join("\n");
}
