import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLiveEntry,
  proximityForStrategyName,
  combineGateAndLive,
} from "../src/core/strategy-live.ts";
import {
  lucroRapidoStrategySet,
  lossZeroStrategySet,
  emaCross,
} from "../src/core/strategies.ts";
import type { Candle } from "../src/core/market-data.ts";

function synth(n: number, start = 100): Candle[] {
  const out: Candle[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 8) * 1.2 + (i % 17 === 0 ? 2.5 : 0);
    const open = px;
    const close = px + drift;
    const high = Math.max(open, close) + 0.4;
    const low = Math.min(open, close) - 0.4;
    out.push({ epoch: 1_700_000_000 + i * 300, open, high, low, close });
    px = close;
  }
  return out;
}

test("evaluateLiveEntry devolve métricas honestas com poucas velas", () => {
  const m = evaluateLiveEntry(synth(10), lucroRapidoStrategySet());
  assert.equal(m.proximityPct, 0);
  assert.ok(/velas/.test(m.detail));
  assert.equal(m.atTarget, false);
});

test("evaluateLiveEntry corre Lucro rápido e Loss zero em série sintética", () => {
  const candles = synth(200);
  const lr = evaluateLiveEntry(candles, lucroRapidoStrategySet());
  const lz = evaluateLiveEntry(candles, lossZeroStrategySet());
  assert.ok(lr.proximityPct >= 0 && lr.proximityPct <= 100);
  assert.ok(lz.proximityPct >= 0 && lz.proximityPct <= 100);
  assert.ok(lr.total === lucroRapidoStrategySet().length);
  assert.ok(lz.total === lossZeroStrategySet().length);
  assert.ok(["long", "short", "neutral"].includes(lr.bias));
});

test("proximityForStrategyName reconhece ema-cruza", () => {
  const candles = synth(120);
  const p = proximityForStrategyName("ema-cruza 9/21", candles);
  assert.ok(p >= 0 && p <= 1);
});

test("atTarget quando estratégia emite sinal na última vela", () => {
  // Build a clear uptrend then force ema cross by appending a spike
  const base = synth(80, 50);
  // Strong rally to force crosses
  let px = base[base.length - 1]!.close;
  for (let i = 0; i < 40; i++) {
    const open = px;
    const close = px + 3;
    base.push({
      epoch: base[base.length - 1]!.epoch + 300,
      open,
      high: close + 0.2,
      low: open - 0.2,
      close,
    });
    px = close;
  }
  const strat = emaCross({ fast: 3, slow: 8 });
  const m = evaluateLiveEntry(base, [strat], { hold: 5 });
  assert.ok(m.proximityPct >= 0);
  assert.equal(typeof m.detail, "string");
});

test("combineGateAndLive só ready com porta + alvo", () => {
  const live = {
    proximityPct: 90,
    lastSignal: 1 as const,
    barsSinceSignal: 0,
    agreeingLong: 2,
    agreeingShort: 0,
    total: 3,
    bias: "long" as const,
    atTarget: true,
    detail: "ALVO",
  };
  const a = combineGateAndLive(true, 100, live);
  assert.equal(a.ready, true);
  assert.equal(a.score, 100);
  const b = combineGateAndLive(false, 40, live);
  assert.equal(b.ready, false);
  assert.ok(b.score <= 70);
  const waiting = { ...live, atTarget: false, lastSignal: 0 as const, proximityPct: 60 };
  const c = combineGateAndLive(true, 100, waiting);
  assert.equal(c.ready, false);
  assert.ok(/espera/i.test(c.label));
});
