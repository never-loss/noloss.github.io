import { test } from "node:test";
import assert from "node:assert/strict";
import { feasible, signalShare, maxStopFromMultiplier } from "../src/core/feasible.ts";
import { runExecutableResearch, formatShares } from "../src/core/executable-research.ts";
import { strategyLibrary, emaCross } from "../src/core/strategies.ts";
import type { Strategy, Signal } from "../src/core/strategies.ts";
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

/** vol = desvio-padrão do retorno por vela (0,002 = 0,2%). */
function walk(seed: number, n: number, vol: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + gauss(r) * vol);
    const high = Math.max(open, close) * (1 + Math.abs(gauss(r)) * vol * 0.35);
    const low = Math.min(open, close) * (1 - Math.abs(gauss(r)) * vol * 0.35);
    out.push({ epoch: 1_700_000_000 + i * 300, open, high, low, close });
    price = close;
  }
  return out;
}

const sempre = (dir: 1 | -1): Strategy => ({
  name: "sempre",
  signals: (c) => new Array<Signal>(c.length).fill(dir),
});

test("multiplicador mínimo dá o stop máximo executável", () => {
  assert.equal(maxStopFromMultiplier(100), 0.01);
  assert.equal(maxStopFromMultiplier(800), 0.00125);
  assert.throws(() => maxStopFromMultiplier(0), RangeError);
});

test("mercado calmo: os sinais passam; mercado agitado: são todos descartados", () => {
  const calmo = walk(1, 400, 0.002);
  const agitado = walk(1, 400, 0.02);
  const opts = { slAtr: 1.5, maxStopFraction: 0.01 };
  const a = feasible(sempre(1), opts).signals(calmo);
  const b = feasible(sempre(1), opts).signals(agitado);
  assert.ok(a.filter((x) => x !== 0).length > 300);
  assert.equal(b.filter((x) => x !== 0).length, 0);
});

test("sem ATR ainda (início) não há sinal executável", () => {
  const s = feasible(sempre(-1), { slAtr: 1.5, maxStopFraction: 0.05 }).signals(walk(2, 100, 0.002));
  assert.ok(s.slice(0, 13).every((x) => x === 0));
  assert.equal(s[50], -1);
});

test("o filtro nunca usa o futuro: os sinais de um prefixo não mudam", () => {
  const candles = walk(3, 400, 0.004);
  const opts = { slAtr: 1.5, maxStopFraction: 0.01 };
  for (const base of strategyLibrary()) {
    const f = feasible(base, opts);
    const full = f.signals(candles);
    for (const k of [150, 250, 350]) {
      assert.deepEqual(f.signals(candles.slice(0, k)), full.slice(0, k), `${base.name} (k=${k})`);
    }
  }
});

test("o filtro só remove sinais, nunca cria nem inverte", () => {
  const candles = walk(4, 500, 0.005);
  const base = emaCross({ fast: 9, slow: 21 });
  const antes = base.signals(candles);
  const depois = feasible(base, { slAtr: 1.5, maxStopFraction: 0.01 }).signals(candles);
  depois.forEach((d, i) => assert.ok(d === 0 || d === antes[i]));
});

test("opções inválidas são rejeitadas", () => {
  assert.throws(() => feasible(sempre(1), { slAtr: 0, maxStopFraction: 0.01 }), RangeError);
  assert.throws(() => feasible(sempre(1), { slAtr: 1.5, maxStopFraction: 0 }), RangeError);
  assert.throws(() => feasible(sempre(1), { slAtr: 1.5, maxStopFraction: NaN }), RangeError);
});

test("quota de sinais executáveis", () => {
  const opts = { slAtr: 1.5, maxStopFraction: 0.01 };
  const calmo = signalShare([sempre(1)], walk(5, 300, 0.002), opts);
  assert.equal(calmo.total, 300);
  assert.ok(calmo.kept > 250);
  const agitado = signalShare([sempre(1)], walk(5, 300, 0.02), opts);
  assert.equal(agitado.kept, 0);
});

const OPTS = { slAtr: 1.5, tpR: 2, maxBars: 24, trainSize: 1500, testSize: 500, minMultiplier: 100 };

test("pesquisa executável: mercado agitado fica em NO TRADE, mercado calmo pode operar", () => {
  const data = { cryBTCUSD: walk(11, 4000, 0.02), frxEURUSD: walk(12, 4000, 0.002) };
  const r = runExecutableResearch(data, OPTS);
  assert.equal(r.maxStopFraction, 0.01);
  const cripto = r.groups.find((g) => g.kind === "crypto")!.reports[0]!;
  assert.equal(cripto.walk.oos.trades, 0);
  assert.equal(r.shares["cryBTCUSD"]!.kept, 0);
  const forex = r.groups.find((g) => g.kind === "forex")!.reports[0]!;
  assert.ok(forex.walk.oos.trades > 20);
  assert.ok(r.shares["frxEURUSD"]!.kept > 0);
});

test("multiplicador mínimo maior estreita o que é executável", () => {
  const data = { frxEURUSD: walk(13, 4000, 0.002) };
  const a = runExecutableResearch(data, { ...OPTS, minMultiplier: 100 });
  const b = runExecutableResearch(data, { ...OPTS, minMultiplier: 800 });
  assert.ok(b.shares["frxEURUSD"]!.kept < a.shares["frxEURUSD"]!.kept);
});

test("erros e relatório de viabilidade", () => {
  assert.throws(() => runExecutableResearch({}, OPTS), RangeError);
  assert.throws(() => runExecutableResearch({ R_100: walk(1, 4000, 0.002) }, OPTS), RangeError);
  assert.throws(() => runExecutableResearch({ frxEURUSD: walk(1, 4000, 0.002) }, { ...OPTS, minMultiplier: 0 }), RangeError);
  const texto = formatShares(runExecutableResearch({ frxEURUSD: walk(14, 4000, 0.002) }, OPTS));
  assert.ok(texto.includes("VIABILIDADE"));
  assert.ok(texto.includes("frxEURUSD"));
  assert.ok(texto.includes("1.00%"));
});
