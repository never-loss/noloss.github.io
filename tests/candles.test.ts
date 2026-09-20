import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emaCross,
  rsiReversion,
  confluence,
  strategyLibrary,
} from "../src/core/strategies.ts";
import type { Strategy, Signal } from "../src/core/strategies.ts";
import {
  runCandleBacktest,
  summarizeR,
  expectancyPValue,
  walkForwardCandles,
} from "../src/core/candle-backtest.ts";
import type { CandleBacktestOptions } from "../src/core/candle-backtest.ts";
import type { Candle } from "../src/core/market-data.ts";

function close(actual: number | null, expected: number, tol = 1e-9): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `${actual} não está perto de ${expected}`);
}

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

function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Passeio aleatório de velas; phi > 0 planta momentum (autocorrelação dos retornos). */
function walk(seed: number, n: number, phi: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const ret = phi * prev + gauss(r) * 0.002;
    prev = ret;
    const open = price;
    const close2 = open * (1 + ret);
    const high = Math.max(open, close2) * (1 + Math.abs(gauss(r)) * 0.0007);
    const low = Math.min(open, close2) * (1 - Math.abs(gauss(r)) * 0.0007);
    out.push({ epoch: 1_700_000_000 + i * 300, open, high, low, close: close2 });
    price = close2;
  }
  return out;
}

function fromCloses(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    epoch: i,
    open: i === 0 ? c : closes[i - 1]!,
    high: Math.max(c, i === 0 ? c : closes[i - 1]!) + 0.1,
    low: Math.min(c, i === 0 ? c : closes[i - 1]!) - 0.1,
    close: c,
  }));
}

// ---------- Estratégias ----------

test("todas as estratégias: tamanho certo, só -1/0/1 e sem olhar para o futuro", () => {
  const candles = walk(4, 320, 0);
  for (const s of strategyLibrary()) {
    const full = s.signals(candles);
    assert.equal(full.length, candles.length, s.name);
    assert.ok(full.every((x) => x === -1 || x === 0 || x === 1), s.name);
    for (const k of [150, 220, 300]) {
      const prefix = s.signals(candles.slice(0, k));
      assert.deepEqual(prefix, full.slice(0, k), `${s.name}: sinais mudam com o futuro (k=${k})`);
    }
  }
});

test("a biblioteca tem estratégias variadas e nomes únicos", () => {
  const lib = strategyLibrary();
  assert.ok(lib.length >= 15);
  assert.equal(new Set(lib.map((s) => s.name)).size, lib.length);
  assert.ok(lib.some((s) => s.name.startsWith("confluencia")));
});

test("cruzamento de EMAs: compra na viragem para cima e vende na viragem para baixo", () => {
  const closes = [
    ...Array.from({ length: 60 }, (_, i) => 100 - i * 0.5),
    ...Array.from({ length: 60 }, (_, i) => 70 + i * 1),
    ...Array.from({ length: 60 }, (_, i) => 130 - i * 0.7),
  ];
  const sig = emaCross({ fast: 5, slow: 10 }).signals(fromCloses(closes));
  const longs = sig.flatMap((x, i) => (x === 1 ? [i] : []));
  const shorts = sig.flatMap((x, i) => (x === -1 ? [i] : []));
  assert.equal(longs.length, 1);
  assert.equal(shorts.length, 1);
  assert.ok(longs[0]! > 60 && longs[0]! < 80);
  assert.ok(shorts[0]! > longs[0]!);
});

test("RSI de reversão: compra quando volta a subir acima do nível baixo", () => {
  const closes = [
    ...Array.from({ length: 30 }, () => 100),
    ...Array.from({ length: 15 }, (_, i) => 100 - i * 2),
    ...Array.from({ length: 15 }, (_, i) => 72 + i * 2),
  ];
  const sig = rsiReversion({ period: 14, low: 30, high: 70 }).signals(fromCloses(closes));
  const longs = sig.flatMap((x, i) => (x === 1 ? [i] : []));
  assert.ok(longs.length >= 1);
  assert.ok(longs[0]! >= 44);
});

test("confluência: concordância dá sinal e oposição anula", () => {
  const make = (name: string, at: Record<number, Signal>): Strategy => ({
    name,
    signals: (c) => Array.from({ length: c.length }, (_, i) => at[i] ?? 0),
  });
  const candles = fromCloses(new Array(30).fill(100));
  const a = make("a", { 10: 1 });
  const b = make("b", { 11: 1 });
  const conf = confluence({ strategies: [a, b], minAgree: 2, hold: 3 }).signals(candles);
  assert.deepEqual(conf.flatMap((x, i) => (x === 1 ? [i] : [])), [11, 12]);
  const c = make("c", { 11: -1 });
  const opostas = confluence({ strategies: [a, c], minAgree: 2, hold: 3 }).signals(candles);
  assert.ok(opostas.every((x) => x === 0));
});

test("estratégias com opções inválidas são rejeitadas", () => {
  assert.throws(() => emaCross({ fast: 20, slow: 10 }), RangeError);
  assert.throws(() => rsiReversion({ period: 14, low: 70, high: 30 }), RangeError);
  const a: Strategy = { name: "a", signals: () => [] };
  assert.throws(() => confluence({ strategies: [a], minAgree: 2, hold: 3 }), RangeError);
  assert.throws(() => confluence({ strategies: [a, a], minAgree: 3, hold: 3 }), RangeError);
  assert.throws(() => confluence({ strategies: [a, a], minAgree: 2, hold: 0 }), RangeError);
});

// ---------- Backtest de velas ----------

const BASE: CandleBacktestOptions = { slAtr: 1, tpR: 2, maxBars: 24, costFraction: 0 };

/** 40 velas planas com amplitude 2 (ATR = 2); as alterações são aplicadas por cima. */
function flat(changes: Record<number, Partial<Candle>> = {}): Candle[] {
  return Array.from({ length: 40 }, (_, i) => ({
    epoch: i, open: 100, high: 101, low: 99, close: 100, ...(changes[i] ?? {}),
  }));
}

function at(index: number, dir: 1 | -1): Strategy {
  return { name: "manual", signals: (c) => Array.from({ length: c.length }, (_, i) => (i === index ? dir : 0)) as Signal[] };
}

test("compra: alvo atingido dá +2R", () => {
  const r = runCandleBacktest(flat({ 22: { high: 104 } }), at(20, 1), BASE);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0]!;
  assert.equal(t.entryIndex, 21);
  assert.equal(t.exitIndex, 22);
  assert.equal(t.reason, "tp");
  close(t.r, 2);
});

test("compra: stop atingido dá -1R", () => {
  const r = runCandleBacktest(flat({ 22: { low: 98 } }), at(20, 1), BASE);
  assert.equal(r.trades[0]!.reason, "sl");
  close(r.trades[0]!.r, -1);
});

test("stop e alvo na mesma vela: assume-se o pior (stop)", () => {
  const r = runCandleBacktest(flat({ 22: { high: 104, low: 98 } }), at(20, 1), BASE);
  assert.equal(r.trades[0]!.reason, "sl");
  close(r.trades[0]!.r, -1);
});

test("salto (gap) para além do stop dá pior que -1R", () => {
  const r = runCandleBacktest(flat({ 22: { open: 97, high: 97.5, low: 96.5, close: 97 } }), at(20, 1), BASE);
  assert.equal(r.trades[0]!.reason, "sl");
  close(r.trades[0]!.r, -1.5);
});

test("saída por tempo fecha no fecho da vela", () => {
  const r = runCandleBacktest(flat({ 24: { close: 101 } }), at(20, 1), { ...BASE, maxBars: 3 });
  const t = r.trades[0]!;
  assert.equal(t.reason, "time");
  assert.equal(t.exitIndex, 24);
  close(t.r, 0.5);
});

test("os custos descontam do resultado", () => {
  const r = runCandleBacktest(flat({ 22: { high: 104 } }), at(20, 1), { ...BASE, costFraction: 0.001 });
  close(r.trades[0]!.r, 2 - 0.05); // 100 x 0,001 / 2 = 0,05R
});

test("venda: espelho da compra", () => {
  const tp = runCandleBacktest(flat({ 22: { low: 96 } }), at(20, -1), BASE);
  assert.equal(tp.trades[0]!.reason, "tp");
  close(tp.trades[0]!.r, 2);
  const sl = runCandleBacktest(flat({ 22: { high: 102 } }), at(20, -1), BASE);
  assert.equal(sl.trades[0]!.reason, "sl");
  close(sl.trades[0]!.r, -1);
});

test("a entrada é na abertura da vela seguinte ao sinal e pode sair na própria vela de entrada", () => {
  const r = runCandleBacktest(flat({ 21: { open: 100.5, low: 98.4 } }), at(20, 1), BASE);
  const t = r.trades[0]!;
  assert.equal(t.entryIndex, 21);
  assert.equal(t.entry, 100.5);
  assert.equal(t.exitIndex, 21);
  assert.equal(t.reason, "sl");
});

test("filtro de direção", () => {
  const candles = flat({ 22: { low: 96 } });
  assert.equal(runCandleBacktest(candles, at(20, -1), { ...BASE, directions: "long" }).trades.length, 0);
  assert.equal(runCandleBacktest(candles, at(20, -1), { ...BASE, directions: "short" }).trades.length, 1);
});

test("o fim do intervalo é uma fronteira: nada usa velas depois dele", () => {
  const candles = flat({ 30: { high: 110 } });
  const r = runCandleBacktest(candles, at(20, 1), { ...BASE, end: 23 });
  const t = r.trades[0]!;
  assert.equal(t.reason, "time");
  assert.equal(t.exitIndex, 22);
});

test("sem sobreposição de operações e sem ATR o bot não entra", () => {
  const candles = walk(5, 1500, 0);
  const { trades } = runCandleBacktest(candles, emaCross({ fast: 9, slow: 21 }), {
    slAtr: 1.5, tpR: 2, maxBars: 24, costFraction: 0.0002,
  });
  assert.ok(trades.length > 20);
  trades.forEach((t, k) => {
    if (k > 0) assert.ok(t.entryIndex > trades[k - 1]!.exitIndex);
  });
  const cedo = runCandleBacktest(flat(), at(5, 1), BASE); // ATR ainda não existe na vela 5
  assert.equal(cedo.trades.length, 0);
});

test("opções e intervalos inválidos", () => {
  const c = flat();
  assert.throws(() => runCandleBacktest(c, at(20, 1), { ...BASE, slAtr: 0 }), RangeError);
  assert.throws(() => runCandleBacktest(c, at(20, 1), { ...BASE, tpR: -1 }), RangeError);
  assert.throws(() => runCandleBacktest(c, at(20, 1), { ...BASE, maxBars: 0 }), RangeError);
  assert.throws(() => runCandleBacktest(c, at(20, 1), { ...BASE, costFraction: -0.1 }), RangeError);
  assert.throws(() => runCandleBacktest(c, at(20, 1), { ...BASE, start: 30, end: 20 }), RangeError);
  assert.throws(() => runCandleBacktest(c, at(20, 1), { ...BASE, end: 99 }), RangeError);
  const mau: Strategy = { name: "mau", signals: () => [0, 0] };
  assert.throws(() => runCandleBacktest(c, mau, BASE), RangeError);
});

test("métricas em R: valores conhecidos", () => {
  const m = summarizeR([2, -1, -1, 2, -1]);
  assert.equal(m.trades, 5);
  assert.equal(m.wins, 2);
  close(m.netR, 1);
  close(m.meanR, 0.2);
  close(m.profitFactor, 4 / 3);
  close(m.maxDrawdownR, 2);
  assert.equal(m.longestLosingStreak, 2);
  const vazio = summarizeR([]);
  assert.equal(vazio.trades, 0);
  assert.equal(vazio.pValue, null);
  assert.equal(vazio.profitFactor, null);
});

test("p-value da expectativa", () => {
  assert.equal(expectancyPValue([1]), null);
  assert.equal(expectancyPValue([1, 1, 1, 1]), 0);
  assert.equal(expectancyPValue([-1, -1, -1]), 1);
  close(expectancyPValue([1, -1, 1, -1]), 0.5, 1e-9);
  const forte = expectancyPValue(Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 2 : 0)));
  assert.ok(forte !== null && forte < 1e-6);
});

// ---------- Walk-forward ----------

const WF = { slAtr: 1.5, tpR: 2, maxBars: 24, costFraction: 0.0002, trainSize: 1500, testSize: 500 };

test("walk-forward: estrutura dos blocos", () => {
  const wf = walkForwardCandles(walk(1, 3000, 0), strategyLibrary(), WF);
  assert.deepEqual(
    wf.folds.map((f) => [f.trainStart, f.testStart, f.testEnd]),
    [
      [0, 1500, 2000],
      [500, 2000, 2500],
      [1000, 2500, 3000],
    ],
  );
  assert.equal(wf.oosR.length, wf.oos.trades);
});

test("walk-forward: sem sinais = sem operações fora da amostra", () => {
  const nunca: Strategy = { name: "nunca", signals: (c) => new Array<Signal>(c.length).fill(0) };
  const wf = walkForwardCandles(walk(1, 3000, 0), [nunca], WF);
  assert.ok(wf.folds.every((f) => f.chosen === null));
  assert.equal(wf.oos.trades, 0);
});

test("em passeios aleatórios não há vantagem fora da amostra", () => {
  let significativos = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const wf = walkForwardCandles(walk(seed, 5000, 0), strategyLibrary(), WF);
    if (wf.oos.trades >= 100 && wf.oos.pValue !== null && wf.oos.pValue < 0.01) significativos += 1;
  }
  assert.ok(significativos <= 1, `${significativos} de 8 significativos por sorte`);
});

test("com momentum real plantado, o método deteta a vantagem", () => {
  const wf = walkForwardCandles(walk(2, 5000, 0.5), strategyLibrary(), WF);
  assert.ok(wf.oos.trades >= 100);
  assert.ok(wf.oos.meanR > 0.2);
  assert.ok(wf.oos.pValue !== null && wf.oos.pValue < 0.001);
});

test("walk-forward: entradas inválidas", () => {
  const c = walk(1, 3000, 0);
  assert.throws(() => walkForwardCandles(c, [], WF), RangeError);
  assert.throws(() => walkForwardCandles(c, strategyLibrary(), { ...WF, trainSize: 0 }), RangeError);
  assert.throws(() => walkForwardCandles(c, strategyLibrary(), { ...WF, testSize: 0 }), RangeError);
});
