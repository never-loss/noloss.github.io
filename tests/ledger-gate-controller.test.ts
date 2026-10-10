// src/core/ledger-gate-controller.ts — porta ancorada no livro-razão: as-of determinístico, seed sem esperar, fecho imediato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LedgerGateController, ledgerAsOf, GATE_VERDICT_FOLDS } from "../src/core/ledger-gate-controller.ts";
import { computeLedger, makeLedgerParams } from "../src/core/gate-ledger.ts";
import type { GateLedger, LedgerFold } from "../src/core/gate-ledger.ts";
import { gateSetup } from "../src/core/gate-service.ts";
import { strategiesForPreset } from "../src/core/strategies.ts";
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
const GRAN = 300;
const BLOCK = 500 * GRAN;
/** Série sintética com início alinhado ao bloco 0 (epoch múltiplo de BLOCK). */
function walk(seed: number, n: number, phi: number, start = 3400 * BLOCK): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const ret = phi * prev + gauss(r) * 0.002;
    prev = ret;
    const open = price;
    const close = open * (1 + ret);
    out.push({ epoch: start + i * GRAN, open, close, high: Math.max(open, close) * (1 + Math.abs(gauss(r)) * 0.0007), low: Math.min(open, close) * (1 - Math.abs(gauss(r)) * 0.0007) });
    price = close;
  }
  return out;
}

const setup = gateSetup("blitz_zero");
const ledgerOf = (c: readonly Candle[]): GateLedger => computeLedger(c, setup.strategies, setup.params);
const mk = (ledger: GateLedger, initial: readonly Candle[]) =>
  new LedgerGateController({ ledger, strategies: setup.strategies, minLabel: setup.minLabel, revalidateEvery: 12, initial });

/** Procura uma série (momentum plantado) em que a porta Agressivo (AGILE) passa. */
function findOpenSeries(): { candles: Candle[]; cut: number } {
  for (const seed of [2, 12, 22, 32, 42, 52, 62]) {
    const candles = walk(seed, 11000, 0.4);
    for (const cut of [9000, 9300, 9600]) {
      const c = mk(ledgerOf(candles.slice(0, cut)), candles.slice(0, cut));
      if (c.result.allowed && c.isOpen) return { candles, cut };
    }
  }
  throw new Error("sem série com porta aberta");
}

test("ledgerAsOf: só blocos com fim <= t e no máximo os N mais recentes", () => {
  const candles = walk(1, 9000, 0);
  const led = ledgerOf(candles);
  assert.ok(led.folds.length > 5);
  const mid = led.folds[3]!.end;
  const v = ledgerAsOf(led, mid);
  assert.equal(v.folds.length, 4);
  assert.ok(v.folds.every((f) => f.end <= mid));
  assert.equal(ledgerAsOf(led, Number.POSITIVE_INFINITY, 3).folds.length, 3);
  assert.deepEqual(ledgerAsOf(led, Number.POSITIVE_INFINITY, 3).folds, led.folds.slice(-3));
  assert.equal(GATE_VERDICT_FOLDS, 100);
});

test("determinismo: livro MAIS NOVO + filtro as-of == livro desse instante (a sequência de veredictos é idêntica)", () => {
  const candles = walk(7, 11500, 0.3);
  // t a 20 velas de uma fronteira de bloco: durante os pushes cruza-se um bloco novo
  const bi = Math.ceil((candles[9000]!.epoch + 1) / BLOCK) * BLOCK;
  const cut = Math.round((bi - candles[0]!.epoch) / GRAN) - 20;
  // livro que cobre a janela dos pushes (inclui o bloco que fecha lá dentro) vs. livro bem mais novo (blocos futuros)
  const ledgerThen = ledgerOf(candles.slice(0, cut + 80));
  const ledgerNow = ledgerOf(candles);
  assert.ok(ledgerNow.folds.length > ledgerThen.folds.length);
  const a = mk(ledgerThen, candles.slice(0, cut));
  const b = mk(ledgerNow, candles.slice(0, cut));
  const seq = (c: LedgerGateController) => ({ r: JSON.stringify(c.result), o: c.isOpen, s: c.streak });
  assert.deepEqual(seq(a), seq(b));
  for (let i = cut; i < cut + 80; i++) {
    const ca = a.push(candles[i]!);
    const cb = b.push(candles[i]!);
    assert.equal(ca, cb, `mudança de estado no push ${i}`);
    assert.deepEqual(seq(a), seq(b), `push ${i}`);
  }
  // o livro mais novo teve de cruzar a fronteira dentro da janela (senão o teste não provava nada)
  const nowFolds = ledgerNow.folds.filter((f) => f.end > candles[cut - 1]!.epoch + GRAN && f.end <= candles[cut + 79]!.epoch + GRAN);
  assert.ok(nowFolds.length >= 1, "bloco novo fechou durante a janela");
});

test("sem esperar 12 velas: porta que já passava nas validações anteriores abre logo (streak 2)", () => {
  const { candles, cut } = findOpenSeries();
  const c = mk(ledgerOf(candles.slice(0, cut)), candles.slice(0, cut));
  assert.equal(c.result.allowed, true);
  assert.equal(c.streak, 2);
  assert.equal(c.isOpen, true);
  // fecha o mesmo sinal: asStrategy dá sinais (não só zeros) quando aberta
  const sigs = c.asStrategy().signals(candles.slice(0, cut));
  assert.equal(sigs.length, cut);
  assert.ok(sigs.some((x) => x !== 0));
});

test("histerese preservada: se a validação anterior (-12 velas) não passava, começa fechada e abre na próxima validação", () => {
  const candles = walk(3, 3200, 0.2);
  const params = makeLedgerParams(setup.strategies, { slAtr: 1.5, tpR: 2, maxBars: 24, costFraction: 0.001, trainSize: 1000, minTrainTrades: 1 }, GRAN, { blockCandles: 500, warmup: 600 });
  // 1 bloco fechado 6 velas antes do fim, com 12 operações todas positivas (AGILE passa); antes dele: sem blocos (INSUFFICIENT)
  const end = candles[candles.length - 1]!.epoch + GRAN - 6 * GRAN;
  const fold: LedgerFold = {
    block: Math.round(end / BLOCK) - 1, start: end - BLOCK, end, nCandles: 500, chosen: "x", trainTrades: 30, trainNetR: 1,
    n: 12, sumR: 18, sumR2: 27, wins: 12, r: [1.4, 1.5, 1.6, 1.45, 1.55, 1.5, 1.42, 1.58, 1.5, 1.47, 1.53, 1.5],
  };
  const ledger: GateLedger = { version: 1, paramsHash: "t", params, folds: [fold] };
  const c = new LedgerGateController({ ledger, strategies: setup.strategies, minLabel: "AGILE", revalidateEvery: 12, initial: candles });
  assert.equal(c.result.allowed, true, c.result.reason);
  assert.equal(c.streak, 1, "-12 velas ainda não tinha o bloco");
  assert.equal(c.isOpen, false);
  const more = walk(3, 3300, 0.2).slice(3200);
  for (let i = 0; i < 11; i++) assert.equal(c.push({ ...more[i]!, epoch: candles[candles.length - 1]!.epoch + (i + 1) * GRAN }), false);
  assert.equal(c.isOpen, false);
  const changed = c.push({ ...more[11]!, epoch: candles[candles.length - 1]!.epoch + 12 * GRAN });
  assert.equal(changed, true, "12.ª vela: validação confirma");
  assert.equal(c.streak, 2);
  assert.equal(c.isOpen, true);
});

test("fecha de imediato (streak 0) quando entra um bloco mau; a sessão deixa de receber sinais", () => {
  const candles = walk(3, 3300, 0.2);
  const params = makeLedgerParams(setup.strategies, { slAtr: 1.5, tpR: 2, maxBars: 24, costFraction: 0.001, trainSize: 1000, minTrainTrades: 1 }, GRAN, { blockCandles: 500, warmup: 600 });
  const t0 = candles[3199]!.epoch + GRAN;
  const good = (end: number, b: number): LedgerFold => ({
    block: b, start: end - BLOCK, end, nCandles: 500, chosen: "x", trainTrades: 30, trainNetR: 1,
    n: 12, sumR: 18, sumR2: 27, wins: 12, r: [1.4, 1.5, 1.6, 1.45, 1.55, 1.5, 1.42, 1.58, 1.5, 1.47, 1.53, 1.5],
  });
  const bad: LedgerFold = { ...good(t0 + 6 * GRAN, 99), n: 60, sumR: -60, sumR2: 80, wins: 0, r: Array.from({ length: 60 }, (_, i) => -1 - (i % 3) * 0.01) };
  const ledger: GateLedger = { version: 1, paramsHash: "t", params, folds: [good(t0 - 30 * GRAN, 98), bad] };
  const c = new LedgerGateController({ ledger, strategies: setup.strategies, minLabel: "AGILE", revalidateEvery: 12, initial: candles.slice(0, 3200) });
  assert.equal(c.result.allowed, true);
  assert.equal(c.isOpen, true, "no arranque o bloco mau ainda não existia");
  let closedAt = -1;
  for (let i = 3200; i < 3300; i++) {
    const changed = c.push(candles[i]!);
    if (changed && !c.isOpen) { closedAt = i; break; }
  }
  assert.ok(closedAt > 3200 && closedAt <= 3212, `fechou na 1.ª validação após o bloco mau (i=${closedAt})`);
  assert.equal(c.streak, 0);
  assert.equal(c.isOpen, false);
  assert.ok(c.asStrategy().signals(candles.slice(0, 200)).every((x) => x === 0));
});

test("revalidateEvery inválido lança; cauda curta fecha com razão honesta", () => {
  const candles = walk(5, 500, 0);
  const led: GateLedger = { version: 1, paramsHash: "t", params: setup.params, folds: [] };
  assert.throws(() => new LedgerGateController({ ledger: led, strategies: setup.strategies, minLabel: "AGILE", revalidateEvery: 0, initial: candles }), RangeError);
  const c = mk(led, candles);
  assert.equal(c.isOpen, false);
  assert.equal(c.result.allowed, false);
  assert.equal(c.result.label, "INSUFFICIENT");
});

test("estratégias de preset: Loss zero deixa de ser impossível por construção (precisa só de OOS acumulado, não de 1500 velas)", () => {
  const lz = gateSetup("loss_zero");
  assert.equal(lz.minLabel, "EVIDENCE");
  // o walk-forward de 1500 velas só tem ~500 velas OOS → no máx. dezenas de operações < 1000; o livro soma blocos de 90+ dias
  const raw = strategiesForPreset("loss_zero").map((s) => feasible(s, { slAtr: 1.5, maxStopFraction: 1 / 100 }));
  assert.ok(raw.length > 0);
  const candles = walk(9, 1500, 0);
  const legacyOosCap = 1500 - 1000; // velas OOS possíveis no legacy
  assert.ok(legacyOosCap < 1000, "com 1500 velas há menos de 1000 velas OOS: 1000 operações é impossível");
  const c = new LedgerGateController({ ledger: { version: 1, paramsHash: "t", params: lz.params, folds: [] }, strategies: lz.strategies, minLabel: "EVIDENCE", revalidateEvery: 12, initial: candles });
  assert.match(c.result.reason, /mínimo 1000/);
});
