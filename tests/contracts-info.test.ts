import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContractsFor, pickMultiplier, shorten } from "../src/core/contracts-info.ts";

const amostra = JSON.stringify({
  msg_type: "contracts_for",
  contracts_for: {
    available: [
      { contract_type: "MULTUP", multiplier_range: [20, 50, 100, 200], cancellation_range: ["5m", "10m"] },
      { contract_type: "MULTDOWN", multiplier_range: [50, 100, 300], cancellation_range: ["5m", "60m"] },
      { contract_type: "CALL" },
      { contract_type: "CALL" },
      { contract_type: "PUT" },
    ],
    count: 5,
  },
});

test("lê os tipos de contrato, os multiplicadores e o cancelamento", () => {
  const m = parseContractsFor(amostra);
  assert.equal(m.kind, "contracts");
  if (m.kind !== "contracts") return;
  assert.deepEqual(m.types, [
    { type: "CALL", count: 2 },
    { type: "MULTDOWN", count: 1 },
    { type: "MULTUP", count: 1 },
    { type: "PUT", count: 1 },
  ]);
  assert.deepEqual(m.multipliers, [20, 50, 100, 200, 300]);
  assert.deepEqual(m.cancellation, ["10m", "5m", "60m"]);
  assert.ok(m.keys.includes("available"));
});

test("aceita a lista no nível de cima e números em texto", () => {
  const raw = JSON.stringify({
    msg_type: "contracts_for",
    available: [{ contract_type: "MULTUP", multiplier_range: ["10", 20, "x"] }],
  });
  const m = parseContractsFor(raw);
  assert.equal(m.kind, "contracts");
  if (m.kind === "contracts") assert.deepEqual(m.multipliers, [10, 20]);
});

test("sem multiplicadores devolve lista vazia (não inventa)", () => {
  const m = parseContractsFor(JSON.stringify({ msg_type: "contracts_for", contracts_for: { available: [{ contract_type: "CALL" }] } }));
  assert.equal(m.kind, "contracts");
  if (m.kind === "contracts") assert.deepEqual(m.multipliers, []);
});

test("erros, formatos inesperados e outras mensagens", () => {
  assert.equal(parseContractsFor("nada").kind, "invalid");
  assert.equal(parseContractsFor("[1]").kind, "invalid");
  assert.equal(parseContractsFor(JSON.stringify({ msg_type: "contracts_for", contracts_for: {} })).kind, "invalid");
  assert.equal(parseContractsFor(JSON.stringify({ msg_type: "tick" })).kind, "other");
  const err = parseContractsFor(JSON.stringify({ error: { code: "X", message: "y" } }));
  assert.deepEqual(err, { kind: "error", code: "X", message: "y" });
});

test("multiplicador: o maior que não é mais apertado que o stop", () => {
  const permitidos = [20, 50, 100, 200, 300, 500, 1000];
  assert.equal(pickMultiplier(permitidos, 0.01), 100);
  assert.equal(pickMultiplier(permitidos, 0.009), 100);
  assert.equal(pickMultiplier(permitidos, 0.05), 20);
  assert.equal(pickMultiplier(permitidos, 0.001), 1000);
  assert.equal(pickMultiplier(permitidos, 0.5), null);
  assert.equal(pickMultiplier([], 0.01), null);
  assert.throws(() => pickMultiplier(permitidos, 0), RangeError);
  assert.throws(() => pickMultiplier(permitidos, NaN), RangeError);
});

test("texto encurtado para o log", () => {
  assert.equal(shorten("abc", 10), "abc");
  assert.ok(shorten("x".repeat(50), 10).startsWith("xxxxxxxxxx…"));
});
