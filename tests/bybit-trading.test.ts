import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  signBybitV5,
  buildPlaceMarketOrder,
  buildCancelOrder,
  quantityFromFixedStake,
  normalizeTradingMode,
  toBybitSide,
  formatBybitQty,
  keysConfigured,
  resolveAuthMode,
  bybitBaseUrl,
  DEFAULT_TRADING_MODE,
  BYBIT_ENV_KEY_NAMES,
} from "../src/core/bybit-trading.ts";
import { MAX_SESSION_MS, MIN_STAKE } from "../src/core/paper.ts";

const FAKE_KEY = "abcdefghij1234567890";
const FAKE_SECRET = "klmnopqrstuvwxyz123456";

test("DEFAULT_TRADING_MODE é PAPER", () => {
  assert.equal(DEFAULT_TRADING_MODE, "PAPER");
  assert.equal(normalizeTradingMode("REAL"), "REAL");
  assert.equal(normalizeTradingMode("real"), "REAL");
  assert.equal(normalizeTradingMode("PAPER"), "PAPER");
  assert.equal(normalizeTradingMode(undefined), "PAPER");
  assert.equal(normalizeTradingMode(""), "PAPER");
});

test("toBybitSide mapeia BUY/SELL → Buy/Sell", () => {
  assert.equal(toBybitSide("BUY"), "Buy");
  assert.equal(toBybitSide("SELL"), "Sell");
  assert.equal(toBybitSide("Buy"), "Buy");
  assert.equal(toBybitSide("sell"), "Sell");
  assert.equal(toBybitSide("HOLD"), null);
  assert.equal(toBybitSide(""), null);
});

test("formatBybitQty stringifica qty válida", () => {
  assert.equal(formatBybitQty(0.001), "0.001");
  assert.equal(formatBybitQty("0.01"), "0.01");
  assert.equal(formatBybitQty(0), null);
  assert.equal(formatBybitQty(-1), null);
  assert.equal(formatBybitQty("abc"), null);
  assert.equal(formatBybitQty(""), null);
});

test("signBybitV5 HMAC-SHA256 vector conhecido", () => {
  // Official-style prehash: timestamp + apiKey + recvWindow + body
  const timestamp = "1658384314791";
  const apiKey = "XXXXXXXXXX";
  const recvWindow = "5000";
  const body =
    '{"category":"linear","symbol":"BTCUSDT","side":"Buy","orderType":"Market","qty":"0.001"}';
  const secret = "supersecret";
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}${apiKey}${recvWindow}${body}`)
    .digest("hex");
  const sig = signBybitV5(timestamp, apiKey, recvWindow, body, secret);
  assert.equal(sig, expected);
  assert.equal(sig.length, 64);
  assert.match(sig, /^[a-f0-9]+$/);
  // Stable
  assert.equal(signBybitV5(timestamp, apiKey, recvWindow, body, secret), sig);
});

test("buildPlaceMarketOrder: PAPER / gate / sessão / martingale implícito bloqueiam", () => {
  const base = {
    symbol: "BTCUSDT",
    side: "BUY" as const,
    quantity: 0.001,
    evidenceAllowed: true,
    mode: "PAPER" as const,
    sessionElapsedMs: 0,
  };
  const paper = buildPlaceMarketOrder(base, FAKE_KEY, FAKE_SECRET);
  assert.equal(paper.ok, false);
  if (!paper.ok) assert.equal(paper.code, "paper_mode");

  const gated = buildPlaceMarketOrder(
    { ...base, mode: "REAL", evidenceAllowed: false },
    FAKE_KEY,
    FAKE_SECRET,
  );
  assert.equal(gated.ok, false);
  if (!gated.ok) assert.equal(gated.code, "evidence_gate");

  const long = buildPlaceMarketOrder(
    { ...base, mode: "REAL", sessionElapsedMs: MAX_SESSION_MS },
    FAKE_KEY,
    FAKE_SECRET,
  );
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.code, "max_session");

  const badQty = buildPlaceMarketOrder(
    { ...base, mode: "REAL", quantity: 0 },
    FAKE_KEY,
    FAKE_SECRET,
  );
  assert.equal(badQty.ok, false);
  if (!badQty.ok) assert.equal(badQty.code, "invalid_quantity");

  const badSym = buildPlaceMarketOrder(
    { ...base, mode: "REAL", symbol: "BTCUSD" },
    FAKE_KEY,
    FAKE_SECRET,
  );
  assert.equal(badSym.ok, false);
  if (!badSym.ok) assert.equal(badSym.code, "invalid_symbol");
});

test("buildPlaceMarketOrder: REAL + gate monta POST assinado linear Market", () => {
  const built = buildPlaceMarketOrder(
    {
      symbol: "ETHUSDT",
      side: "SELL",
      quantity: 0.01,
      evidenceAllowed: true,
      mode: "REAL",
      sessionElapsedMs: 60_000,
    },
    FAKE_KEY,
    FAKE_SECRET,
    1_700_000_000_000,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.method, "POST");
  assert.equal(built.path, "/v5/order/create");
  const parsed = JSON.parse(built.body);
  assert.equal(parsed.category, "linear");
  assert.equal(parsed.symbol, "ETHUSDT");
  assert.equal(parsed.side, "Sell");
  assert.equal(parsed.orderType, "Market");
  assert.equal(parsed.qty, "0.01");
  assert.equal(typeof parsed.qty, "string");
  assert.equal(built.headers["X-BAPI-API-KEY"], FAKE_KEY);
  assert.equal(built.headers["X-BAPI-TIMESTAMP"], "1700000000000");
  assert.equal(built.headers["X-BAPI-RECV-WINDOW"], "5000");
  assert.match(built.headers["X-BAPI-SIGN"], /^[a-f0-9]{64}$/);
  // Sign matches body exactly
  const expectSign = signBybitV5(
    "1700000000000",
    FAKE_KEY,
    "5000",
    built.body,
    FAKE_SECRET,
  );
  assert.equal(built.headers["X-BAPI-SIGN"], expectSign);
});

test("buildCancelOrder exige REAL e id", () => {
  const paper = buildCancelOrder(
    { symbol: "BTCUSDT", orderId: "1", mode: "PAPER" },
    FAKE_KEY,
    FAKE_SECRET,
  );
  assert.equal(paper.ok, false);
  const missing = buildCancelOrder({ symbol: "BTCUSDT", mode: "REAL" }, FAKE_KEY, FAKE_SECRET);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "missing_id");
  const ok = buildCancelOrder(
    { symbol: "BTCUSDT", orderId: "42", mode: "REAL" },
    FAKE_KEY,
    FAKE_SECRET,
    1000,
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.path, "/v5/order/cancel");
    const parsed = JSON.parse(ok.body);
    assert.equal(parsed.orderId, "42");
    assert.equal(parsed.category, "linear");
  }
});

test("quantityFromFixedStake sem martingale", () => {
  assert.equal(quantityFromFixedStake(10, 100), 0.1);
  assert.equal(quantityFromFixedStake(10, 100, 0.01), 0.1);
  assert.equal(quantityFromFixedStake(10, 100, 0.03), 0.09);
  assert.throws(() => quantityFromFixedStake(MIN_STAKE - 0.1, 100), RangeError);
  assert.throws(() => quantityFromFixedStake(1, 0), RangeError);
});

test("keysConfigured / resolveAuthMode / baseUrl / env names", () => {
  assert.equal(BYBIT_ENV_KEY_NAMES.apiKey, "BYBIT_API_KEY");
  assert.equal(BYBIT_ENV_KEY_NAMES.apiSecret, "BYBIT_API_SECRET");
  assert.equal(BYBIT_ENV_KEY_NAMES.baseUrl, "BYBIT_BASE_URL");
  assert.equal(keysConfigured({}), false);
  assert.equal(resolveAuthMode({}), "none");
  assert.equal(keysConfigured({ BYBIT_API_KEY: "short", BYBIT_API_SECRET: "short" }), false);
  assert.equal(
    keysConfigured({
      BYBIT_API_KEY: "abcdefghij",
      BYBIT_API_SECRET: "klmnopqrst",
    }),
    true,
  );
  assert.equal(
    resolveAuthMode({
      BYBIT_API_KEY: "abcdefghij",
      BYBIT_API_SECRET: "klmnopqrst",
    }),
    "hmac",
  );
  assert.equal(bybitBaseUrl({}), "https://api.bybit.com");
  assert.equal(
    bybitBaseUrl({ BYBIT_BASE_URL: "https://api.bytick.com" }),
    "https://api.bytick.com",
  );
  // Reject non-https / junk
  assert.equal(bybitBaseUrl({ BYBIT_BASE_URL: "http://evil.example" }), "https://api.bybit.com");
});

test("buildPlaceMarketOrder reduceOnly fecha sem evidence / sessão", () => {
  const built = buildPlaceMarketOrder(
    {
      symbol: "BTCUSDT",
      side: "SELL",
      quantity: "0.001",
      evidenceAllowed: false,
      mode: "REAL",
      sessionElapsedMs: MAX_SESSION_MS + 1,
      reduceOnly: true,
    },
    FAKE_KEY,
    FAKE_SECRET,
    1_700_000_000_000,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const parsed = JSON.parse(built.body);
  assert.equal(parsed.reduceOnly, true);
  assert.equal(parsed.side, "Sell");
});
