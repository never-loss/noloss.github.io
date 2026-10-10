// advanceCloudArmJob com porta ancorada no livro (modo "ledger") vs. modo legacy. Velas SINTÉTICAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloudArmJob, advanceCloudArmJob, cloudArmLedgerEligible, publicCloudArmJob } from "../src/core/cloud-arm.ts";
import type { CloudArmJob } from "../src/core/cloud-arm.ts";
import { computeLedger } from "../src/core/gate-ledger.ts";
import { gateSetup } from "../src/core/gate-service.ts";
import { LedgerGateController } from "../src/core/ledger-gate-controller.ts";
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
const ledgerOf = (c: readonly Candle[]) => computeLedger(c, setup.strategies, setup.params);

function newJob(startedAtMs: number, preset = "blitz_zero"): CloudArmJob {
  const j = createCloudArmJob({ symbol: "BTCUSDT", strategyPreset: preset, stake: 1, leverage: 1, granularity: 300, durationMinutes: 600, clientId: "client_test_1", mode: "PAPER" }, startedAtMs);
  return j;
}

/** Série onde a porta Agressivo abre ao arranque; devolve também o instante de arranque. */
function openAtStart(): { candles: Candle[]; cut: number; ledger: ReturnType<typeof ledgerOf> } {
  for (const seed of [2, 12, 22, 32, 42, 52, 62]) {
    const candles = walk(seed, 11000, 0.4);
    for (const cut of [9000, 9300, 9600]) {
      const ledger = ledgerOf(candles.slice(0, cut));
      const c = new LedgerGateController({ ledger, strategies: setup.strategies, minLabel: setup.minLabel, revalidateEvery: 12, initial: candles.slice(0, cut) });
      if (c.isOpen) return { candles, cut, ledger };
    }
  }
  throw new Error("sem série");
}

test("elegibilidade: só os 3 presets em 5m", () => {
  assert.equal(cloudArmLedgerEligible("blitz_zero", 300), true);
  assert.equal(cloudArmLedgerEligible("loss_zero", 300), true);
  assert.equal(cloudArmLedgerEligible("lucro_rapido", 300), true);
  assert.equal(cloudArmLedgerEligible("lucro_rapido", 60), false);
  assert.equal(cloudArmLedgerEligible("tendencia_diaria", 300), false);
  assert.equal(cloudArmLedgerEligible("biblioteca", 300), false);
});

test("modo ledger: porta já aberta abre no 1.º tick (sem esperar 12 velas) e legacy continua a esperar", () => {
  const { candles, cut, ledger } = openAtStart();
  const startMs = (candles[cut - 1]!.epoch + GRAN) * 1000; // arranque = fim da última vela fechada
  const nowMs = startMs + 5_000;
  const job = newJob(startMs);
  const led = advanceCloudArmJob(job, candles.slice(0, cut), nowMs, { ledger });
  assert.equal(led.gateMode, "ledger");
  assert.equal(led.gate!.source, "ledger");
  assert.equal(led.gate!.allowed, true, led.gate!.reason);
  assert.equal(led.gate!.streak, 2);
  assert.ok((led.gate!.depthDays ?? 0) > 10);
  assert.ok((led.gate!.folds ?? 0) >= 10);
  assert.equal(led.status, "RUNNING");
  // legacy com as mesmas velas: porta fechada ao arranque (streak 1) — é o atraso que o modo ledger elimina
  const leg = advanceCloudArmJob(job, candles.slice(0, cut), nowMs);
  assert.equal(leg.gate!.source, "legacy");
  assert.equal(leg.gate!.allowed, false);
  assert.equal(publicCloudArmJob(led).gateMode, "ledger");
  assert.equal(publicCloudArmJob(leg).gateMode, "legacy");
});

test("reconstrução determinística: eventos do tick anterior são prefixo dos do tick seguinte (livro novo ou antigo)", () => {
  const { candles, cut, ledger } = openAtStart();
  const startMs = (candles[cut - 1]!.epoch + GRAN) * 1000;
  const job = newJob(startMs);
  const at = (k: number) => (candles[cut + k - 1]!.epoch + GRAN) * 1000 + 1000;
  const t1 = advanceCloudArmJob(job, candles.slice(0, cut + 60), at(60), { ledger: ledgerOf(candles.slice(0, cut + 60)) });
  const t2 = advanceCloudArmJob({ ...t1 }, candles.slice(0, cut + 200), at(200), { ledger: ledgerOf(candles.slice(0, cut + 200)) });
  const t2b = advanceCloudArmJob({ ...t1 }, candles.slice(0, cut + 200), at(200), { ledger: ledgerOf(candles) }); // livro bem mais novo
  assert.deepStrictEqual(t2b.events, t2.events);
  assert.deepStrictEqual(t2b.gate, t2.gate);
  assert.ok(t2.events.length >= 3, `eventos ${t2.events.length}`);
  const e1 = t1.events.map((e) => `${e.type}:${e.at}:${e.text}`);
  const e2 = t2.events.map((e) => `${e.type}:${e.at}:${e.text}`);
  assert.deepStrictEqual(e2.slice(0, e1.length), e1, "o passado não muda entre ticks");
  // idempotente
  const again = advanceCloudArmJob({ ...t1 }, candles.slice(0, cut + 200), at(200), { ledger: ledgerOf(candles.slice(0, cut + 200)) });
  assert.deepStrictEqual(again.events, t2.events);
});

test("livro com hash diferente é recusado (não decide com parâmetros errados)", () => {
  const { candles, cut, ledger } = openAtStart();
  const job = newJob((candles[cut - 1]!.epoch + GRAN) * 1000);
  assert.throws(() => advanceCloudArmJob(job, candles.slice(0, cut), (candles[cut - 1]!.epoch + GRAN) * 1000 + 1, { ledger: { ...ledger, paramsHash: "x" } }), /ledger_params_mismatch/);
});

test("preset fora da cache ignora o livro (legacy) e jobs antigos sem gateMode seguem legacy", () => {
  const { candles, cut, ledger } = openAtStart();
  const startMs = (candles[cut - 1]!.epoch + GRAN) * 1000;
  const job = newJob(startMs, "tendencia_diaria");
  const out = advanceCloudArmJob(job, candles.slice(0, cut), startMs + 1000, { ledger });
  assert.equal(out.gate!.source, "legacy");
  assert.equal(out.gateMode, undefined);
  assert.equal(publicCloudArmJob(out).gateMode, "legacy");
  const old = advanceCloudArmJob(newJob(startMs), candles.slice(0, cut), startMs + 1000);
  assert.equal(old.gate!.source, "legacy");
});

test("PAPER por omissão e stake/modos intactos no modo ledger", () => {
  const { candles, cut, ledger } = openAtStart();
  const startMs = (candles[cut - 1]!.epoch + GRAN) * 1000;
  const job = newJob(startMs);
  assert.equal(job.mode, "PAPER");
  const out = advanceCloudArmJob(job, candles.slice(0, cut + 100), startMs + 100 * GRAN * 1000, { ledger: ledgerOf(candles.slice(0, cut + 100)) });
  assert.equal(out.mode, "PAPER");
  assert.equal(out.stake, 1);
  assert.equal(out.summary.maxTrades, 10);
  assert.equal(out.needsRealFlatten, false);
  void ledger;
});
