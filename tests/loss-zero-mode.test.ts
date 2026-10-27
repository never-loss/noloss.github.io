import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lossZeroModeSpec, lossZeroModeForPreset, canSwitchLossZeroMode, giroDailyProgress, GIRO_STOP_LABELS } from "../src/core/loss-zero-mode.ts";
import { oosMinForPreset, strategyPreset } from "../src/core/strategies.ts";
import type { Strategy, Signal } from "../src/core/strategies.ts";
import { GATE_ALPHA } from "../src/core/gate.ts";
import { MARKETS } from "../src/core/markets.ts";
import { CandlePaperSession } from "../src/core/candle-paper.ts";
import { validateCloudArmCreate, CLOUD_ARM_MODE } from "../src/core/cloud-arm.ts";
import type { Candle } from "../src/core/market-data.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = "Giro Diário: sem garantia de lucro diário — mais oportunidades testadas, não mais certezas";
const html = readFileSync(join(root, "public/bybit.html"), "utf8");
const js = readFileSync(join(root, "public/assets/bybit.js"), "utf8");

test("Modo Loss zero padrão: preset loss_zero, porta 1000 inalterada", () => {
  const s = lossZeroModeSpec("padrao");
  assert.equal(s.preset, "loss_zero");
  assert.equal(s.minOos, 1000);
  assert.equal(oosMinForPreset("loss_zero"), 1000);
  assert.equal(strategyPreset("loss_zero")!.preferredGate!.minLabel, "EVIDENCE");
  assert.equal(s.dailyTargetR, null);
  assert.deepEqual(s.chips, ["porta 1000"]);
  assert.equal(MARKETS.crypto.assumedCostFraction, 0.001);
});

test("Modo Giro Diário: preset giro_diario com a SUA porta (100 OOS, p<0,01), 5m/1m, +3R/−3R, texto", () => {
  const s = lossZeroModeSpec("giro_diario");
  assert.equal(s.preset, "giro_diario");
  assert.equal(s.minOos, 100);
  assert.equal(s.alpha, 0.01);
  assert.equal(GATE_ALPHA, 0.01);
  assert.deepEqual([...s.granularities!], [300, 60]);
  assert.equal(s.dailyTargetR, 3);
  assert.equal(s.dailyLossR, 3);
  assert.deepEqual(s.chips, ["5m/1m", "porta 100 · p<0,01", "meta +3R", "limite −3R"]);
  assert.equal(s.disclaimer, TEXT);
  assert.equal(lossZeroModeForPreset("giro_diario"), "giro_diario");
  assert.equal(lossZeroModeForPreset("loss_zero"), "padrao");
  assert.equal(lossZeroModeForPreset("lucro_rapido"), null);
});

test("Modo bloqueado enquanto armado (local ou nuvem) ou em pausa; livre só com STOP", () => {
  assert.equal(canSwitchLossZeroMode({}), true);
  assert.equal(canSwitchLossZeroMode({ running: true }), false);
  assert.equal(canSwitchLossZeroMode({ paused: true }), false);
  assert.equal(canSwitchLossZeroMode({ cloudRunning: true }), false);
  assert.equal(canSwitchLossZeroMode({ cloudScheduled: true }), false);
  assert.match(js, /function setLossZeroMode[\s\S]*?if \(!lzCanSwitch\(\)\)[\s\S]*?STOP/);
  assert.match(js, /btn\.disabled = !can;/);
});

test("Progresso das metas do dia: meta +3R e limite −3R, o que vier primeiro", () => {
  assert.deepEqual([giroDailyProgress(1.5).targetPct, giroDailyProgress(1.5).lossPct], [50, 0]);
  assert.deepEqual([giroDailyProgress(-2).targetPct, giroDailyProgress(-2).lossPct], [0, 67]);
  assert.equal(giroDailyProgress(0).stop, null);
  assert.equal(giroDailyProgress(3).stopText, "Meta +3R atingida");
  assert.equal(giroDailyProgress(-3).stopText, "Limite de perda −3R atingido");
  assert.equal(giroDailyProgress(0.2, "daily_loss_limit").stop, "daily_loss_limit");
  assert.equal(GIRO_STOP_LABELS.daily_target, "Meta +3R atingida");
});

const always = (sig: Signal): Strategy => ({ name: `sempre ${sig}`, signals: (c) => c.map((_, i) => (i >= 20 ? sig : 0)) });
function trend(n: number, dir: 1 | -1, t0 = 1_700_000_000): Candle[] {
  const out: Candle[] = []; let p = 1000;
  for (let i = 0; i < n; i++) { const o = p, c = p + dir; out.push({ epoch: t0 + i * 300, open: o, close: c, high: Math.max(o, c) + 0.2, low: Math.min(o, c) - 0.2 }); p = c; }
  return out;
}
function runMode(dir: 1 | -1) {
  const spec = lossZeroModeSpec("giro_diario");
  const s = new CandlePaperSession({
    strategy: always(1), stake: 1, slAtr: 1, tpR: 1.5, maxBars: 50, costFraction: 0, maxLoss: 100, maxTrades: 50,
    maxDurationMs: 12 * 3600 * 1000, maxConsecutiveLosses: 20, cooldownCandles: 0,
    dailyTargetR: spec.dailyTargetR!, dailyLossR: spec.dailyLossR!,
  });
  const cs = trend(200, dir); s.start(cs[0]!.epoch * 1000);
  const evs = cs.flatMap((c) => s.onCandle(c));
  return { sum: s.summary(), evs };
}

test("Modo Giro Diário no cartão Loss zero: para na meta +3R (Meta +3R atingida)", () => {
  const { sum, evs } = runMode(1);
  assert.equal(sum.stopReason, "daily_target");
  assert.ok(sum.metrics.netR >= 3);
  assert.equal(giroDailyProgress(sum.metrics.netR, sum.stopReason).stopText, "Meta +3R atingida");
  assert.equal(evs.filter((e) => e.type === "trade_opened").length, 2);
});

test("Modo Giro Diário no cartão Loss zero: para no limite −3R (Limite de perda −3R atingido), stake fixa", () => {
  const { sum, evs } = runMode(-1);
  assert.equal(sum.stopReason, "daily_loss_limit");
  assert.ok(sum.metrics.netR <= -3);
  assert.equal(giroDailyProgress(sum.metrics.netR, sum.stopReason).stopText, "Limite de perda −3R atingido");
  for (const e of evs) if (e.type === "trade_closed") assert.ok(Math.abs(e.pnl - e.r * 1) < 1e-12);
});

test("Nuvem: o modo usa o preset giro_diario (PAPER por omissão, 5m/1m) e impõe +3R/−3R só nesse preset", () => {
  const base = { symbol: "BTCUSDT", stake: 1, leverage: 5, durationMinutes: 720, clientId: "client_lzmode_1" };
  const gd = validateCloudArmCreate({ ...base, strategyPreset: lossZeroModeSpec("giro_diario").preset, granularity: 300 });
  assert.equal(gd.mode, "PAPER"); assert.equal(CLOUD_ARM_MODE, "PAPER");
  assert.throws(() => validateCloudArmCreate({ ...base, strategyPreset: "giro_diario", granularity: 900 }));
  assert.equal(validateCloudArmCreate({ ...base, strategyPreset: lossZeroModeSpec("padrao").preset, granularity: 300 }).strategyPreset, "loss_zero");
  const src = readFileSync(join(root, "src/core/cloud-arm.ts"), "utf8");
  assert.match(src, /job\.strategyPreset === "giro_diario" \? \{ dailyTargetR: GIRO_DIARIO_TARGET_R, dailyLossR: GIRO_DIARIO_LOSS_R \}/);
  const bundle = readFileSync(join(root, "lib/nl-cloud.mjs"), "utf8");
  assert.match(bundle, /dailyTargetR/);
});

test("Painel /bybit: selector de modo no cartão Loss zero, texto exacto, metas e barras", () => {
  const card = html.slice(html.indexOf('id="cardLossZero"'), html.indexOf('id="cardBlitzZero"'));
  assert.match(card, /id="lzModeToggle"/);
  assert.match(card, /data-lz-mode="padrao"[^>]*>Loss zero padrão</);
  assert.match(card, /data-lz-mode="giro_diario"[^>]*>Giro Diário</);
  assert.ok(card.includes(TEXT));
  assert.match(card, /porta 1000/);
  assert.match(card, /Meta do dia \+3R/);
  assert.match(card, /Limite de perda −3R/);
  assert.match(card, /id="lzGoalTargetBar"/);
  assert.match(card, /id="lzGoalLossBar"/);
  assert.match(card, /id="lzGiroR">R de hoje/);
  assert.match(card, /id="lzGiroStop"/);
  // opção standalone do Giro Diário mantém-se
  assert.match(html, /<option value="giro_diario">Giro Diário<\/option>/);
  assert.match(html, /id="cardGiroDiario"/);
  assert.ok(js.includes(TEXT));
  assert.match(js, /presetId === "loss_zero" && state\.lzMode === "giro_diario"/);
});
