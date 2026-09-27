import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_PRESETS,
  strategyPreset,
  strategiesForPreset,
  lucroRapidoStrategySet,
  lossZeroStrategySet,
  blitzZeroStrategySet,
  strategyLibrary,
  dailyTrendStrategySet,
} from "../src/core/strategies.ts";

test("presets incluem Lucro rápido, Loss zero e Blitz zero com labels exactos", () => {
  const labels = STRATEGY_PRESETS.map((p) => p.label);
  assert.ok(labels.includes("Lucro rápido"));
  assert.ok(labels.includes("Loss zero"));
  assert.ok(labels.includes("Blitz zero"));
  const lr = strategyPreset("lucro_rapido");
  const lz = strategyPreset("loss_zero");
  const bz = strategyPreset("blitz_zero");
  assert.ok(lr);
  assert.ok(lz);
  assert.ok(bz);
  assert.equal(lr!.label, "Lucro rápido");
  assert.equal(lz!.label, "Loss zero");
  assert.equal(bz!.label, "Blitz zero");
});

test("cada preset devolve estratégias nomeadas e não vazias", () => {
  for (const p of STRATEGY_PRESETS) {
    const set = p.strategies();
    assert.ok(set.length >= 2, p.id);
    for (const s of set) {
      assert.equal(typeof s.name, "string");
      assert.ok(s.name.length > 0);
      assert.equal(typeof s.signals, "function");
    }
  }
});

test("strategiesForPreset resolve ids e rejeita desconhecidos", () => {
  assert.equal(strategiesForPreset("lucro_rapido").length, lucroRapidoStrategySet().length);
  assert.equal(strategiesForPreset("loss_zero").length, lossZeroStrategySet().length);
  assert.equal(strategiesForPreset("blitz_zero").length, blitzZeroStrategySet().length);
  assert.equal(strategiesForPreset("tendencia_diaria").length, dailyTrendStrategySet().length);
  assert.equal(strategiesForPreset("biblioteca").length, strategyLibrary().length);
  assert.throws(() => strategiesForPreset(""), RangeError);
  assert.throws(() => strategiesForPreset("martingale"), RangeError);
  assert.equal(strategyPreset("nope"), null);
});

test("descrições são honestas: NO TRADE / sem martingale / sem garantia de lucro", () => {
  for (const p of STRATEGY_PRESETS) {
    const d = p.description.toLowerCase();
    assert.ok(/no trade|porta/.test(d) || /evidência/.test(d), p.id);
    assert.ok(!/garante lucro|zero perdas garantid|martingale/.test(d) || /sem martingale|não/.test(d), p.id);
  }
  const lz = strategyPreset("loss_zero")!;
  assert.ok(/não/i.test(lz.description) || /NO TRADE/.test(lz.description));
  assert.ok(!/garante zero perdas/i.test(lz.description));
});

test("Loss zero pede evidência mais forte; Lucro rápido e Blitz zero aceitam PRELIMINARY", () => {
  assert.equal(strategyPreset("loss_zero")!.preferredGate?.minLabel, "EVIDENCE");
  assert.equal(strategyPreset("lucro_rapido")!.preferredGate?.minLabel, "PRELIMINARY");
  assert.equal(strategyPreset("blitz_zero")!.preferredGate?.minLabel, "PRELIMINARY");
  assert.equal(strategyPreset("blitz_zero")!.preferredGate?.maxBars, 10);
  assert.equal(strategyPreset("blitz_zero")!.preferredGate?.tpR, 1.5);
  assert.equal(strategyPreset("blitz_zero")!.preferredGate?.slAtr, 1.2);
});

test("blitzZeroStrategySet: confluências hold 2, lookbacks 1m, sem throw em velas curtas", () => {
  const set = blitzZeroStrategySet();
  assert.ok(set.length >= 7);
  const names = set.map((s) => s.name).join(" | ");
  assert.ok(/confluencia/.test(names));
  assert.ok(/ema-cruza 12\/26/.test(names));
  assert.ok(/ema-cruza 9\/21/.test(names));
  assert.ok(/macd-cruza/.test(names));
  assert.ok(/rsi-reversao/.test(names));
  assert.ok(/estocastico/.test(names));
  assert.ok(/adx-tendencia/.test(names));
  assert.ok(/tendência-diária breakout-ATR 30/.test(names));
  assert.ok(/tendência-diária breakout-ATR 20/.test(names));
  // hold 2 encoded in confluence name (h2)
  const conf = set.filter((s) => s.name.startsWith("confluencia"));
  assert.ok(conf.length >= 4);
  for (const c of conf) assert.ok(/h2\b/.test(c.name), c.name);
  // empty / short candles must not throw
  assert.equal(set[0]!.signals([]).length, 0);
  const short = Array.from({ length: 5 }, (_, i) => ({
    epoch: 1_700_000_000 + i * 60,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
  }));
  for (const s of set) {
    const sigs = s.signals(short);
    assert.equal(sigs.length, short.length);
  }
  const bz = strategyPreset("blitz_zero")!;
  assert.ok(/NO TRADE|porta/i.test(bz.description));
  assert.ok(/sem martingale/i.test(bz.description));
  assert.ok(/NÃO garante|não garante/i.test(bz.description));
  assert.ok(/10/.test(bz.description));
});

test("nenhum nome de estratégia sugere martingale", () => {
  for (const p of STRATEGY_PRESETS) {
    for (const s of p.strategies()) {
      assert.ok(!/martingale|double.?stake|recupera/i.test(s.name));
    }
  }
});
