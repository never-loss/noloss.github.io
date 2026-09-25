// Entrada browser (esbuild → public/assets/nl-core.js). Paper trading + porta de evidência.
export { MARKETS, MARKET_ORDER, marketOf, marketStatus, isScheduledOpen } from "../core/markets.ts";
export type { MarketKind, MarketProfile, MarketStatus } from "../core/markets.ts";

export { isCryptoUsd, filterCryptoUsd, listAllCryptoUsd } from "../core/crypto-symbols.ts";

export { parseActiveSymbols, parseCandlesMessage, summarizeMarkets } from "../core/market-data.ts";
export type { SymbolInfo, Candle, SymbolsMessage, CandlesMessage } from "../core/market-data.ts";

export { mergeCandlePages, nextCandleEnd } from "../core/candle-pages.ts";

export {
  strategyLibrary,
  dailyTrendAtrBreakout,
  dailyTrendStrategySet,
} from "../core/strategies.ts";
export type { Strategy, Signal } from "../core/strategies.ts";

export { feasible, maxStopFromMultiplier } from "../core/feasible.ts";

export {
  evaluateCandleGate,
  formatCandleGate,
  CandleGateController,
} from "../core/candle-gate.ts";
export type { CandleGateResult, CandleGateOptions } from "../core/candle-gate.ts";

export {
  CandlePaperSession,
  formatCandleEvent,
  formatCandleSummary,
} from "../core/candle-paper.ts";
export type { CandlePaperConfig, CandlePaperEvent, CandlePaperSummary } from "../core/candle-paper.ts";

export { MIN_STAKE, MAX_SESSION_MS } from "../core/paper.ts";
export type { SessionStatus, StopReason } from "../core/paper.ts";
