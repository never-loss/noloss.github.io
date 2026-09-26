import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signBinanceQuery,
  buildSignedQuery,
  buildPlaceMarketOrder,
  buildCancelOrder,
  quantityFromFixedStake,
  normalizeTradingMode,
  keysConfigured,
  DEFAULT_TRADING_MODE,
  BINANCE_ENV_KEY_NAMES,
} from "../src/core/binance-futures-trading.ts";
import { MAX_SESSION_MS, MIN_STAKE } from "../src/core/paper.ts";

test("DEFAULT_TRADING_MODE é PAPER", () => {
  assert.equal(DEFAULT_TRADING_MODE, "PAPER");
  assert.equal(normalizeTradingMode("REAL"), "REAL");
  assert.equal(normalizeTradingMode("real"), "REAL");
  assert.equal(normalizeTradingMode("PAPER"), "PAPER");
  assert.equal(normalizeTradingMode(undefined), "PAPER");
  assert.equal(normalizeTradingMode(""), "PAPER");
});

test("signBinanceQuery HMAC-SHA256 estável", () => {
  // Vector: secret=secret, payload=symbol=BTCUSDT&side=BUY&timestamp=1
  const sig = signBinanceQuery("symbol=BTCUSDT&side=BUY&timestamp=1", "secret");
  assert.equal(sig.length, 64);
  assert.match(sig, /^[a-f0-9]+$/);
  assert.equal(signBinanceQuery("symbol=BTCUSDT&side=BUY&timestamp=1", "secret"), sig);
});

test("buildSignedQuery acrescenta timestamp e signature", () => {
  const q = buildSignedQuery({ symbol: "BTCUSDT", side: "BUY" }, "secret", 1_700_000_000_000);
  assert.ok(q.includes("symbol=BTCUSDT"));
  assert.ok(q.includes("side=BUY"));
  assert.ok(q.includes("timestamp=1700000000000"));
  assert.ok(q.includes("&signature="));
  const sig = q.split("&signature=")[1]!;
  assert.equal(sig.length, 64);
});

test("buildPlaceMarketOrder: PAPER / gate / sessão bloqueiam", () => {
  const base = {
    symbol: "BTCUSDT",
    side: "BUY" as const,
    quantity: 0.001,
    evidenceAllowed: true,
    mode: "PAPER" as const,
    sessionElapsedMs: 0,
  };
  const paper = buildPlaceMarketOrder(base, "secret");
  assert.equal(paper.ok, false);
  if (!paper.ok) assert.equal(paper.code, "paper_mode");

  const gated = buildPlaceMarketOrder({ ...base, mode: "REAL", evidenceAllowed: false }, "secret");
  assert.equal(gated.ok, false);
  if (!gated.ok) assert.equal(gated.code, "evidence_gate");

  const long = buildPlaceMarketOrder(
    { ...base, mode: "REAL", sessionElapsedMs: MAX_SESSION_MS },
    "secret",
  );
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.code, "max_session");
});

test("buildPlaceMarketOrder: REAL + gate monta POST assinado", () => {
  const built = buildPlaceMarketOrder(
    {
      symbol: "ETHUSDT",
      side: "SELL",
      quantity: 0.01,
      evidenceAllowed: true,
      mode: "REAL",
      sessionElapsedMs: 60_000,
    },
    "secret",
    1_700_000_000_000,
  );
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.method, "POST");
  assert.equal(built.path, "/fapi/v1/order");
  assert.ok(built.query.includes("symbol=ETHUSDT"));
  assert.ok(built.query.includes("side=SELL"));
  assert.ok(built.query.includes("type=MARKET"));
  assert.ok(built.query.includes("signature="));
});

test("buildCancelOrder exige REAL e id", () => {
  const paper = buildCancelOrder({ symbol: "BTCUSDT", orderId: 1, mode: "PAPER" }, "secret");
  assert.equal(paper.ok, false);
  const missing = buildCancelOrder({ symbol: "BTCUSDT", mode: "REAL" }, "secret");
  assert.equal(missing.ok, false);
  const ok = buildCancelOrder({ symbol: "BTCUSDT", orderId: 42, mode: "REAL" }, "secret", 1000);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.method, "DELETE");
    assert.ok(ok.query.includes("orderId=42"));
  }
});

test("quantityFromFixedStake sem martingale", () => {
  assert.equal(quantityFromFixedStake(10, 100), 0.1);
  assert.equal(quantityFromFixedStake(10, 100, 0.01), 0.1);
  assert.equal(quantityFromFixedStake(10, 100, 0.03), 0.09);
  assert.throws(() => quantityFromFixedStake(MIN_STAKE - 0.1, 100), RangeError);
  assert.throws(() => quantityFromFixedStake(1, 0), RangeError);
});

test("keysConfigured e nomes de env", () => {
  assert.equal(BINANCE_ENV_KEY_NAMES.apiKey, "BINANCE_API_KEY");
  assert.equal(BINANCE_ENV_KEY_NAMES.apiSecret, "BINANCE_API_SECRET");
  assert.equal(keysConfigured({}), false);
  assert.equal(keysConfigured({ BINANCE_API_KEY: "short", BINANCE_API_SECRET: "short" }), false);
  assert.equal(
    keysConfigured({
      BINANCE_API_KEY: "abcdefghij",
      BINANCE_API_SECRET: "klmnopqrst",
    }),
    true,
  );
});
