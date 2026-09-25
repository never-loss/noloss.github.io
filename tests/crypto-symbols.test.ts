import { test } from "node:test";
import assert from "node:assert/strict";
import { isCryptoUsd, filterCryptoUsd, listAllCryptoUsd } from "../src/core/crypto-symbols.ts";
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
  assert.equal(isCryptoUsd(""), false);
});

test("marketOf e isCryptoUsd alinham para cry*USD", () => {
  for (const s of ["cryBTCUSD", "cryETHUSD", "cryLTCUSD"]) {
    assert.equal(isCryptoUsd(s), true);
    assert.equal(marketOf(s), "crypto");
  }
});

test("filterCryptoUsd prefere abertos e não suspensos", () => {
  const items = [
    sym({ symbol: "cryETHUSD", open: false }),
    sym({ symbol: "frxEURUSD", market: "forex" }),
    sym({ symbol: "cryBTCUSD", open: true }),
    sym({ symbol: "crySOLUSD", open: true, suspended: true }),
    sym({ symbol: "cryXRPUSD", open: true }),
  ];
  assert.deepEqual(
    filterCryptoUsd(items).map((i) => i.symbol),
    ["cryBTCUSD", "cryXRPUSD"],
  );
});

test("filterCryptoUsd cai para todos os cry*USD se nenhum estiver aberto", () => {
  const items = [
    sym({ symbol: "cryETHUSD", open: false }),
    sym({ symbol: "cryBTCUSD", open: false }),
    sym({ symbol: "crySOLUSD", open: true, suspended: true }),
  ];
  assert.deepEqual(
    filterCryptoUsd(items).map((i) => i.symbol),
    ["cryBTCUSD", "cryETHUSD", "crySOLUSD"],
  );
});

test("listAllCryptoUsd devolve todos os cry*USD ordenados", () => {
  const items = [
    sym({ symbol: "cryETHUSD", open: false }),
    sym({ symbol: "frxEURUSD", market: "forex" }),
    sym({ symbol: "cryXRPUSD", open: true }),
    sym({ symbol: "cryBTCUSD", open: false }),
  ];
  assert.deepEqual(
    listAllCryptoUsd(items).map((i) => i.symbol),
    ["cryBTCUSD", "cryETHUSD", "cryXRPUSD"],
  );
});
