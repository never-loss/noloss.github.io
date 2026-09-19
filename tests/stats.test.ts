import { test } from "node:test";
import assert from "node:assert/strict";
import {
  returnRateFrom,
  breakEvenProbability,
  expectedValue,
  houseEdge,
  didWin,
  uniformWinProbability,
  gammaQ,
  chiSquareUniformity,
  binomialUpperTail,
  wilsonInterval,
  benjaminiHochberg,
  evaluateContract,
  classify,
} from "../src/core/stats.ts";

function close(actual: number, expected: number, tol: number): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} não está perto de ${expected}`);
}

test("retorno e break-even do contrato de 3$ com lucro de 2,46$", () => {
  const r = returnRateFrom(3, 2.46);
  close(r, 0.82, 1e-12);
  close(breakEvenProbability(r), 0.5494505, 1e-6);
});

test("valor esperado e margem da casa a 50%", () => {
  close(expectedValue(0.5, 0.82), -0.09, 1e-12);
  close(houseEdge(0.5, 0.82), 0.09, 1e-12);
});

test("entradas inválidas são rejeitadas", () => {
  assert.throws(() => breakEvenProbability(0), RangeError);
  assert.throws(() => breakEvenProbability(-1), RangeError);
  assert.throws(() => breakEvenProbability(NaN), RangeError);
  assert.throws(() => expectedValue(1.5, 0.8), RangeError);
  assert.throws(() => returnRateFrom(0, 1), RangeError);
});

test("contratos de dígitos: quem ganha e probabilidade uniforme", () => {
  assert.equal(didWin(6, { type: "match", digit: 6 }), true);
  assert.equal(didWin(5, { type: "match", digit: 6 }), false);
  assert.equal(didWin(5, { type: "differs", digit: 6 }), true);
  assert.equal(didWin(9, { type: "over", barrier: 8 }), true);
  assert.equal(didWin(8, { type: "over", barrier: 8 }), false);
  assert.equal(didWin(2, { type: "under", barrier: 3 }), true);
  assert.equal(didWin(0, { type: "even" }), true);
  assert.equal(didWin(7, { type: "odd" }), true);
  assert.equal(uniformWinProbability({ type: "match", digit: 3 }), 0.1);
  assert.equal(uniformWinProbability({ type: "differs", digit: 3 }), 0.9);
  assert.equal(uniformWinProbability({ type: "even" }), 0.5);
  assert.equal(uniformWinProbability({ type: "over", barrier: 4 }), 0.5);
  assert.equal(uniformWinProbability({ type: "under", barrier: 3 }), 0.3);
  assert.throws(() => didWin(10, { type: "even" }), RangeError);
  assert.throws(() => didWin(1, { type: "match", digit: 11 }), RangeError);
});

test("qui-quadrado: valores críticos conhecidos (df = 9)", () => {
  close(gammaQ(4.5, 16.919 / 2), 0.05, 1e-4);
  close(gammaQ(4.5, 21.666 / 2), 0.01, 1e-4);
  assert.equal(gammaQ(4.5, 0), 1);
});

test("qui-quadrado: distribuição perfeita e a do ecrã de exemplo", () => {
  const perfeita = chiSquareUniformity([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  close(perfeita.statistic, 0, 1e-12);
  close(perfeita.pValue, 1, 1e-9);
  const exemplo = chiSquareUniformity([12, 11, 11, 5, 11, 9, 14, 9, 8, 10]);
  close(exemplo.statistic, 5.4, 1e-9);
  assert.equal(exemplo.df, 9);
  close(exemplo.pValue, 0.798, 0.001);
});

test("qui-quadrado rejeita entradas inválidas", () => {
  assert.throws(() => chiSquareUniformity([1, 2, 3]), RangeError);
  assert.throws(() => chiSquareUniformity(new Array(10).fill(0)), RangeError);
  assert.throws(() => chiSquareUniformity([-1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), RangeError);
});

test("binomial: valores exatos conhecidos", () => {
  close(binomialUpperTail(10, 6, 0.5), 386 / 1024, 1e-12);
  close(binomialUpperTail(100, 14, 0.1), 0.12388, 1e-4);
  assert.equal(binomialUpperTail(10, 0, 0.3), 1);
  assert.equal(binomialUpperTail(10, 11, 0.3), 0);
  assert.equal(binomialUpperTail(10, 5, 0), 0);
  assert.equal(binomialUpperTail(10, 5, 1), 1);
});

test("Wilson: intervalos conhecidos e limites", () => {
  const a = wilsonInterval(50, 100);
  close(a.low, 0.4038, 1e-4);
  close(a.high, 0.5962, 1e-4);
  const b = wilsonInterval(0, 100);
  assert.equal(b.low, 0);
  assert.throws(() => wilsonInterval(5, 0), RangeError);
  assert.throws(() => wilsonInterval(11, 10), RangeError);
});

test("Benjamini-Hochberg: exemplo conhecido", () => {
  const adj = benjaminiHochberg([0.01, 0.04, 0.03, 0.005]);
  assert.deepEqual(adj.map((x) => Number(x.toFixed(6))), [0.02, 0.04, 0.04, 0.02]);
  const p = [0.2, 0.001, 0.5, 0.03];
  const q = benjaminiHochberg(p);
  q.forEach((v, i) => assert.ok(v >= p[i]! && v <= 1));
  assert.deepEqual(benjaminiHochberg([]), []);
  assert.throws(() => benjaminiHochberg([0.5, 1.2]), RangeError);
});

test("um p-value de 0,04 entre 10 testes não sobrevive à correção", () => {
  const raw = [0.04, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.3, 0.4, 0.2];
  const adj = benjaminiHochberg(raw);
  assert.ok(raw[0]! < 0.05);
  assert.ok(adj[0]! >= 0.05);
  close(adj[0]!, 0.4, 1e-12);
});

test("avaliar contrato: 55 vitórias em 100 com retorno 0,82 não prova nada", () => {
  const e = evaluateContract(55, 100, 0.82);
  assert.equal(e.n, 100);
  close(e.winRate, 0.55, 1e-12);
  close(e.breakEven, 0.54945, 1e-5);
  assert.ok(e.ci95.low < e.breakEven && e.breakEven < e.ci95.high);
  assert.ok(e.pValue > 0.4);
});

test("classificação respeita amostra mínima e correção", () => {
  assert.equal(classify(50, 0.001), "INSUFFICIENT");
  assert.equal(classify(500, 0.2), "NO_EVIDENCE");
  assert.equal(classify(500, 0.01), "PRELIMINARY");
  assert.equal(classify(5000, 0.01), "EVIDENCE");
});
