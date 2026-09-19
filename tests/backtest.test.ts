import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_HISTORY,
  makeRule,
  summarize,
  runBacktest,
  baselineRule,
  dominantDigitMatch,
  absentDigitMatch,
  parityStreak,
  walkForward,
} from "../src/core/backtest.ts";
import type { Rule } from "../src/core/backtest.ts";

function close(actual: number, expected: number, tol: number): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} não está perto de ${expected}`);
}

// Gerador pseudoaleatório com semente (resultados repetíveis).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDigits(seed: number, n: number): number[] {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(r() * 10));
}

// Dados com um padrão plantado: depois de 3 dígitos com a mesma paridade, tende a vir a paridade oposta.
function plantedDigits(seed: number, n: number): number[] {
  const r = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let wantOpposite = false;
    if (i >= 3) {
      const p = out[i - 1]! % 2;
      if (out[i - 2]! % 2 === p && out[i - 3]! % 2 === p) wantOpposite = r() < 0.75;
    }
    let d = Math.floor(r() * 10);
    if (wantOpposite) d = Math.floor(r() * 5) * 2 + (1 - (out[i - 1]! % 2));
    out.push(d);
  }
  return out;
}

function parityCandidates(returnRate: number): Rule[] {
  const rules: Rule[] = [];
  for (const length of [2, 3, 4, 5, 6]) {
    for (const follow of [true, false]) rules.push(parityStreak({ length, follow, returnRate }));
  }
  return rules;
}

test("summarize: valores conhecidos", () => {
  const m = summarize([true, true, false, false, false, true], 0.8);
  assert.equal(m.trades, 6);
  assert.equal(m.wins, 3);
  assert.equal(m.losses, 3);
  close(m.netUnits, -0.6, 1e-12);
  close(m.maxDrawdown, 3.0, 1e-12);
  assert.equal(m.longestLosingStreak, 3);
  close(m.profitFactor!, 0.8, 1e-12);
  close(m.stdDev, 0.9859, 1e-4);
  assert.ok(m.evaluation !== null);
});

test("summarize: sem operações e sem perdas", () => {
  const vazio = summarize([], 0.8);
  assert.equal(vazio.trades, 0);
  assert.equal(vazio.winRate, 0);
  assert.equal(vazio.evaluation, null);
  assert.equal(vazio.profitFactor, null);
  assert.equal(vazio.stdDev, 0);
  const tudoWin = summarize([true, true, true], 0.5);
  assert.equal(tudoWin.profitFactor, null);
  assert.equal(tudoWin.longestLosingStreak, 0);
  assert.equal(tudoWin.maxDrawdown, 0);
  assert.throws(() => summarize([true], 0), RangeError);
});

test("stake fixa: cada operação vale +returnRate ou -1, nada mais (sem martingale)", () => {
  const digits = randomDigits(7, 2000);
  const r = 0.9;
  const { metrics } = runBacktest(digits, baselineRule({ type: "even" }, r));
  close(metrics.netUnits, metrics.wins * r - metrics.losses, 1e-9);
  assert.equal(metrics.wins + metrics.losses, metrics.trades);
});

test("sem olhar para o futuro: a regra só vê dígitos anteriores ao tick", () => {
  const digits = Array.from({ length: 40 }, (_, i) => i % 10);
  const vistos: number[][] = [];
  const espia = makeRule("espia", 0.9, (history) => {
    vistos.push([...history]);
    return null;
  });
  runBacktest(digits, espia);
  assert.equal(vistos.length, digits.length);
  vistos.forEach((h, t) => {
    assert.equal(h.length, t);
    if (t > 0) assert.equal(h[t - 1], digits[t - 1]);
  });
});

test("o histórico visível é limitado a 500 dígitos", () => {
  const digits = randomDigits(3, 900);
  let maior = 0;
  const regra = makeRule("mede", 0.9, (h) => {
    if (h.length > maior) maior = h.length;
    return null;
  });
  runBacktest(digits, regra);
  assert.equal(maior, MAX_HISTORY);
});

test("intervalos e entradas inválidas", () => {
  const digits = randomDigits(1, 100);
  const regra = baselineRule({ type: "even" }, 0.9);
  assert.equal(runBacktest(digits, regra, { start: 50, end: 50 }).metrics.trades, 0);
  assert.equal(runBacktest(digits, regra, { start: 50, end: 60 }).metrics.trades, 10);
  assert.throws(() => runBacktest(digits, regra, { start: -1 }), RangeError);
  assert.throws(() => runBacktest(digits, regra, { end: 101 }), RangeError);
  assert.throws(() => runBacktest(digits, regra, { start: 60, end: 50 }), RangeError);
  assert.throws(() => runBacktest([1, 2, 10], regra), RangeError);
  assert.throws(() => makeRule("x", -1, () => null), RangeError);
});

test("dominantDigitMatch", () => {
  const history = [6, 6, 6, 6, 6, 6, 6, 6, 1, 2, 3, 4, 5, 7, 8, 9, 0, 1, 2, 3];
  assert.deepEqual(dominantDigitMatch({ window: 20, minPct: 40, returnRate: 8 }).decide(history), {
    type: "match",
    digit: 6,
  });
  assert.equal(dominantDigitMatch({ window: 20, minPct: 50, returnRate: 8 }).decide(history), null);
  assert.equal(dominantDigitMatch({ window: 30, minPct: 10, returnRate: 8 }).decide(history), null);
  assert.throws(() => dominantDigitMatch({ window: 0, minPct: 20, returnRate: 8 }), RangeError);
  assert.throws(() => dominantDigitMatch({ window: 501, minPct: 20, returnRate: 8 }), RangeError);
  assert.throws(() => dominantDigitMatch({ window: 10, minPct: 101, returnRate: 8 }), RangeError);
});

test("absentDigitMatch", () => {
  const semTres = [0, 1, 2, 4, 5, 6, 7, 8, 9, 0];
  assert.deepEqual(absentDigitMatch({ absentTicks: 10, returnRate: 8 }).decide(semTres), {
    type: "match",
    digit: 3,
  });
  const completo = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.equal(absentDigitMatch({ absentTicks: 10, returnRate: 8 }).decide(completo), null);
  assert.equal(absentDigitMatch({ absentTicks: 20, returnRate: 8 }).decide(completo), null);
});

test("parityStreak", () => {
  const pares = [1, 2, 4, 6];
  assert.deepEqual(parityStreak({ length: 3, follow: true, returnRate: 0.9 }).decide(pares), { type: "even" });
  assert.deepEqual(parityStreak({ length: 3, follow: false, returnRate: 0.9 }).decide(pares), { type: "odd" });
  assert.equal(parityStreak({ length: 3, follow: true, returnRate: 0.9 }).decide([2, 3, 4]), null);
  assert.equal(parityStreak({ length: 5, follow: true, returnRate: 0.9 }).decide(pares), null);
});

test("referência em dados aleatórios ronda os 50%", () => {
  const { metrics } = runBacktest(randomDigits(1, 3000), baselineRule({ type: "even" }, 0.9));
  close(metrics.winRate, 0.5, 0.03);
});

test("walk-forward: estrutura dos blocos e resultados fora da amostra", () => {
  const digits = randomDigits(5, 1000);
  const wf = walkForward(digits, parityCandidates(0.9), { trainSize: 500, testSize: 250 });
  assert.equal(wf.folds.length, 2);
  assert.deepEqual(
    wf.folds.map((f) => [f.trainStart, f.testStart, f.testEnd]),
    [
      [0, 500, 750],
      [250, 750, 1000],
    ],
  );
  const somaTeste = wf.folds.reduce((s, f) => s + (f.test?.trades ?? 0), 0);
  assert.equal(wf.oosOutcomes.length, somaTeste);
  assert.equal(wf.oos.trades, somaTeste);
});

test("walk-forward: sem regra válida = NO TRADE", () => {
  const nunca = makeRule("nunca", 0.9, () => null);
  const wf = walkForward(randomDigits(2, 1000), [nunca], { trainSize: 500, testSize: 250 });
  assert.ok(wf.folds.every((f) => f.chosen === null));
  assert.equal(wf.oos.trades, 0);
});

test("walk-forward: entradas inválidas", () => {
  const digits = randomDigits(2, 1000);
  assert.throws(() => walkForward(digits, [], { trainSize: 500, testSize: 250 }), RangeError);
  const misto = [baselineRule({ type: "even" }, 0.9), baselineRule({ type: "odd" }, 0.8)];
  assert.throws(() => walkForward(digits, misto, { trainSize: 500, testSize: 250 }), RangeError);
  assert.throws(() => walkForward(digits, misto.slice(0, 1), { trainSize: 0, testSize: 250 }), RangeError);
});

test("sobreajuste: em dados aleatórios o treino parece bom mas fora da amostra não há edge", () => {
  let significativos = 0;
  let somaTreino = 0;
  let somaTeste = 0;
  let blocos = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const wf = walkForward(randomDigits(seed, 3000), parityCandidates(0.9), {
      trainSize: 500,
      testSize: 250,
    });
    if (wf.oos.evaluation !== null && wf.oos.evaluation.pValue < 0.05) significativos += 1;
    for (const f of wf.folds) {
      if (f.train && f.test && f.test.trades > 0) {
        somaTreino += f.train.winRate;
        somaTeste += f.test.winRate;
        blocos += 1;
      }
    }
  }
  assert.ok(significativos <= 3, `${significativos} de 20 significativos`);
  const mediaTreino = somaTreino / blocos;
  const mediaTeste = somaTeste / blocos;
  assert.ok(mediaTreino > mediaTeste + 0.02, `treino ${mediaTreino} vs teste ${mediaTeste}`);
  close(mediaTeste, 0.5, 0.03);
});

test("o método deteta um padrão real plantado (não é cego)", () => {
  const wf = walkForward(plantedDigits(1, 6000), parityCandidates(0.9), { trainSize: 1000, testSize: 500 });
  assert.ok(wf.oos.trades > 500);
  assert.ok(wf.oos.winRate > 0.6);
  assert.ok(wf.oos.evaluation!.pValue < 0.001);
});
