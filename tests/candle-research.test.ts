import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCandlePages, nextCandleEnd } from "../src/core/candle-pages.ts";
import { runCandleResearch, formatCandleReport } from "../src/core/candle-research.ts";
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

const OPTS = {
  slAtr: 1.5,
  tpR: 2,
  maxBars: 24,
  costFor: (s: string) => (s.startsWith("cry") ? 0.001 : 0.0001),
  trainSize: 1500,
  testSize: 500,
};

const c = (epoch: number, price: number): Candle => ({ epoch, open: price, high: price + 1, low: price - 1, close: price });

test("junta páginas de velas: ordena e remove repetidas", () => {
  const recente = [c(30, 3), c(40, 4), c(50, 5)];
  const antiga = [c(10, 1), c(20, 2), c(30, 3)];
  const m = mergeCandlePages([recente, antiga]);
  assert.deepEqual(m.map((x) => x.epoch), [10, 20, 30, 40, 50]);
  assert.deepEqual(mergeCandlePages([]), []);
});

test("velas inválidas numa página são rejeitadas", () => {
  assert.throws(() => mergeCandlePages([[{ epoch: 1, open: NaN, high: 1, low: 1, close: 1 }]]), RangeError);
});

test("fim do próximo pedido de velas", () => {
  assert.equal(nextCandleEnd([c(100, 1), c(105, 1)]), 99);
  assert.equal(nextCandleEnd([c(105, 1), c(100, 1)]), 99);
  assert.equal(nextCandleEnd([]), null);
});

test("pesquisa em passeios aleatórios: sem vantagem em nenhum símbolo", () => {
  const data = { cryAAA: walk(11, 4000, 0), frxBBB: walk(12, 4000, 0), frxCCC: walk(13, 4000, 0) };
  const reports = runCandleResearch(data, OPTS);
  assert.equal(reports.length, 3);
  for (const r of reports) {
    assert.ok(r.label !== "EVIDENCE" && r.label !== "PRELIMINARY", `${r.symbol}: ${r.label}`);
    assert.equal(r.candles, 4000);
  }
});

test("os custos pioram o resultado face à versão sem custos", () => {
  const reports = runCandleResearch({ cryAAA: walk(14, 4000, 0) }, OPTS);
  const r = reports[0]!;
  assert.ok(r.walk.oos.trades > 50);
  assert.ok(r.noCost.meanR > r.walk.oos.meanR);
});

test("pesquisa encontra momentum real plantado num símbolo (com correção entre símbolos)", () => {
  const data = { cryAAA: walk(15, 5000, 0.5), frxBBB: walk(16, 5000, 0), frxCCC: walk(17, 5000, 0) };
  const reports = runCandleResearch(data, OPTS);
  const a = reports.find((r) => r.symbol === "cryAAA")!;
  assert.ok(a.adjustedP !== null && a.adjustedP < 0.01);
  assert.ok(a.label === "PRELIMINARY" || a.label === "EVIDENCE");
  assert.ok(a.walk.oos.meanR > 0);
  for (const r of reports.filter((x) => x.symbol !== "cryAAA")) {
    assert.ok(r.label !== "EVIDENCE" && r.label !== "PRELIMINARY");
  }
});

test("pesquisa: dados curtos ou vazios são rejeitados", () => {
  assert.throws(() => runCandleResearch({}, OPTS), RangeError);
  assert.throws(() => runCandleResearch({ cryAAA: walk(1, 1000, 0) }, OPTS), RangeError);
});

test("relatório traz custos, aviso e rótulos", () => {
  const texto = formatCandleReport(runCandleResearch({ cryAAA: walk(18, 4000, 0) }, OPTS), OPTS);
  assert.ok(texto.includes("PESQUISA EM VELAS"));
  assert.ok(texto.includes("cryAAA"));
  assert.ok(texto.includes("custo assumido"));
  assert.ok(texto.includes("Rótulo de pesquisa"));
  assert.ok(texto.includes("garante lucro futuro"));
});
