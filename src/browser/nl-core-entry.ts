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

export { parseActiveSymbols, parseCandlesMessage, summarizeMarkets } from "../core/market-data.ts";
export type { SymbolInfo, Candle, SymbolsMessage, CandlesMessage } from "../core/market-data.ts";

export {
  BINANCE_PUBLIC_BASES,
  BINANCE_FUTURES_PUBLIC_BASES,
  BINANCE_FUTURES_PATH_EXCHANGE_INFO,
  BINANCE_FUTURES_PATH_KLINES,
  BINANCE_PREFERRED_USDT,
  granularityToBinanceInterval,
  binanceIntervalToSeconds,
  isBinanceUsdtSymbol,
  binanceBaseAsset,
  isUsdtmPerpetual,
  parseBinanceExchangeInfo,
  parseBinanceFuturesExchangeInfo,
  parseBinanceKlines,
  parseBinanceFuturesKlines,
  sortBinanceUsdtPreferred,
  binanceFetch,
  fetchBinanceUsdtSymbols,
  fetchBinanceKlinesPage,
  fetchBinanceCandleHistory,
} from "../core/binance.ts";
export type { BinanceInterval, BinanceSymbolsMessage, BinanceKlinesMessage } from "../core/binance.ts";

export {
  BYBIT_PUBLIC_BASES,
  BYBIT_PATH_INSTRUMENTS,
  BYBIT_PATH_KLINE,
  BYBIT_PREFERRED_USDT,
  granularityToBybitInterval,
  bybitIntervalToSeconds,
  toBybitInterval,
  isBybitUsdtSymbol,
  bybitBaseAsset,
  isLinearUsdtPerpetual,
  parseBybitInstrumentsPage,
  mergeBybitInstrumentPages,
  parseBybitKlines,
  sortBybitUsdtPreferred,
  bybitFetch,
  fetchBybitUsdtSymbols,
  fetchBybitKlinesPage,
  fetchBybitCandleHistory,
  parseBybitLeverageInfo,
  clampBybitLeverage,
} from "../core/bybit.ts";
export type { BybitInterval, BybitSymbolsMessage, BybitKlinesMessage, BybitLeverageInfo } from "../core/bybit.ts";



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

export {
  evaluateLiveEntry,
  proximityForStrategyName,
  combineGateAndLive,
  combineReadiness,
  gateProgressPct,
  requiredOosForMinLabel,
  LIVE_ENTRY_MAX_CANDLES,
} from "../core/strategy-live.ts";
export type {
  LiveEntryMetrics,
  GateProgressInput,
  CombineReadinessInput,
  ReadinessScore,
  MinEvidenceLabel,
} from "../core/strategy-live.ts";

export {
  WINDOW_SIZES,
  MAX_WINDOW,
  EXPECTED_PCT,
  lastDigit,
  countDigits,
  percentages,
  deviationFromExpected,
  deviationColor,
  TickWindow,
} from "../core/digits.ts";
export type { DigitColor, WindowStats } from "../core/digits.ts";

export { parseMessage as parseTickMessage } from "../core/ticks.ts";
export type { ParsedMessage as ParsedTickMessage } from "../core/ticks.ts";
