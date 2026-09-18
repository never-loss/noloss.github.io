import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage } from "../src/core/ticks.ts";

test("tick válido é interpretado", () => {
  const raw = JSON.stringify({
    msg_type: "tick",
    tick: { symbol: "1HZ100V", epoch: 1700000000, quote: 1234.5, pip_size: 2 },
  });
  assert.deepEqual(parseMessage(raw), {
    kind: "tick",
    symbol: "1HZ100V",
    epoch: 1700000000,
    quote: 1234.5,
    pipSize: 2,
  });
});

test("pip_size ausente devolve null", () => {
  const raw = JSON.stringify({
    msg_type: "tick",
    tick: { symbol: "R_100", epoch: 1, quote: 10 },
  });
  const m = parseMessage(raw);
  assert.equal(m.kind, "tick");
  if (m.kind === "tick") assert.equal(m.pipSize, null);
});

test("campos em falta dão invalid", () => {
  const semQuote = JSON.stringify({ msg_type: "tick", tick: { symbol: "R_100", epoch: 1 } });
  assert.equal(parseMessage(semQuote).kind, "invalid");
  const semSymbol = JSON.stringify({ msg_type: "tick", tick: { epoch: 1, quote: 1 } });
  assert.equal(parseMessage(semSymbol).kind, "invalid");
  assert.equal(parseMessage("não é json").kind, "invalid");
  assert.equal(parseMessage("42").kind, "invalid");
});

test("erros da API e outras mensagens", () => {
  const err = JSON.stringify({ error: { code: "InvalidSymbol", message: "x" } });
  assert.deepEqual(parseMessage(err), { kind: "error", code: "InvalidSymbol", message: "x" });
  assert.equal(parseMessage(JSON.stringify({ msg_type: "ping" })).kind, "other");
});
