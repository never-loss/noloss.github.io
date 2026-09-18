import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lastDigit,
  countDigits,
  percentages,
  deviationFromExpected,
  deviationColor,
  TickWindow,
} from "../src/core/digits.ts";

test("lastDigit respeita o pipSize e não perde zeros finais", () => {
  assert.equal(lastDigit(1234.5, 2), 0);
  assert.equal(lastDigit(1234.56, 2), 6);
  assert.equal(lastDigit(100, 2), 0);
  assert.equal(lastDigit(0.123, 3), 3);
  assert.equal(lastDigit("1234.50", 2), 0);
});

test("lastDigit rejeita entradas inválidas", () => {
  assert.throws(() => lastDigit(NaN, 2), TypeError);
  assert.throws(() => lastDigit(Infinity, 2), TypeError);
  assert.throws(() => lastDigit("", 2), TypeError);
  assert.throws(() => lastDigit("abc", 2), TypeError);
  assert.throws(() => lastDigit(1.23, -1), RangeError);
  assert.throws(() => lastDigit(1.23, 2.5), RangeError);
  assert.throws(() => lastDigit(1.23, 9), RangeError);
});

test("countDigits conta certo", () => {
  const digits = [1, 1, 2, 3, 3, 3, 9, 0, 0, 0];
  const c = countDigits(digits);
  assert.equal(c.reduce((a, b) => a + b, 0), digits.length);
  assert.deepEqual(c, [3, 2, 1, 3, 0, 0, 0, 0, 0, 1]);
});

test("countDigits rejeita dígitos inválidos", () => {
  assert.throws(() => countDigits([1, 10]), RangeError);
  assert.throws(() => countDigits([-1]), RangeError);
  assert.throws(() => countDigits([1.5]), RangeError);
});

test("percentages soma 100 e sem dados devolve zeros", () => {
  const p = percentages(countDigits([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
  assert.ok(p.every((x) => Math.abs(x - 10) < 1e-9));
  assert.deepEqual(percentages(countDigits([])), new Array(10).fill(0));
});

test("desvio e cor: azul acima de 10%, vermelho abaixo", () => {
  assert.deepEqual(deviationFromExpected([14, 10, 6]), [4, 0, -4]);
  assert.equal(deviationColor(4), "blue");
  assert.equal(deviationColor(0), "neutral");
  assert.equal(deviationColor(-4), "red");
});

test("TickWindow mantém no máximo 500", () => {
  const w = new TickWindow();
  for (let i = 0; i < 600; i++) w.push(i % 10);
  assert.equal(w.size, 500);
  assert.ok(w.stats(500).counts.every((c) => c === 50));
});

test("stats(100) tem 100 ticks e soma 100", () => {
  const w = new TickWindow();
  for (let i = 0; i < 300; i++) w.push((i * 7) % 10);
  const s = w.stats(100);
  assert.equal(s.total, 100);
  assert.equal(s.ready, true);
  assert.equal(s.counts.reduce((a, b) => a + b, 0), 100);
});

test("janela incompleta não está ready", () => {
  const w = new TickWindow();
  for (let i = 0; i < 40; i++) w.push(i % 10);
  assert.equal(w.stats(100).ready, false);
});

test("last(0) é rejeitado", () => {
  const w = new TickWindow();
  w.push(1);
  assert.throws(() => w.last(0), RangeError);
  assert.throws(() => w.last(-3), RangeError);
});

test("last e recent respeitam a ordem", () => {
  const w = new TickWindow();
  [1, 2, 3, 4, 5].forEach((d) => w.push(d));
  assert.deepEqual(w.last(3), [3, 4, 5]);
  assert.deepEqual(w.recent(3), [5, 4, 3]);
});
