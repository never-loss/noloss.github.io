import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBybitUsdtSymbol,
  bybitBaseAsset,
  granularityToBybitInterval,
  bybitIntervalToSeconds,
  toBybitInterval,
  isLinearUsdtPerpetual,
  parseBybitInstrumentsPage,
  mergeBybitInstrumentPages,
  parseBybitKlines,
  sortBybitUsdtPreferred,
  fetchBybitCandleHistory,
  BYBIT_PREFERRED_USDT,
  BYBIT_PATH_INSTRUMENTS,
  BYBIT_PATH_KLINE,
} from "../src/core/bybit.ts";
import { marketOf } from "../src/core/markets.ts";

const SAMPLE_INSTRUMENTS = JSON.stringify({
  retCode: 0,
  retMsg: "OK",
  result: {
    category: "linear",
    list: [
      {
        symbol: "BTCUSDT",
        contractType: "LinearPerpetual",
        status: "Trading",
        baseCoin: "BTC",
        quoteCoin: "USDT",
        settleCoin: "USDT",
        isPreListing: false,
      },
      {
        symbol: "ETHUSDT",
        contractType: "LinearPerpetual",
        status: "Trading",
        baseCoin: "ETH",
        quoteCoin: "USDT",
        settleCoin: "USDT",
      },
      {
        symbol: "BTCUSD",
        contractType: "InversePerpetual",
        status: "Trading",
        baseCoin: "BTC",
        quoteCoin: "USD",
        settleCoin: "BTC",
      },
      {
        symbol: "BTCUSDT-26SEP25",
        contractType: "LinearFutures",
        status: "Trading",
        baseCoin: "BTC",
        quoteCoin: "USDT",
        settleCoin: "USDT",
      },
      {
        symbol: "ADAUSDT",
        contractType: "LinearPerpetual",
        status: "Settling",
        baseCoin: "ADA",
        quoteCoin: "USDT",
        settleCoin: "USDT",
      },
      {
        symbol: "SOLUSDT",
        contractType: "LinearPerpetual",
        status: "Trading",
        baseCoin: "SOL",
        quoteCoin: "USDT",
        settleCoin: "USDT",
        isPreListing: false,
      },
      {
        symbol: "PREUSDT",
        contractType: "LinearPerpetual",
        status: "Trading",
        baseCoin: "PRE",
        quoteCoin: "USDT",
        settleCoin: "USDT",
        isPreListing: true,
      },
    ],
    nextPageCursor: "",
  },
});

/** Bybit returns newest first: second candle then first chronologically. */
const SAMPLE_KLINES_NEWEST_FIRST = JSON.stringify({
  retCode: 0,
  retMsg: "OK",
  result: {
    symbol: "BTCUSDT",
    category: "linear",
    list: [
      ["1790399100000", "83993.04", "83993.05", "83993.04", "83993.04", "3.9", "328255"],
      ["1790398800000", "83976.01", "83993.05", "83976.01", "83993.04", "11.3", "950610"],
    ],
  },
});

test("isBybitUsdtSymbol e base asset", () => {
  assert.equal(isBybitUsdtSymbol("BTCUSDT"), true);
  assert.equal(isBybitUsdtSymbol("ETHUSDT"), true);
  assert.equal(isBybitUsdtSymbol("1000PEPEUSDT"), true);
  assert.equal(isBybitUsdtSymbol("cryBTCUSD"), false);
  assert.equal(isBybitUsdtSymbol("btcusdt"), false);
  assert.equal(isBybitUsdtSymbol("BTCUSD"), false);
  assert.equal(bybitBaseAsset("BTCUSDT"), "BTC");
  assert.equal(bybitBaseAsset("1000PEPEUSDT"), "1000PEPE");
});

test("marketOf trata Bybit USDT como crypto", () => {
  assert.equal(marketOf("BTCUSDT"), "crypto");
  assert.equal(marketOf("ETHUSDT"), "crypto");
});

test("granularity ↔ interval Bybit + label map", () => {
  assert.equal(granularityToBybitInterval(60), "1");
  assert.equal(granularityToBybitInterval(300), "5");
  assert.equal(granularityToBybitInterval(900), "15");
  assert.equal(granularityToBybitInterval(3600), "60");
  assert.equal(granularityToBybitInterval(120), null);
  assert.equal(granularityToBybitInterval(28800), null); // no 8h on Bybit v5 table
  assert.equal(bybitIntervalToSeconds("5"), 300);
  assert.equal(bybitIntervalToSeconds("60"), 3600);
  assert.equal(bybitIntervalToSeconds("D"), 86400);
  assert.equal(toBybitInterval("1m"), "1");
  assert.equal(toBybitInterval("5m"), "5");
  assert.equal(toBybitInterval("1h"), "60");
  assert.equal(toBybitInterval("1"), "1");
  assert.equal(toBybitInterval("8h"), null);
});

test("isLinearUsdtPerpetual filtra só LinearPerpetual USDT Trading", () => {
  assert.equal(
    isLinearUsdtPerpetual({
      symbol: "BTCUSDT",
      quoteCoin: "USDT",
      settleCoin: "USDT",
      status: "Trading",
      contractType: "LinearPerpetual",
    }),
    true,
  );
  assert.equal(
    isLinearUsdtPerpetual({
      symbol: "BTCUSDT",
      quoteCoin: "USDT",
      status: "Trading",
      contractType: "LinearFutures",
    }),
    false,
  );
  assert.equal(
    isLinearUsdtPerpetual({
      symbol: "BTCUSDT",
      quoteCoin: "USDT",
      status: "Trading",
      contractType: "LinearPerpetual",
      isPreListing: true,
    }),
    false,
  );
});

test("parseBybitInstrumentsPage: só LinearPerpetual USDT Trading", () => {
  const msg = parseBybitInstrumentsPage(SAMPLE_INSTRUMENTS);
  assert.equal(msg.kind, "symbols");
  if (msg.kind !== "symbols") return;
  const syms = msg.items.map((i) => i.symbol);
  assert.deepEqual(syms.sort(), ["BTCUSDT", "ETHUSDT", "SOLUSDT"].sort());
  assert.ok(msg.skipped >= 3);
  const btc = msg.items.find((i) => i.symbol === "BTCUSDT")!;
  assert.ok(btc.displayName.includes("BTC/USDT"));
  assert.ok(btc.displayName.includes("Bybit"));
  assert.equal(btc.submarket, "bybit_linear_usdt");
  assert.equal(btc.open, true);
});

test("mergeBybitInstrumentPages junta páginas", () => {
  const p1 = parseBybitInstrumentsPage(SAMPLE_INSTRUMENTS);
  const p2 = parseBybitInstrumentsPage(
    JSON.stringify({
      retCode: 0,
      result: {
        list: [
          {
            symbol: "LINKUSDT",
            contractType: "LinearPerpetual",
            status: "Trading",
            baseCoin: "LINK",
            quoteCoin: "USDT",
            settleCoin: "USDT",
          },
        ],
        nextPageCursor: "",
      },
    }),
  );
  const merged = mergeBybitInstrumentPages([p1, p2]);
  assert.equal(merged.kind, "symbols");
  if (merged.kind !== "symbols") return;
  assert.ok(merged.items.some((i) => i.symbol === "LINKUSDT"));
  assert.ok(merged.items.some((i) => i.symbol === "BTCUSDT"));
});

test("parseBybitInstrumentsPage: erros e inválidos", () => {
  assert.equal(parseBybitInstrumentsPage("not-json").kind, "invalid");
  const err = parseBybitInstrumentsPage(JSON.stringify({ retCode: 10001, retMsg: "Invalid" }));
  assert.equal(err.kind, "error");
  if (err.kind === "error") {
    assert.equal(err.code, "10001");
    assert.ok(err.message.includes("Invalid"));
  }
});

test("parseBybitKlines: reverse newest-first → oldest-first OHLC", () => {
  const msg = parseBybitKlines(SAMPLE_KLINES_NEWEST_FIRST);
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
  assert.ok(c0.epoch < c1.epoch);
});

test("parseBybitKlines: aceita array bare (já oldest-first)", () => {
  const bare = JSON.stringify([
    [1_790_398_800_000, "10", "12", "9", "11", "1", "1"],
    [1_790_399_100_000, "11", "13", "10", "12", "1", "1"],
  ]);
  const msg = parseBybitKlines(bare);
  assert.equal(msg.kind, "candles");
  if (msg.kind !== "candles") return;
  assert.equal(msg.candles[0]!.epoch, 1_790_398_800);
  assert.equal(msg.candles[1]!.epoch, 1_790_399_100);
});

test("parseBybitKlines: rejeita vela incoerente e erros API", () => {
  const bad = JSON.stringify({
    retCode: 0,
    result: { list: [["1000000", "10", "9", "11", "10", "1", "1"]] },
  });
  assert.equal(parseBybitKlines(bad).kind, "invalid");
  const err = parseBybitKlines(JSON.stringify({ retCode: 10001, retMsg: "fail" }));
  assert.equal(err.kind, "error");
  const empty = parseBybitKlines(JSON.stringify({ retCode: 0, result: { list: [] } }));
  assert.equal(empty.kind, "candles");
  if (empty.kind === "candles") assert.equal(empty.candles.length, 0);
});

test("sortBybitUsdtPreferred põe BTC/ETH à frente", () => {
  const items = [
    { symbol: "ZZZUSDT", displayName: "Z", market: "cryptocurrency", submarket: "bybit_linear_usdt", open: true, suspended: false },
    { symbol: "ETHUSDT", displayName: "E", market: "cryptocurrency", submarket: "bybit_linear_usdt", open: true, suspended: false },
    { symbol: "BTCUSDT", displayName: "B", market: "cryptocurrency", submarket: "bybit_linear_usdt", open: true, suspended: false },
  ];
  const sorted = sortBybitUsdtPreferred(items).map((i) => i.symbol);
  assert.deepEqual(sorted, ["BTCUSDT", "ETHUSDT", "ZZZUSDT"]);
  assert.ok(BYBIT_PREFERRED_USDT.includes("BTCUSDT"));
});

test("fetchBybitCandleHistory pagina kline e fecha a vela em formação", async () => {
  // Upstream newest-first like Bybit; parser reverses.
  const rowsNewestFirst = Array.from({ length: 5 }, (_, i) => {
    const idx = 4 - i;
    const openMs = 1_700_000_000_000 + idx * 300_000;
    const px = String(100 + idx);
    return [String(openMs), px, px, px, px, "1", "1"];
  });
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    assert.ok(u.includes(BYBIT_PATH_KLINE) || u.includes("/v5/market/kline"));
    assert.ok(u.includes("symbol=BTCUSDT"));
    assert.ok(u.includes("interval=5"));
    assert.ok(u.includes("category=linear"));
    return new Response(
      JSON.stringify({ retCode: 0, result: { list: rowsNewestFirst } }),
      { status: 200 },
    );
  };
  const nowMs = 1_700_000_000_000 + 4 * 300_000 + 150_000;
  const candles = await fetchBybitCandleHistory("BTCUSDT", 300, 10, fetchImpl, nowMs);
  assert.equal(candles.length, 4);
  assert.equal(candles[0]!.epoch, 1_700_000_000);
  assert.equal(candles[3]!.close, 103);
});

test("fetchBybitCandleHistory rejeita granularity/símbolo inválidos", async () => {
  const noop = async () =>
    new Response(JSON.stringify({ retCode: 0, result: { list: [] } }), { status: 200 });
  await assert.rejects(() => fetchBybitCandleHistory("BTCUSDT", 120, 100, noop), RangeError);
  await assert.rejects(() => fetchBybitCandleHistory("cryBTCUSD", 300, 100, noop), RangeError);
});

test("paths Bybit documentados", () => {
  assert.equal(BYBIT_PATH_INSTRUMENTS, "/v5/market/instruments-info");
  assert.equal(BYBIT_PATH_KLINE, "/v5/market/kline");
});
