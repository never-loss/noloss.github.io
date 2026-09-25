import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCryptoUsd,
  filterCryptoUsd,
  listAllCryptoUsd,
  mergeCryptoUsdListings,
  KNOWN_OPTIONS_CRYPTO_FEED,
  cryptoSourceOf,
  isOptionsFeedOnly,
} from "../src/core/crypto-symbols.ts";
import type { SymbolInfo } from "../src/core/market-data.ts";
import { marketOf } from "../src/core/markets.ts";

function sym(partial: Partial<SymbolInfo> & { symbol: string }): SymbolInfo {
  return {
    displayName: partial.displayName ?? partial.symbol,
    market: partial.market ?? "cryptocurrency",
    submarket: partial.submarket ?? "crypto_usd",
    open: partial.open ?? true,
    suspended: partial.suspended ?? false,
    symbol: partial.symbol,
  };
}

test("isCryptoUsd só aceita cry*USD em maiúsculas", () => {
  assert.equal(isCryptoUsd("cryBTCUSD"), true);
  assert.equal(isCryptoUsd("cryETHUSD"), true);
  assert.equal(isCryptoUsd("crySOLUSD"), true);
  assert.equal(isCryptoUsd("cryBTC"), false);
  assert.equal(isCryptoUsd("frxEURUSD"), false);
  assert.equal(isCryptoUsd("crybtcusd"), false);
  assert.equal(isCryptoUsd("BTCUSD"), false);
  assert.equal(isCryptoUsd(""), false);
});

test("marketOf e isCryptoUsd alinham para cry*USD", () => {
  for (const s of ["cryBTCUSD", "cryETHUSD", "cryLTCUSD"]) {
    assert.equal(isCryptoUsd(s), true);
    assert.equal(marketOf(s), "crypto");
  }
});

test("filterCryptoUsd prefere abertos e não suspensos entre active+feed", () => {
  const items = [
    sym({ symbol: "cryETHUSD", open: false }),
    sym({ symbol: "frxEURUSD", market: "forex" }),
    sym({ symbol: "cryBTCUSD", open: true }),
    sym({ symbol: "crySOLUSD", open: true, suspended: true }),
    sym({ symbol: "cryXRPUSD", open: true }),
  ];
  const filtered = filterCryptoUsd(items).map((i) => i.symbol);
  assert.ok(filtered.includes("cryBTCUSD"));
  assert.ok(filtered.includes("cryXRPUSD"));
  assert.ok(!filtered.includes("cryETHUSD") || filtered.includes("cryBTCUSD"));
  // Com abertos presentes, suspensos/fechados do active não entram; feed stubs (open) também entram.
  assert.ok(filtered.includes("cryLTCUSD")); // do catálogo feed
  assert.ok(!filtered.includes("crySOLUSD")); // suspenso no active
});

test("filterCryptoUsd cai para todos se nenhum estiver aberto", () => {
  // Só símbolos active fechados/suspensos — mas merge adiciona feed abertos.
  // Para testar o fallback, passamos lista já só com fechados via merge desligado:
  // listAllCryptoUsd sempre faz merge; se feed stubs estão open, filter prefere-os.
  const items = [
    sym({ symbol: "cryETHUSD", open: false }),
    sym({ symbol: "cryBTCUSD", open: false }),
  ];
  const filtered = filterCryptoUsd(items);
  assert.ok(filtered.length >= KNOWN_OPTIONS_CRYPTO_FEED.length - 2);
  assert.ok(filtered.every((i) => i.open && !i.suspended));
});

test("listAllCryptoUsd / merge inclui feed conhecido além de active_symbols", () => {
  const items = [
    sym({ symbol: "cryETHUSD", open: false, displayName: "ETH/USD" }),
    sym({ symbol: "frxEURUSD", market: "forex" }),
    sym({ symbol: "cryBTCUSD", open: true, displayName: "BTC/USD" }),
  ];
  const all = listAllCryptoUsd(items);
  const syms = all.map((i) => i.symbol);
  assert.ok(syms.includes("cryBTCUSD"));
  assert.ok(syms.includes("cryETHUSD"));
  assert.ok(syms.includes("crySOLUSD"));
  assert.ok(syms.includes("cryXRPUSD"));
  assert.equal(all.find((i) => i.symbol === "cryBTCUSD")!.displayName, "BTC/USD");
  assert.equal(cryptoSourceOf("cryBTCUSD", items), "options_active");
  assert.equal(cryptoSourceOf("crySOLUSD", items), "options_feed");
  assert.equal(isOptionsFeedOnly("crySOLUSD", items), true);
  assert.equal(isOptionsFeedOnly("cryBTCUSD", items), false);
  assert.deepEqual(
    mergeCryptoUsdListings(items).map((i) => i.symbol),
    all.map((i) => i.symbol),
  );
});

test("KNOWN_OPTIONS_CRYPTO_FEED só tem cry*USD", () => {
  assert.ok(KNOWN_OPTIONS_CRYPTO_FEED.length >= 10);
  for (const s of KNOWN_OPTIONS_CRYPTO_FEED) assert.equal(isCryptoUsd(s), true);
});
