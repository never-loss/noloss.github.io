import { test } from "node:test";
import assert from "node:assert/strict";
import { marketOf, isScheduledOpen, marketStatus, MARKETS } from "../src/core/markets.ts";
import { runMarketResearch, formatMarketReport } from "../src/core/market-research.ts";
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

function walk(seed: number, n: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + gauss(r) * 0.002);
    const high = Math.max(open, close) * (1 + Math.abs(gauss(r)) * 0.0007);
    const low = Math.min(open, close) * (1 - Math.abs(gauss(r)) * 0.0007);
    out.push({ epoch: 1_700_000_000 + i * 300, open, high, low, close });
    price = close;
  }
  return out;
}

test("cada símbolo vai para o seu mercado: cripto NÃO é forex", () => {
  assert.equal(marketOf("cryBTCUSD"), "crypto");
  assert.equal(marketOf("cryETHUSD"), "crypto");
  assert.equal(marketOf("crySOLUSD"), "crypto");
  assert.equal(marketOf("frxEURUSD"), "forex");
  assert.equal(marketOf("frxUSDJPY"), "forex");
  assert.equal(marketOf("frxXAUUSD"), "metals");
  assert.equal(marketOf("frxXAGUSD"), "metals");
  assert.equal(marketOf("1HZ100V"), null);
  assert.equal(marketOf("R_100"), null);
  assert.equal(marketOf(""), null);
  assert.equal(marketOf("frxEUR"), null);
  assert.equal(marketOf("cryBTC"), null); // sem USD
  assert.equal(marketOf("crybtcusd"), null); // minúsculas
});

test("perfis: só a cripto opera sempre e tem o custo assumido mais alto", () => {
  assert.equal(MARKETS.crypto.alwaysOpen, true);
  assert.equal(MARKETS.forex.alwaysOpen, false);
  assert.ok(MARKETS.crypto.assumedCostFraction > MARKETS.metals.assumedCostFraction);
  assert.ok(MARKETS.metals.assumedCostFraction > MARKETS.forex.assumedCostFraction);
});

test("horário: forex fecha na sexta às 21:00 UTC e reabre no domingo às 22:00", () => {
  const d = (iso: string): Date => new Date(iso + "Z");
  assert.equal(isScheduledOpen("forex", d("2026-09-18T20:59:00")), true);
  assert.equal(isScheduledOpen("forex", d("2026-09-18T21:00:00")), false);
  assert.equal(isScheduledOpen("forex", d("2026-09-19T12:00:00")), false);
  assert.equal(isScheduledOpen("forex", d("2026-09-20T21:59:00")), false);
  assert.equal(isScheduledOpen("forex", d("2026-09-20T22:00:00")), true);
  assert.equal(isScheduledOpen("forex", d("2026-09-21T10:00:00")), true);
  assert.equal(isScheduledOpen("metals", d("2026-09-19T12:00:00")), false);
  assert.equal(isScheduledOpen("crypto", d("2026-09-19T12:00:00")), true);
});

test("estado real: velas recentes = aberto; antigas fora de horas = fechado; antigas em horas = desconhecido", () => {
  const agora = Date.parse("2026-09-20T06:30:00Z");
  const ultimaForex = Date.parse("2026-09-18T20:50:00Z") / 1000;
  const ultimaCripto = Date.parse("2026-09-20T06:25:00Z") / 1000;
  assert.equal(marketStatus("forex", ultimaForex, agora, 300), "closed");
  assert.equal(marketStatus("crypto", ultimaCripto, agora, 300), "open");
  const segunda = Date.parse("2026-09-21T10:00:00Z");
  assert.equal(marketStatus("forex", ultimaForex, segunda, 300), "unknown");
  assert.equal(marketStatus("crypto", ultimaForex, agora, 300), "unknown");
  assert.throws(() => marketStatus("forex", NaN, agora, 300), RangeError);
  assert.throws(() => marketStatus("forex", 1, agora, 0), RangeError);
});

const OPTS = { slAtr: 1.5, tpR: 2, maxBars: 24, trainSize: 1500, testSize: 500 };

test("a pesquisa separa os mercados e usa o custo de cada um", () => {
  const data = {
    cryBTCUSD: walk(21, 4000),
    cryETHUSD: walk(22, 4000),
    frxEURUSD: walk(23, 4000),
    frxXAUUSD: walk(24, 4000),
  };
  const groups = runMarketResearch(data, OPTS);
  assert.deepEqual(groups.map((g) => g.kind), ["forex", "metals", "crypto"]);
  const crypto = groups.find((g) => g.kind === "crypto")!;
  assert.deepEqual(crypto.reports.map((r) => r.symbol).sort(), ["cryBTCUSD", "cryETHUSD"]);
  assert.equal(crypto.reports[0]!.cost, MARKETS.crypto.assumedCostFraction);
  const forex = groups.find((g) => g.kind === "forex")!;
  assert.deepEqual(forex.reports.map((r) => r.symbol), ["frxEURUSD"]);
  assert.equal(forex.reports[0]!.cost, MARKETS.forex.assumedCostFraction);
});

test("o custo pode ser substituído para todos os mercados", () => {
  const groups = runMarketResearch({ cryBTCUSD: walk(25, 4000), frxEURUSD: walk(26, 4000) }, { ...OPTS, costOverride: 0.0003 });
  for (const g of groups) for (const r of g.reports) assert.equal(r.cost, 0.0003);
});

test("símbolo desconhecido ou dados vazios são rejeitados", () => {
  assert.throws(() => runMarketResearch({ R_100: walk(1, 4000) }, OPTS), RangeError);
  assert.throws(() => runMarketResearch({}, OPTS), RangeError);
});

test("relatório por mercado tem cabeçalhos separados", () => {
  const groups = runMarketResearch({ cryBTCUSD: walk(27, 4000), frxEURUSD: walk(28, 4000) }, OPTS);
  const texto = formatMarketReport(groups);
  assert.ok(texto.includes("FOREX"));
  assert.ok(texto.includes("CRIPTO"));
  assert.ok(texto.indexOf("FOREX") < texto.indexOf("CRIPTO"));
  assert.ok(texto.includes("garante lucro futuro"));
});
