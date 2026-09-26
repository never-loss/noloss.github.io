import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STRATEGY_PRESETS,
  strategyPreset,
  strategiesForPreset,
  lucroRapidoStrategySet,
  lossZeroStrategySet,
  strategyLibrary,
  dailyTrendStrategySet,
} from "../src/core/strategies.ts";

test("presets incluem Lucro rápido e Loss zero com labels exactos", () => {
  const labels = STRATEGY_PRESETS.map((p) => p.label);
  assert.ok(labels.includes("Lucro rápido"));
  assert.ok(labels.includes("Loss zero"));
  const lr = strategyPreset("lucro_rapido");
  const lz = strategyPreset("loss_zero");
  assert.ok(lr);
  assert.ok(lz);
  assert.equal(lr!.label, "Lucro rápido");
  assert.equal(lz!.label, "Loss zero");
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

test("Loss zero pede evidência mais forte; Lucro rápido aceita PRELIMINARY", () => {
  assert.equal(strategyPreset("loss_zero")!.preferredGate?.minLabel, "EVIDENCE");
  assert.equal(strategyPreset("lucro_rapido")!.preferredGate?.minLabel, "PRELIMINARY");
});

test("nenhum nome de estratégia sugere martingale", () => {
  for (const p of STRATEGY_PRESETS) {
    for (const s of p.strategies()) {
      assert.ok(!/martingale|double.?stake|recupera/i.test(s.name));
    }
  }
});
