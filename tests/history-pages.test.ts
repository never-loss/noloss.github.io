import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHistoryPages, nextPageEnd } from "../src/core/history-pages.ts";

test("junta páginas, ordena e remove repetidos", () => {
  const recente = { prices: [3, 4, 5], times: [30, 40, 50] };
  const antiga = { prices: [1, 2, 3], times: [10, 20, 30] };
  const m = mergeHistoryPages([recente, antiga]);
  assert.deepEqual(m.times, [10, 20, 30, 40, 50]);
  assert.deepEqual(m.prices, [1, 2, 3, 4, 5]);
});

test("uma página só e páginas vazias", () => {
  assert.deepEqual(mergeHistoryPages([]), { prices: [], times: [] });
  assert.deepEqual(mergeHistoryPages([{ prices: [7], times: [1] }]), { prices: [7], times: [1] });
});

test("páginas inválidas são rejeitadas", () => {
  assert.throws(() => mergeHistoryPages([{ prices: [1, 2], times: [1] }]), RangeError);
  assert.throws(() => mergeHistoryPages([{ prices: [1], times: [NaN] }]), RangeError);
  assert.throws(() => mergeHistoryPages([{ prices: [Infinity], times: [1] }]), RangeError);
});

test("fim do próximo pedido: um segundo antes do tick mais antigo", () => {
  assert.equal(nextPageEnd([100, 101, 102]), 99);
  assert.equal(nextPageEnd([102, 100, 101]), 99);
  assert.equal(nextPageEnd([]), null);
});

test("cinco páginas de 1000 ticks dão 5000 sem repetições", () => {
  const paginas = [];
  let end = 100_000;
  for (let i = 0; i < 5; i++) {
    const times = Array.from({ length: 1000 }, (_, k) => end - 999 + k);
    paginas.push({ prices: times.map((t) => t % 10), times });
    end = nextPageEnd(times)!;
  }
  const m = mergeHistoryPages(paginas);
  assert.equal(m.times.length, 5000);
  assert.equal(new Set(m.times).size, 5000);
  assert.ok(m.times.every((t, i) => i === 0 || t > m.times[i - 1]!));
});
