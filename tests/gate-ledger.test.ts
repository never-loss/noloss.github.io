// Livro-razão da porta: blocos alinhados, incremental == completo, sem olhar para o futuro. Velas SINTÉTICAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEDGER_VERSION, makeLedgerParams, computeLedger, updateLedger, ledgerOos, evaluateLedgerGate, paramsHash,
  hashString, ledgerTailNeeded, blockSeconds,
} from "../src/core/gate-ledger.ts";
import type { LedgerParams, GateLedger } from "../src/core/gate-ledger.ts";
import { walkForwardCandles, summarizeR } from "../src/core/candle-backtest.ts";
import { evaluateCandleGate } from "../src/core/candle-gate.ts";
import { strategiesForPreset, STRATEGY_PRESETS } from "../src/core/strategies.ts";
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
const GRAN = 300;
function walk(seed: number, n: number, phi: number, startEpoch = 1_700_000_000): Candle[] {
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
    out.push({ epoch: startEpoch + i * GRAN, open, high, low, close });
    price = close;
  }
  return out;
}

function setup(presetId = "lucro_rapido", over: { blockCandles?: number; warmup?: number; trainSize?: number } = {}): { strategies: Strategy[]; params: LedgerParams } {
  const preset = STRATEGY_PRESETS.find((p) => p.id === presetId)!;
  const g = preset.preferredGate!;
  const strategies = strategiesForPreset(presetId).map((s) => feasible(s, { slAtr: g.slAtr ?? 1.5, maxStopFraction: 1 / 100 }));
  const params = makeLedgerParams(
    strategies,
    { slAtr: g.slAtr!, tpR: g.tpR!, maxBars: g.maxBars!, costFraction: 0.001, trainSize: over.trainSize ?? 600 },
    GRAN,
    { blockCandles: over.blockCandles ?? 300, warmup: over.warmup ?? 200 },
  );
  return { strategies, params };
}

test("blocos alinhados à época, contíguos e só de blocos FECHADOS", () => {
  const { strategies, params } = setup();
  const candles = walk(1, 5000, 0);
  const led = computeLedger(candles, strategies, params);
  const bs = blockSeconds(params);
  assert.ok(led.folds.length >= 10);
  for (const f of led.folds) {
    assert.equal(f.start % bs, 0);
    assert.equal(f.end - f.start, bs);
    assert.equal(f.start, f.block * bs);
    assert.ok(f.end <= candles[candles.length - 1]!.epoch + GRAN, "bloco fechado");
    assert.equal(f.n, f.r.length);
    assert.ok(Math.abs(f.sumR - f.r.reduce((a, b) => a + b, 0)) < 1e-9);
  }
  for (let i = 1; i < led.folds.length; i++) assert.equal(led.folds[i]!.block, led.folds[i - 1]!.block + 1);
  // o último bloco, ainda por fechar, não está lá
  const lastEnd = candles[candles.length - 1]!.epoch + GRAN;
  assert.ok(led.folds[led.folds.length - 1]!.end + bs > lastEnd);
});

test("cada bloco == walk-forward clássico de UM bloco sobre a mesma janela (aquecimento 0)", () => {
  const { strategies, params } = setup("lucro_rapido", { warmup: 0 });
  const candles = walk(2, 4000, 0.3);
  const led = computeLedger(candles, strategies, params);
  assert.ok(led.folds.length >= 8);
  for (const f of led.folds) {
    const bi = candles.findIndex((c) => c.epoch >= f.start);
    const be = candles.findIndex((c) => c.epoch >= f.end);
    const slice = candles.slice(bi - params.trainSize, be);
    const wf = walkForwardCandles(slice, strategies, {
      slAtr: params.slAtr, tpR: params.tpR, maxBars: params.maxBars, costFraction: params.costFraction,
      trainSize: params.trainSize, testSize: be - bi,
    });
    assert.equal(wf.folds.length, 1);
    assert.equal(wf.folds[0]!.chosen, f.chosen);
    assert.deepStrictEqual(wf.oosR, f.r); // bit a bit
    assert.equal(wf.folds[0]!.train?.netR ?? null, f.trainNetR);
  }
});

test("incremental == recálculo completo (bit a bit), acrescentando velas aos poucos e usando só a cauda", () => {
  const { strategies, params } = setup();
  const candles = walk(3, 6000, 0.1);
  const full = computeLedger(candles, strategies, params);
  let led: GateLedger | null = null;
  const tailN = ledgerTailNeeded(params, 3);
  for (let end = 1500; ; end += 137) {
    const e = Math.min(end, candles.length);
    const tail = candles.slice(Math.max(0, e - tailN), e);
    led = updateLedger(led, tail, strategies, params);
    if (e === candles.length) break;
  }
  assert.deepStrictEqual(led!.folds, full.folds);
  assert.equal(led!.paramsHash, full.paramsHash);
});

test("prefixo-invariante: acrescentar velas futuras nunca altera blocos já fechados", () => {
  const { strategies, params } = setup();
  const candles = walk(4, 6000, 0.2);
  const pre = computeLedger(candles.slice(0, 4200), strategies, params);
  const all = computeLedger(candles, strategies, params);
  assert.ok(pre.folds.length < all.folds.length);
  assert.deepStrictEqual(all.folds.slice(0, pre.folds.length), pre.folds);
});

test("sem olhar para o futuro: alterar velas DEPOIS do fim de um bloco não muda esse bloco; alterar dentro dele muda", () => {
  const { strategies, params } = setup();
  const candles = walk(5, 5000, 0.2);
  const base = computeLedger(candles, strategies, params);
  const target = base.folds[4]!;
  const mutated = candles.map((c) => (c.epoch >= target.end ? { ...c, close: c.close * 1.05, high: c.high * 1.06, low: c.low * 0.97 } : c));
  const led2 = computeLedger(mutated, strategies, params);
  const same = led2.folds.filter((f) => f.block <= target.block);
  assert.deepStrictEqual(same, base.folds.filter((f) => f.block <= target.block));
  const inside = candles.map((c) => (c.epoch >= target.start && c.epoch < target.end ? { ...c, close: c.close * 1.03, high: c.high * 1.04 } : c));
  const led3 = computeLedger(inside, strategies, params);
  assert.notDeepStrictEqual(led3.folds.find((f) => f.block === target.block), target);
});

test("independente da profundidade: mais história à esquerda não muda nenhum bloco comum", () => {
  const { strategies, params } = setup();
  const candles = walk(6, 6000, 0.15);
  const deep = computeLedger(candles, strategies, params);
  const shallow = computeLedger(candles.slice(1234), strategies, params);
  assert.ok(shallow.folds.length >= 6 && shallow.folds.length < deep.folds.length);
  const byBlock = new Map(deep.folds.map((f) => [f.block, f]));
  for (const f of shallow.folds) assert.deepStrictEqual(byBlock.get(f.block), f);
});

test("versão/parâmetros diferentes → livro antigo descartado e recalculado", () => {
  const { strategies, params } = setup();
  const candles = walk(7, 4000, 0);
  const led = computeLedger(candles, strategies, params);
  const stale: GateLedger = { ...led, version: LEDGER_VERSION - 1, folds: led.folds.map((f) => ({ ...f, sumR: 999 })) };
  const fresh = updateLedger(stale, candles, strategies, params);
  assert.deepStrictEqual(fresh.folds, led.folds);
  const other = { ...params, tpR: params.tpR + 0.5 };
  assert.notEqual(paramsHash(other), paramsHash(params));
  const bad = { ...led, paramsHash: paramsHash(other) };
  assert.deepStrictEqual(updateLedger(bad, candles, strategies, params).folds, led.folds);
  // nomes de estratégias diferentes → hash diferente
  assert.notEqual(paramsHash({ ...params, strategies: params.strategies.slice(1) }), paramsHash(params));
  assert.throws(() => updateLedger(null, candles, strategies.slice(1), params), RangeError);
});

test("velas inválidas/duplicadas são rejeitadas; poucas velas dão livro vazio", () => {
  const { strategies, params } = setup();
  const c = walk(8, 3000, 0);
  assert.throws(() => computeLedger([c[1]!, c[0]!, ...c.slice(2)], strategies, params), RangeError);
  assert.throws(() => computeLedger([...c.slice(0, 5), c[4]!], strategies, params), RangeError);
  assert.equal(computeLedger(c.slice(0, 700), strategies, params).folds.length, 0);
  assert.equal(computeLedger([], strategies, params).folds.length, 0);
});

test("keepFolds limita o tamanho do livro (mantém os mais recentes)", () => {
  const { strategies, params } = setup();
  const candles = walk(9, 6000, 0);
  const all = computeLedger(candles, strategies, params);
  const cut = computeLedger(candles, strategies, params, { keepFolds: 5 });
  assert.deepStrictEqual(cut.folds, all.folds.slice(-5));
});

test("OOS agregado recompõe exactamente o p-value (lista de R) e coincide com summarizeR", () => {
  const { strategies, params } = setup();
  const led = computeLedger(walk(10, 6000, 0.3), strategies, params);
  const oos = ledgerOos(led);
  const rs = led.folds.flatMap((f) => f.r);
  assert.deepStrictEqual(oos, summarizeR(rs));
  assert.equal(oos.trades, led.folds.reduce((a, f) => a + f.n, 0));
  assert.equal(ledgerOos(led, 3).trades, led.folds.slice(-3).reduce((a, f) => a + f.n, 0));
});

test("veredicto: poucas operações OOS → INSUFFICIENT; passeio aleatório → nunca abre; honesto nos números", () => {
  const { strategies, params } = setup("loss_zero");
  const short = computeLedger(walk(11, 2500, 0), strategies, params);
  const r0 = evaluateLedgerGate(short, walk(11, 2500, 0), strategies, { minLabel: "EVIDENCE" });
  assert.equal(r0.allowed, false);
  assert.equal(r0.label, "INSUFFICIENT");
  assert.match(r0.reason, /mínimo 1000/);
  for (const seed of [1, 2, 3]) {
    const c = walk(seed, 9000, 0);
    const p = setup("lucro_rapido");
    const led = computeLedger(c, p.strategies, p.params);
    const r = evaluateLedgerGate(led, c, p.strategies, { minLabel: "PRELIMINARY" });
    assert.equal(r.allowed, false, `sem edge no passeio aleatório (semente ${seed}): ${r.reason}`);
    assert.equal(r.folds, led.folds.length);
    assert.ok(r.foldsPositive <= r.foldsWithTrades);
    assert.ok(r.depthDays > 5);
    assert.equal(r.asOf, led.folds[led.folds.length - 1]!.end);
  }
});

test("veredicto: com momentum plantado a porta pode abrir e devolve estratégia + metadados", () => {
  const p = setup("blitz_zero");
  let opened = 0;
  for (const seed of [2, 12, 22, 32]) {
    const c = walk(seed, 9000, 0.4);
    const led = computeLedger(c, p.strategies, p.params);
    const r = evaluateLedgerGate(led, c, p.strategies, { minLabel: "AGILE" });
    if (r.allowed) {
      opened += 1;
      assert.ok(r.strategy !== null);
      assert.ok(r.pValue !== null && r.pValue < 0.01);
      assert.ok(r.meanR > 0);
      assert.ok(r.oosTrades >= 10);
    } else {
      assert.equal(r.strategy, null);
    }
  }
  assert.ok(opened >= 1, "pelo menos um mercado com momentum plantado abre");
});

test("compatível com a porta clássica: mesma ordem de grandeza de OOS, sem promessa de igualdade (janelas diferentes)", () => {
  const p = setup("blitz_zero");
  const c = walk(2, 6000, 0.4);
  const led = computeLedger(c, p.strategies, p.params);
  const g = STRATEGY_PRESETS.find((x) => x.id === "blitz_zero")!.preferredGate!;
  const classic = evaluateCandleGate(c, p.strategies, {
    slAtr: g.slAtr!, tpR: g.tpR!, maxBars: g.maxBars!, costFraction: 0.001, trainSize: 600, testSize: 300, minLabel: "AGILE",
  });
  const mine = ledgerOos(led);
  assert.ok(mine.trades > 0 && classic.oosTrades > 0);
  assert.ok(Math.sign(mine.meanR) === Math.sign(classic.meanR), `${mine.meanR} vs ${classic.meanR}`);
});

test("hashString é determinístico e sensível", () => {
  assert.equal(hashString("abc"), hashString("abc"));
  assert.notEqual(hashString("abc"), hashString("abd"));
  assert.equal(hashString("x").length, 14);
});

test("GOLDEN: resultado fixo do livro (se mudar, a lógica mudou → subir LEDGER_VERSION)", () => {
  const { strategies, params } = setup();
  const led = computeLedger(walk(42, 4000, 0.2), strategies, params);
  const digest = hashString(JSON.stringify(led.folds.map((f) => [f.block, f.chosen, f.n, Math.round(f.sumR * 1e6)])));
  assert.equal(LEDGER_VERSION, 1);
  assert.equal(digest, GOLDEN_DIGEST, `digest mudou: ${digest}. Se a mudança é intencional, suba LEDGER_VERSION e actualize este valor.`);
});

const GOLDEN_DIGEST = "18ee7650cd81c8";
