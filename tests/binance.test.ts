import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBinanceUsdtSymbol,
  binanceBaseAsset,
  granularityToBinanceInterval,
  binanceIntervalToSeconds,
  parseBinanceExchangeInfo,
  parseBinanceKlines,
  sortBinanceUsdtPreferred,
  fetchBinanceCandleHistory,
  BINANCE_PREFERRED_USDT,
} from "../src/core/binance.ts";
import { marketOf } from "../src/core/markets.ts";

const SAMPLE_EXCHANGE_INFO = JSON.stringify({
  timezone: "UTC",
  serverTime: 1_790_399_400_000,
  symbols: [
    {
      symbol: "BTCUSDT",
      status: "TRADING",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      isSpotTradingAllowed: true,
      permissions: ["SPOT"],
    },
    {
      symbol: "ETHUSDT",
      status: "TRADING",
      baseAsset: "ETH",
      quoteAsset: "USDT",
      isSpotTradingAllowed: true,
      permissions: ["SPOT"],
    },
    {
      symbol: "BTCUSD",
      status: "TRADING",
      baseAsset: "BTC",
      quoteAsset: "USD",
      isSpotTradingAllowed: true,
      permissions: ["SPOT"],
    },
    {
      symbol: "ADAUSDT",
      status: "BREAK",
      baseAsset: "ADA",
      quoteAsset: "USDT",
      isSpotTradingAllowed: true,
      permissions: ["SPOT"],
    },
    {
      symbol: "XYZUSDT",
      status: "TRADING",
      baseAsset: "XYZ",
      quoteAsset: "USDT",
      isSpotTradingAllowed: false,
      permissions: ["SPOT"],
    },
    {
      symbol: "SOLUSDT",
      status: "TRADING",
      baseAsset: "SOL",
      quoteAsset: "USDT",
      isSpotTradingAllowed: true,
      permissions: ["SPOT", "MARGIN"],
    },
  ],
});

const SAMPLE_KLINES = JSON.stringify([
  [
    1_790_398_800_000,
    "83976.01000000",
    "83993.05000000",
    "83976.01000000",
    "83993.04000000",
    "11.31824000",
    1_790_399_099_999,
    "950610.45592180",
    1726,
    "6.20306000",
    "520982.39492740",
    "0",
  ],
  [
    1_790_399_100_000,
    "83993.04000000",
    "83993.05000000",
    "83993.04000000",
    "83993.04000000",
    "3.90813000",
    1_790_399_399_999,
    "328255.73088800",
    605,
    "1.14728000",
    "96363.54640400",
    "0",
  ],
]);

test("isBinanceUsdtSymbol e base asset", () => {
  assert.equal(isBinanceUsdtSymbol("BTCUSDT"), true);
  assert.equal(isBinanceUsdtSymbol("ETHUSDT"), true);
  assert.equal(isBinanceUsdtSymbol("SOLUSDT"), true);
  assert.equal(isBinanceUsdtSymbol("cryBTCUSD"), false);
  assert.equal(isBinanceUsdtSymbol("btcusdt"), false);
  assert.equal(isBinanceUsdtSymbol("BTCUSD"), false);
  assert.equal(isBinanceUsdtSymbol(""), false);
  assert.equal(binanceBaseAsset("BTCUSDT"), "BTC");
  assert.equal(binanceBaseAsset("1000PEPEUSDT"), "1000PEPE");
});

test("marketOf trata Binance USDT como crypto", () => {
  assert.equal(marketOf("BTCUSDT"), "crypto");
  assert.equal(marketOf("ETHUSDT"), "crypto");
  assert.equal(marketOf("cryBTCUSD"), "crypto");
});

test("granularity ↔ interval Binance", () => {
  assert.equal(granularityToBinanceInterval(60), "1m");
  assert.equal(granularityToBinanceInterval(300), "5m");
  assert.equal(granularityToBinanceInterval(900), "15m");
  assert.equal(granularityToBinanceInterval(3600), "1h");
  assert.equal(granularityToBinanceInterval(120), null);
  assert.equal(granularityToBinanceInterval(0), null);
  assert.equal(binanceIntervalToSeconds("5m"), 300);
  assert.equal(binanceIntervalToSeconds("1h"), 3600);
  assert.equal(binanceIntervalToSeconds("weird"), null);
});

test("parseBinanceExchangeInfo: só USDT Spot TRADING", () => {
  const msg = parseBinanceExchangeInfo(SAMPLE_EXCHANGE_INFO);
  assert.equal(msg.kind, "symbols");
  if (msg.kind !== "symbols") return;
  const syms = msg.items.map((i) => i.symbol);
  assert.deepEqual(syms.sort(), ["BTCUSDT", "ETHUSDT", "SOLUSDT"].sort());
  assert.ok(msg.skipped >= 3);
  const btc = msg.items.find((i) => i.symbol === "BTCUSDT")!;
  assert.ok(btc.displayName.includes("BTC/USDT"));
  assert.equal(btc.submarket, "binance_usdt");
  assert.equal(btc.open, true);
});

test("parseBinanceExchangeInfo: erros e inválidos", () => {
  assert.equal(parseBinanceExchangeInfo("not-json").kind, "invalid");
  const err = parseBinanceExchangeInfo(JSON.stringify({ code: -1121, msg: "Invalid symbol." }));
  assert.equal(err.kind, "error");
  if (err.kind === "error") {
    assert.equal(err.code, "-1121");
    assert.ok(err.message.includes("Invalid"));
  }
  assert.equal(parseBinanceExchangeInfo(JSON.stringify({ timezone: "UTC" })).kind, "invalid");
});

test("parseBinanceKlines: OHLC e epoch em segundos", () => {
  const msg = parseBinanceKlines(SAMPLE_KLINES);
  assert.equal(msg.kind, "candles");
  if (msg.kind !== "candles") return;
  assert.equal(msg.candles.length, 2);
  const c0 = msg.candles[0]!;
  assert.equal(c0.epoch, 1_790_398_800);
  assert.equal(c0.open, 83976.01);
  assert.equal(c0.high, 83993.05);
  assert.equal(c0.low, 83976.01);
  assert.equal(c0.close, 83993.04);
  const c1 = msg.candles[1]!;
  assert.equal(c1.epoch, 1_790_399_100);
  assert.equal(c1.close, 83993.04);
});

test("parseBinanceKlines: rejeita vela incoerente e erros API", () => {
  const bad = JSON.stringify([
    [1_000_000, "10", "9", "11", "10", "1", 1_060_000, "1", 1, "1", "1", "0"], // high < low
  ]);
  assert.equal(parseBinanceKlines(bad).kind, "invalid");
  const err = parseBinanceKlines(JSON.stringify({ code: 0, msg: "Service unavailable" }));
  assert.equal(err.kind, "error");
  const empty = parseBinanceKlines("[]");
  assert.equal(empty.kind, "candles");
  if (empty.kind === "candles") assert.equal(empty.candles.length, 0);
  assert.equal(parseBinanceKlines("{").kind, "invalid");
});

test("sortBinanceUsdtPreferred põe BTC/ETH à frente", () => {
  const items = [
    { symbol: "ZZZUSDT", displayName: "Z", market: "cryptocurrency", submarket: "binance_usdt", open: true, suspended: false },
    { symbol: "ETHUSDT", displayName: "E", market: "cryptocurrency", submarket: "binance_usdt", open: true, suspended: false },
    { symbol: "BTCUSDT", displayName: "B", market: "cryptocurrency", submarket: "binance_usdt", open: true, suspended: false },
  ];
  const sorted = sortBinanceUsdtPreferred(items).map((i) => i.symbol);
  assert.deepEqual(sorted, ["BTCUSDT", "ETHUSDT", "ZZZUSDT"]);
  assert.ok(BINANCE_PREFERRED_USDT.includes("BTCUSDT"));
});

test("fetchBinanceCandleHistory pagina e fecha a vela em formação", async () => {
  // 5 velas de 5m; "agora" a meio da última → só 4 fechadas.
  const rows = Array.from({ length: 5 }, (_, i) => {
    const openMs = 1_700_000_000_000 + i * 300_000;
    const px = String(100 + i);
    return [openMs, px, px, px, px, "1", openMs + 299_999, "1", 1, "1", "1", "0"];
  });
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    assert.ok(u.includes("/api/v3/klines"));
    assert.ok(u.includes("symbol=BTCUSDT"));
    assert.ok(u.includes("interval=5m"));
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  // Agora = open da última + 150s → última ainda aberta
  const nowMs = 1_700_000_000_000 + 4 * 300_000 + 150_000;
  const candles = await fetchBinanceCandleHistory("BTCUSDT", 300, 10, fetchImpl, nowMs);
  assert.equal(candles.length, 4);
  assert.equal(candles[0]!.epoch, 1_700_000_000);
  assert.equal(candles[3]!.close, 103);
});

test("fetchBinanceCandleHistory rejeita granularity/símbolo inválidos", async () => {
  const noop = async () => new Response("[]", { status: 200 });
  await assert.rejects(() => fetchBinanceCandleHistory("BTCUSDT", 120, 100, noop), RangeError);
  await assert.rejects(() => fetchBinanceCandleHistory("cryBTCUSD", 300, 100, noop), RangeError);
});
