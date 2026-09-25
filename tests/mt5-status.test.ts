import { test } from "node:test";
import assert from "node:assert/strict";
import { MT5_CRYPTO_STATUS, formatMt5StatusBlock } from "../src/core/mt5-status.ts";

test("MT5 status é blocked e não promete ligação falsa", () => {
  assert.equal(MT5_CRYPTO_STATUS.status, "blocked_no_public_api");
  assert.ok(MT5_CRYPTO_STATUS.needed.length >= 2);
  assert.ok(MT5_CRYPTO_STATUS.optionsPath.toLowerCase().includes("options"));
  const text = formatMt5StatusBlock();
  assert.ok(text.includes("MT5"));
  assert.ok(!/ligado|conectado|saldo mt5/i.test(text));
  assert.ok(text.includes("InvalidSymbol") || text.includes("API"));
});
