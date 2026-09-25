import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActiveSymbols } from "../src/core/market-data.ts";
import { filterCryptoUsd, listAllCryptoUsd, isOptionsFeedOnly } from "../src/core/crypto-symbols.ts";

test("active_symbols aceita underlying_symbol (Options WS moderno)", () => {
  const raw = JSON.stringify({
    msg_type: "active_symbols",
    active_symbols: [
      {
        underlying_symbol: "cryBTCUSD",
        underlying_symbol_name: "BTC/USD",
        market: "cryptocurrency",
        submarket: "crypto_usd",
        exchange_is_open: 1,
        is_trading_suspended: 0,
      },
      {
        underlying_symbol: "frxEURUSD",
        underlying_symbol_name: "EUR/USD",
        market: "forex",
        submarket: "major_pairs",
        exchange_is_open: 1,
        is_trading_suspended: 0,
      },
      {
        symbol: "cryETHUSD",
        display_name: "ETH/USD",
        market: "cryptocurrency",
        exchange_is_open: true,
        is_trading_suspended: false,
      },
    ],
  });
  const msg = parseActiveSymbols(raw);
  assert.equal(msg.kind, "symbols");
  if (msg.kind !== "symbols") return;
  assert.equal(msg.skipped, 0);
  assert.deepEqual(
    msg.items.map((i) => i.symbol),
    ["cryBTCUSD", "frxEURUSD", "cryETHUSD"],
  );
  assert.equal(msg.items[0]!.displayName, "BTC/USD");

  const activeOnly = msg.items.filter((i) => i.symbol.startsWith("cry"));
  assert.deepEqual(
    activeOnly.map((i) => i.symbol),
    ["cryBTCUSD", "cryETHUSD"],
  );

  // Painel/pesquisa: active + feed Options conhecido (não MT5).
  const all = listAllCryptoUsd(msg.items).map((i) => i.symbol);
  assert.ok(all.includes("cryBTCUSD") && all.includes("cryETHUSD"));
  assert.ok(all.includes("crySOLUSD"));
  assert.equal(isOptionsFeedOnly("crySOLUSD", msg.items), true);
  assert.equal(isOptionsFeedOnly("cryBTCUSD", msg.items), false);

  const filtered = filterCryptoUsd(msg.items).map((i) => i.symbol);
  assert.ok(filtered.includes("cryBTCUSD"));
  assert.ok(filtered.includes("cryETHUSD"));
  assert.ok(filtered.includes("cryLTCUSD"));
});
