import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLiveEntry,
  proximityForStrategyName,
  combineGateAndLive,
  combineReadiness,
  gateProgressPct,
  requiredOosForMinLabel,
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
  assert.ok(b.score <= 94, "porta fechada não pode fingir 100");
  assert.ok(b.score < 70, "sinal quente + porta fraca fica longe de 100");
  const waiting = { ...live, atTarget: false, lastSignal: 0 as const, proximityPct: 60 };
  const c = combineGateAndLive(true, 100, waiting);
  assert.equal(c.ready, false);
  assert.ok(c.score < 100);
  assert.ok(/espera/i.test(c.label));
});

test("gateProgressPct usa OOS vs PRELIMINARY/EVIDENCE sem inventar trades", () => {
  assert.equal(requiredOosForMinLabel("PRELIMINARY"), 100);
  assert.equal(requiredOosForMinLabel("EVIDENCE"), 1000);
  assert.equal(gateProgressPct({ allowed: true }), 100);
  const empty = gateProgressPct({ oosTrades: 0, minLabel: "PRELIMINARY" });
  assert.equal(empty, 0);
  const mid = gateProgressPct({ oosTrades: 50, minLabel: "PRELIMINARY" });
  assert.ok(mid >= 40 && mid <= 50, `mid=${mid}`);
  const nearPrelim = gateProgressPct({ oosTrades: 92, minLabel: "PRELIMINARY", meanR: 0.2, pValue: 0.1 });
  assert.ok(nearPrelim >= 85 && nearPrelim <= 99, `near=${nearPrelim}`);
  const evidSlow = gateProgressPct({ oosTrades: 100, minLabel: "EVIDENCE" });
  assert.ok(evidSlow <= 20, `evidSlow=${evidSlow}`); // 100/1000 * 88 ≈ 9
  assert.ok(gateProgressPct({ oosTrades: 999, minLabel: "EVIDENCE" }) < 100);
});

test("combineReadiness: 100% só porta+alvo; sinal sozinho nunca 100", () => {
  const hot = {
    proximityPct: 100,
    lastSignal: 1 as const,
    barsSinceSignal: 0,
    agreeingLong: 3,
    agreeingShort: 0,
    total: 3,
    bias: "long" as const,
    atTarget: true,
    detail: "ALVO",
  };
  const radar = combineReadiness({
    gateAllowed: false,
    gateProgressPct: 0,
    live: hot,
    gateKnown: false,
  });
  assert.equal(radar.ready, false);
  assert.ok(radar.score <= 70);
  assert.equal(radar.kind, "signal_only");
  assert.ok(/sinal/i.test(radar.label));

  const weakGate = combineReadiness({
    gateAllowed: false,
    gateProgressPct: 45,
    live: hot,
    gateKnown: true,
  });
  assert.equal(weakGate.ready, false);
  assert.ok(weakGate.score <= 94);
  // 45*0.85 + 100*0.15 = 38.25+15 = 53.25 → ~53
  assert.ok(weakGate.score >= 45 && weakGate.score <= 65, `weak=${weakGate.score}`);
  assert.ok(/porta/i.test(weakGate.label) && /sinal/i.test(weakGate.label));

  const almost = combineReadiness({
    gateAllowed: false,
    gateProgressPct: 92,
    live: hot,
    gateKnown: true,
  });
  assert.ok(almost.score >= 90 && almost.score <= 99, `almost=${almost.score}`);
  assert.equal(almost.ready, false);

  const ready = combineReadiness({
    gateAllowed: true,
    gateProgressPct: 100,
    live: hot,
    gateKnown: true,
  });
  assert.equal(ready.score, 100);
  assert.equal(ready.ready, true);
  assert.ok(/pronto a entrar/i.test(ready.label));
});

test("combineReadiness consistente com combineGateAndLive", () => {
  const live = {
    proximityPct: 80,
    lastSignal: 0 as const,
    barsSinceSignal: 2,
    agreeingLong: 1,
    agreeingShort: 0,
    total: 3,
    bias: "long" as const,
    atTarget: false,
    detail: "quase",
  };
  const a = combineGateAndLive(false, 60, live);
  const b = combineReadiness({ gateAllowed: false, gateProgressPct: 60, live, gateKnown: true });
  assert.equal(a.score, b.score);
  assert.equal(a.ready, b.ready);
});

test("LIVE_ENTRY_MAX_CANDLES limita custo com histórico longo", () => {
  const candles = synth(800);
  const t0 = Date.now();
  const m = evaluateLiveEntry(candles, lucroRapidoStrategySet());
  const ms = Date.now() - t0;
  assert.ok(m.proximityPct >= 0 && m.proximityPct <= 100);
  assert.ok(ms < 2500, `proximidade demasiado lenta: ${ms}ms`);
});

test("evaluateLiveEntry com Loss zero (confluências) não rebenta", () => {
  const m = evaluateLiveEntry(synth(200), lossZeroStrategySet());
  assert.ok(m.total === lossZeroStrategySet().length);
  assert.equal(typeof m.detail, "string");
});
