// Entrada browser (esbuild → public/assets/nl-core.js). Paper trading + porta de evidência.
export { MARKETS, MARKET_ORDER, marketOf, marketStatus, isScheduledOpen } from "../core/markets.ts";
export type { MarketKind, MarketProfile, MarketStatus } from "../core/markets.ts";

export {
  isCryptoUsd,
  filterCryptoUsd,
  listAllCryptoUsd,
  mergeCryptoUsdListings,
  KNOWN_OPTIONS_CRYPTO_FEED,
  cryptoSourceOf,
  isOptionsFeedOnly,
  cryptoBaseLabel,
} from "../core/crypto-symbols.ts";
export type { CryptoSource } from "../core/crypto-symbols.ts";

export { MT5_CRYPTO_STATUS, formatMt5StatusBlock } from "../core/mt5-status.ts";
export type { Mt5StatusInfo, Mt5IntegrationStatus } from "../core/mt5-status.ts";

export { parseActiveSymbols, parseCandlesMessage, summarizeMarkets } from "../core/market-data.ts";
export type { SymbolInfo, Candle, SymbolsMessage, CandlesMessage } from "../core/market-data.ts";

export {
  BINANCE_PUBLIC_BASES,
  BINANCE_PREFERRED_USDT,
  granularityToBinanceInterval,
  binanceIntervalToSeconds,
  isBinanceUsdtSymbol,
  binanceBaseAsset,
  parseBinanceExchangeInfo,
  parseBinanceKlines,
  sortBinanceUsdtPreferred,
  binanceFetch,
  fetchBinanceUsdtSymbols,
  fetchBinanceKlinesPage,
  fetchBinanceCandleHistory,
} from "../core/binance.ts";
export type { BinanceInterval, BinanceSymbolsMessage, BinanceKlinesMessage } from "../core/binance.ts";

export { mergeCandlePages, nextCandleEnd } from "../core/candle-pages.ts";

export {
  strategyLibrary,
  dailyTrendAtrBreakout,
  dailyTrendStrategySet,
  lucroRapidoStrategySet,
  lossZeroStrategySet,
  STRATEGY_PRESETS,
  strategyPreset,
  strategiesForPreset,
} from "../core/strategies.ts";
export type {
  Strategy,
  Signal,
  StrategyPreset,
  StrategyPresetId,
  StrategyPresetGateHints,
} from "../core/strategies.ts";

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
