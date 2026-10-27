import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CandlePaperSession } from "../src/core/candle-paper.ts";
import type { CandlePaperConfig } from "../src/core/candle-paper.ts";
import {
  STRATEGY_PRESETS, strategyPreset, strategiesForPreset, oosMinForPreset, strategyLibrary, giroDiarioStrategySet,
  GIRO_DIARIO_TARGET_R, GIRO_DIARIO_LOSS_R, GIRO_DIARIO_GRANULARITIES, GIRO_DIARIO_DEFAULT_GRANULARITY, GIRO_DIARIO_DISCLAIMER,
} from "../src/core/strategies.ts";
import type { Strategy, Signal } from "../src/core/strategies.ts";
import { GATE_ALPHA } from "../src/core/gate.ts";
import { requiredOosForCandleMinLabel } from "../src/core/candle-gate.ts";
import { PRELIMINARY_MIN_OBS, AGILE_MIN_OBS, EVIDENCE_MIN_OBS } from "../src/core/stats.ts";
import { MARKETS } from "../src/core/markets.ts";
import { validateCloudArmCreate, createCloudArmJob, advanceCloudArmJob, CLOUD_ARM_MODE } from "../src/core/cloud-arm.ts";
import { GATE_PRESET_IDS } from "../src/core/gate-service.ts";
import type { Candle } from "../src/core/market-data.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = "Giro Diário: sem garantia de lucro diário — mais oportunidades testadas, não mais certezas";

const always = (sig: Signal): Strategy => ({ name: `sempre ${sig}`, signals: (c) => c.map((_, i) => (i >= 20 ? sig : 0)) });
const never: Strategy = { name: "nunca", signals: (c) => c.map(() => 0 as Signal) };

function trend(n: number, dir: 1 | -1, t0 = 1_700_000_000): Candle[] {
  const out: Candle[] = [];
  let p = 1000;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p + dir;
    out.push({ epoch: t0 + i * 300, open: o, close: c, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2 });
    p = c;
  }
  return out;
}

function cfg(strategy: Strategy, over: Partial<CandlePaperConfig> = {}): CandlePaperConfig {
  return {
    strategy, stake: 1, slAtr: 1, tpR: 1.5, maxBars: 50, costFraction: 0,
    maxLoss: 100, maxTrades: 50, maxDurationMs: 12 * 3600 * 1000, maxConsecutiveLosses: 20, cooldownCandles: 0,
    dailyTargetR: GIRO_DIARIO_TARGET_R, dailyLossR: GIRO_DIARIO_LOSS_R, ...over,
  };
}

function run(c: CandlePaperConfig, candles: Candle[]) {
  const s = new CandlePaperSession(c);
  s.start(candles[0]!.epoch * 1000);
  const evs = candles.flatMap((x) => s.onCandle(x));
  return { s, evs };
}

test("Giro Diário: constantes — meta +3R, limite −3R, 5m padrão (1m opcional), texto exacto", () => {
  assert.equal(GIRO_DIARIO_TARGET_R, 3);
  assert.equal(GIRO_DIARIO_LOSS_R, 3);
  assert.equal(GIRO_DIARIO_DEFAULT_GRANULARITY, 300);
  assert.deepEqual([...GIRO_DIARIO_GRANULARITIES], [300, 60]);
  assert.equal(GIRO_DIARIO_DISCLAIMER, TEXT);
});

test("Giro Diário: para ao atingir +3R no dia (daily_target) e não abre mais", () => {
  const { s, evs } = run(cfg(always(1)), trend(200, 1));
  const sum = s.summary();
  assert.equal(sum.status, "STOPPED");
  assert.equal(sum.stopReason, "daily_target");
  assert.ok(sum.metrics.netR >= 3);
  assert.equal(sum.closed, 2); // 2 × 1,5R = 3R
  assert.equal(evs.filter((e) => e.type === "trade_opened").length, 2);
});

test("Giro Diário: para ao bater o limite de perda −3R (daily_loss_limit), stake fixa", () => {
  const { s, evs } = run(cfg(always(1)), trend(200, -1));
  const sum = s.summary();
  assert.equal(sum.stopReason, "daily_loss_limit");
  assert.ok(sum.metrics.netR <= -3);
  assert.equal(sum.closed, 3);
  for (const e of evs) if (e.type === "trade_closed") assert.equal(Math.abs(e.pnl - e.r * 1) < 1e-12, true); // pnl = r × stake fixa
});

test("Giro Diário: sem sinal válido o dia todo → NO TRADE (0 operações, não força entrada)", () => {
  const { s, evs } = run(cfg(never), trend(140, 1)); // < 12 h de velas 5m
  assert.equal(s.summary().opened, 0);
  assert.equal(s.summary().status, "RUNNING");
  assert.equal(evs.filter((e) => e.type === "trade_opened").length, 0);
});

test("Giro Diário: sem limites diários o comportamento antigo não muda", () => {
  const { s } = run(cfg(always(1), { dailyTargetR: undefined, dailyLossR: undefined }), trend(200, 1));
  assert.notEqual(s.summary().stopReason, "daily_target");
  assert.throws(() => new CandlePaperSession(cfg(never, { dailyTargetR: 0 })));
  assert.throws(() => new CandlePaperSession(cfg(never, { dailyLossR: -3 })));
});

test("Giro Diário: preset registado, só estratégias da biblioteca, porta 100 OOS com p < 0,01 (portas e custo intactos)", () => {
  const p = strategyPreset("giro_diario")!;
  assert.equal(p.label, "Giro Diário");
  assert.equal(p.preferredGate!.minLabel, "PRELIMINARY");
  assert.equal(oosMinForPreset("giro_diario"), 100);
  assert.equal(requiredOosForCandleMinLabel("PRELIMINARY"), 100);
  assert.equal(PRELIMINARY_MIN_OBS, 100);
  assert.equal(AGILE_MIN_OBS, 10);
  assert.equal(EVIDENCE_MIN_OBS, 1000);
  assert.equal(GATE_ALPHA, 0.01);
  assert.equal(MARKETS.crypto.assumedCostFraction, 0.001);
  assert.equal(oosMinForPreset("loss_zero"), 1000);
  assert.equal(oosMinForPreset("lucro_rapido"), 100);
  assert.equal(oosMinForPreset("blitz_zero"), 10);
  const lib = new Set(strategyLibrary().map((s) => s.name));
  for (const s of giroDiarioStrategySet()) assert.ok(lib.has(s.name), `${s.name} não está na biblioteca`);
  assert.equal(strategiesForPreset("giro_diario").length, 4);
  assert.match(p.description, /Giro Diário: sem garantia de lucro diário/);
  assert.equal(STRATEGY_PRESETS.at(-1)!.id, "giro_diario");
  assert.deepEqual([...GATE_PRESET_IDS], ["lucro_rapido", "loss_zero", "blitz_zero"]);
  // selecção documentada e reproduzível
  const sel = JSON.parse(readFileSync(join(root, "notes/data/giro-select-2026-10-27.json"), "utf8"));
  assert.deepEqual(sel.chosen, giroDiarioStrategySet().map((s) => s.name));
});

test("Giro Diário na nuvem: PAPER por omissão, só 5m/1m, limites diários ligados e porta fechada → NO TRADE", () => {
  const base = { symbol: "BTCUSDT", strategyPreset: "giro_diario", stake: 1, leverage: 5, durationMinutes: 720, clientId: "client_giro_1" };
  assert.equal(validateCloudArmCreate({ ...base, granularity: 300 }).mode, "PAPER");
  assert.equal(CLOUD_ARM_MODE, "PAPER");
  assert.equal(validateCloudArmCreate({ ...base, granularity: 60 }).granularity, 60);
  assert.throws(() => validateCloudArmCreate({ ...base, granularity: 900 }), /5 min ou 1 min/);
  const armSrc = readFileSync(join(root, "src/core/cloud-arm.ts"), "utf8");
  assert.match(armSrc, /dailyTargetR: GIRO_DIARIO_TARGET_R, dailyLossR: GIRO_DIARIO_LOSS_R/);
  const t0 = 1_700_000_000;
  const job = createCloudArmJob({ ...base, granularity: 300 }, (t0 + 300 * 300) * 1000);
  // passeio aleatório determinístico sem tendência: sem evidência → porta fechada → 0 operações
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cs: Candle[] = []; let px = 100;
  for (let i = 0; i < 600; i++) { const o = px; px = px * (1 + (rnd() - 0.5) * 0.004); cs.push({ epoch: t0 + i * 300, open: o, close: px, high: Math.max(o, px) * 1.001, low: Math.min(o, px) * 0.999 }); }
  const after = advanceCloudArmJob(job, cs, (t0 + 600 * 300) * 1000);
  assert.equal(after.gate!.allowed, false);
  assert.equal(after.summary.opened, 0);
  assert.equal(after.summary.netR, 0);
});

test("Painel /bybit: texto exacto do Giro Diário, opção, chips da porta e campos R de hoje / paragem", () => {
  const html = readFileSync(join(root, "public/bybit.html"), "utf8");
  const js = readFileSync(join(root, "public/assets/bybit.js"), "utf8");
  assert.ok(html.includes(TEXT));
  assert.ok(js.includes(TEXT));
  assert.match(html, /<option value="giro_diario">Giro Diário<\/option>/);
  assert.match(html, /data-preset="giro_diario"/);
  assert.match(html, /porta 100 · p&lt;0,01/);
  assert.match(html, /id="gateGiroDiario"/);
  assert.match(html, /id="rGiroDiario">R de hoje/);
  assert.match(html, /id="stopGiroDiario"/);
  assert.match(js, /daily_target/);
  assert.match(js, /daily_loss_limit/);
  assert.match(js, /giroDailyLimits\(\)/);
  // Deriv OAuth intocado
  for (const f of ["public/index.html", "public/callback.html", "api/token.js"]) assert.ok(readFileSync(join(root, f), "utf8").length > 0);
});
