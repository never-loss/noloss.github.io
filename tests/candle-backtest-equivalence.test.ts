// Equivalência (golden) do walk-forward com sinais/ATR calculados UMA vez vs. o cálculo antigo por bloco.
// Velas sintéticas determinísticas (passeio aleatório com semente) — NÃO são dados reais de mercado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCandleBacktest, walkForwardCandles, prepareBacktest, summarizeR } from "../src/core/candle-backtest.ts";
import type { CandleFold, CandleWalkForwardOptions, CandleWalkForwardResult } from "../src/core/candle-backtest.ts";
import { evaluateCandleGate } from "../src/core/candle-gate.ts";
import { STRATEGY_PRESETS, strategiesForPreset } from "../src/core/strategies.ts";
import type { Strategy } from "../src/core/strategies.ts";
import { feasible } from "../src/core/feasible.ts";
import type { Candle } from "../src/core/market-data.ts";

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
function walk(seed: number, n: number, phi: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const ret = phi * prev + gauss(r) * 0.002;
    prev = ret;
    const open = price;
    const close = open * (1 + ret);
    const high = Math.max(open, close) * (1 + Math.abs(gauss(r)) * 0.0007);
    const low = Math.min(open, close) * (1 - Math.abs(gauss(r)) * 0.0007);
    out.push({ epoch: 1_700_000_000 + i * 300, open, high, low, close });
    price = close;
  }
  return out;
}

/** Implementação de referência = o walk-forward ANTIGO: recalcula sinais e ATR em cada bloco x estratégia. */
function referenceWalkForward(
  candles: readonly Candle[],
  strategies: readonly Strategy[],
  opts: CandleWalkForwardOptions,
): CandleWalkForwardResult {
  const minTrades = opts.minTrainTrades ?? 20;
  const { trainSize, testSize, minTrainTrades: _i, ...base } = opts;
  void _i;
  const folds: CandleFold[] = [];
  const oosR: number[] = [];
  let start = 0;
  let fold = 0;
  while (start + trainSize + testSize <= candles.length) {
    const testStart = start + trainSize;
    const testEnd = testStart + testSize;
    let chosen: Strategy | null = null;
    let chosenTrain = null as ReturnType<typeof summarizeR> | null;
    for (const s of strategies) {
      const m = runCandleBacktest(candles, s, { ...base, start, end: testStart }).metrics;
      if (m.trades < minTrades) continue;
      if (chosenTrain === null || m.netR > chosenTrain.netR) {
        chosen = s;
        chosenTrain = m;
      }
    }
    let test = null as ReturnType<typeof summarizeR> | null;
    if (chosen !== null) {
      const r = runCandleBacktest(candles, chosen, { ...base, start: testStart, end: testEnd });
      oosR.push(...r.trades.map((t) => t.r));
      test = r.metrics;
    }
    folds.push({ fold, trainStart: start, testStart, testEnd, chosen: chosen?.name ?? null, train: chosenTrain, test });
    fold += 1;
    start += testSize;
  }
  return { folds, oosR, oos: summarizeR(oosR) };
}

const SEEDS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [2, 0.4],
  [3, -0.2],
];

for (const preset of STRATEGY_PRESETS) {
  const g = preset.preferredGate ?? {};
  const strategies = strategiesForPreset(preset.id).map((s) => feasible(s, { slAtr: g.slAtr ?? 1.5, maxStopFraction: 1 / 100 }));
  const opts: CandleWalkForwardOptions = {
    slAtr: g.slAtr ?? 1.5,
    tpR: g.tpR ?? 2,
    maxBars: g.maxBars ?? 24,
    costFraction: 0.001,
    trainSize: 600,
    testSize: 300,
  };
  for (const [seed, phi] of SEEDS) {
    test(`walk-forward idêntico ao cálculo antigo: ${preset.id} semente ${seed} (sintético)`, () => {
      const candles = walk(seed, 2400, phi);
      const a = walkForwardCandles(candles, strategies, opts);
      const b = referenceWalkForward(candles, strategies, opts);
      assert.deepStrictEqual(a, b); // inclui cada R OOS, bit a bit
      assert.ok(a.folds.length >= 5);
    });
  }
}

test("evaluateCandleGate: veredicto igual ao do cálculo antigo (golden sintético)", () => {
  // Valores obtidos com o código ANTERIOR ao PR (3500 velas, treino 1000 / teste 500, sintético).
  const g = STRATEGY_PRESETS.find((p) => p.id === "blitz_zero")!;
  const gp = g.preferredGate!;
  const strategies = strategiesForPreset("blitz_zero").map((s) => feasible(s, { slAtr: gp.slAtr ?? 1.5, maxStopFraction: 1 / 100 }));
  const o = { slAtr: gp.slAtr!, tpR: gp.tpR!, maxBars: gp.maxBars!, costFraction: 0.001, trainSize: 1000, testSize: 500, minLabel: gp.minLabel! };
  const ev = evaluateCandleGate(walk(2, 3500, 0.4), strategies, o);
  assert.equal(ev.allowed, true);
  assert.equal(ev.oosTrades, 90);
  const ev1 = evaluateCandleGate(walk(1, 3500, 0), strategies, o);
  assert.equal(ev1.allowed, false);
  assert.equal(ev1.oosTrades, 38);
});

test("prepareBacktest reutilizado dá o mesmo resultado que o cálculo directo, em qualquer intervalo", () => {
  const candles = walk(7, 1500, 0.3);
  const s = strategiesForPreset("lucro_rapido")[0]!;
  const o = { slAtr: 1.2, tpR: 1.5, maxBars: 12, costFraction: 0.001 };
  const prep = prepareBacktest(candles, s, 14);
  for (const [start, end] of [[0, 1500], [0, 600], [600, 900], [1200, 1500], [10, 11]] as const) {
    assert.deepStrictEqual(
      runCandleBacktest(candles, s, { ...o, start, end }, prep),
      runCandleBacktest(candles, s, { ...o, start, end }),
    );
  }
});

test("prepareBacktest com tamanho errado é rejeitado (sem resultados silenciosamente errados)", () => {
  const candles = walk(7, 300, 0);
  const s = strategiesForPreset("lucro_rapido")[0]!;
  const o = { slAtr: 1.2, tpR: 1.5, maxBars: 12, costFraction: 0.001 };
  const prep = prepareBacktest(candles.slice(0, 200), s, 14);
  assert.throws(() => runCandleBacktest(candles, s, o, prep), RangeError);
});

test("sem olhar para o futuro: o veredicto de um bloco não muda se se acrescentarem velas depois", () => {
  const candles = walk(5, 3000, 0.2);
  const strategies = strategiesForPreset("lucro_rapido");
  const o: CandleWalkForwardOptions = { slAtr: 1.2, tpR: 1.5, maxBars: 12, costFraction: 0.001, trainSize: 600, testSize: 300 };
  const short = walkForwardCandles(candles.slice(0, 2100), strategies, o);
  const long = walkForwardCandles(candles, strategies, o);
  assert.ok(short.folds.length < long.folds.length);
  for (const f of short.folds) assert.deepStrictEqual(long.folds[f.fold], f);
});
