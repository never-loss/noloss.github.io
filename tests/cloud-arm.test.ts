import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCloudArmJob,
  advanceCloudArmJob,
  cancelCloudArmJob,
  validateCloudArmCreate,
  closedCandlesOnly,
  publicCloudArmJob,
  pendingRealMirrors,
  markRealMirrorsApplied,
  cloudArmEventKey,
  CLOUD_ARM_MODE,
} from "../src/core/cloud-arm.ts";
import type { Candle } from "../src/core/market-data.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function synth(n: number, startEpoch = 1_700_000_000, step = 300): Candle[] {
  const out: Candle[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const open = px;
    const close = px + Math.sin(i / 9) * 0.8;
    out.push({
      epoch: startEpoch + i * step,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
    });
    px = close;
  }
  return out;
}

test("validate: rejects non-USDT/over-3h/bad mode; accepts PAPER|REAL", () => {
  assert.equal(CLOUD_ARM_MODE, "PAPER");
  assert.throws(() => validateCloudArmCreate({
    symbol: "BTCUSD", strategyPreset: "lucro_rapido", stake: 1, leverage: 1,
    granularity: 300, durationMinutes: 60, clientId: "c_abcdefgh",
  }));
  assert.throws(() => validateCloudArmCreate({
    symbol: "BTCUSDT", strategyPreset: "nope", stake: 1, leverage: 1,
    granularity: 300, durationMinutes: 60, clientId: "c_abcdefgh",
  }));
  assert.throws(() => validateCloudArmCreate({
    symbol: "BTCUSDT", strategyPreset: "lucro_rapido", stake: 1, leverage: 1,
    granularity: 300, durationMinutes: 200, clientId: "c_abcdefgh",
  }));
  assert.throws(() => validateCloudArmCreate({
    symbol: "BTCUSDT", strategyPreset: "lucro_rapido", stake: 1, leverage: 1,
    granularity: 300, durationMinutes: 60, clientId: "c_abcdefgh", mode: "SPOT",
  }));
  const ok = validateCloudArmCreate({
    symbol: "btcusdt", strategyPreset: "loss_zero", stake: 1, leverage: 2,
    granularity: 300, durationMinutes: 30, clientId: "c_abcdefgh",
  });
  assert.equal(ok.symbol, "BTCUSDT");
  assert.equal(ok.durationMs, 30 * 60 * 1000);
  assert.equal(ok.mode, "PAPER");
  const real = validateCloudArmCreate({
    symbol: "ETHUSDT", strategyPreset: "lucro_rapido", stake: 0.5, leverage: 1,
    granularity: 300, durationMinutes: 15, clientId: "c_abcdefgh", mode: "REAL",
  });
  assert.equal(real.mode, "REAL");
  assert.equal(real.stake, 0.5);
});

test("create job defaults PAPER; REAL when requested", () => {
  const now = 1_800_000_000_000;
  const job = createCloudArmJob({
    symbol: "ETHUSDT",
    strategyPreset: "lucro_rapido",
    stake: 1,
    leverage: 1,
    granularity: 300,
    durationMinutes: 45,
    clientId: "c_testclient01",
  }, now);
  assert.equal(job.mode, "PAPER");
  assert.equal(job.status, "RUNNING");
  assert.equal(job.endsAt, now + 45 * 60 * 1000);
  assert.equal(job.symbol, "ETHUSDT");
  assert.equal(job.realOpenQty, null);
  assert.deepEqual(job.realAppliedEventKeys, []);
  const pub = publicCloudArmJob(job);
  assert.equal(pub.mode, "PAPER");
  assert.ok(typeof pub.remainingMs === "number");

  const real = createCloudArmJob({
    symbol: "BTCUSDT",
    strategyPreset: "loss_zero",
    stake: 1,
    leverage: 1,
    granularity: 300,
    durationMinutes: 30,
    clientId: "c_testclient01",
    mode: "REAL",
  }, now);
  assert.equal(real.mode, "REAL");
  assert.equal(publicCloudArmJob(real).mode, "REAL");
});

test("advance: timer ends job at endsAt (max_duration) — PAPER and REAL", () => {
  const gran = 300;
  const startEpoch = 1_700_000_000;
  const candles = synth(1800, startEpoch, gran);
  const startedAt = (startEpoch + 1600) * 1000;
  for (const mode of ["PAPER", "REAL"] as const) {
    const job = createCloudArmJob({
      symbol: "BTCUSDT",
      strategyPreset: "lucro_rapido",
      stake: 1,
      leverage: 1,
      granularity: gran,
      durationMinutes: 15,
      clientId: "c_testclient02",
      mode,
    }, startedAt);
    const advanced = advanceCloudArmJob(job, candles, startedAt + 20 * 60 * 1000);
    assert.equal(advanced.status, "STOPPED");
    assert.equal(advanced.stopReason, "max_duration");
    assert.equal(advanced.mode, mode);
  }
});

test("advance REAL does not throw; pendingRealMirrors de-dupes applied keys", () => {
  const gran = 300;
  const startEpoch = 1_700_000_000;
  const candles = synth(1800, startEpoch, gran);
  const startedAt = (startEpoch + 1600) * 1000;
  const job = createCloudArmJob({
    symbol: "BTCUSDT",
    strategyPreset: "lucro_rapido",
    stake: 1,
    leverage: 1,
    granularity: gran,
    durationMinutes: 60,
    clientId: "c_testclient04",
    mode: "REAL",
  }, startedAt);
  const after = advanceCloudArmJob(job, candles, startedAt + 10 * 60 * 1000);
  assert.equal(after.mode, "REAL");
  assert.ok(after.status === "RUNNING" || after.status === "STOPPED");

  // Inject synthetic trade events to test mirror de-dupe without needing gate hits.
  const withOpen = {
    ...after,
    events: [
      ...after.events,
      { type: "trade_opened", at: startedAt + 1000, text: "ABRE", direction: 1, entry: 100 },
      { type: "trade_closed", at: startedAt + 2000, text: "FECHA", direction: 1, r: 1.2, pnl: 1.2, entry: 100 },
    ],
  };
  const pending1 = pendingRealMirrors(job, withOpen);
  assert.equal(pending1.length, 2);
  assert.equal(pending1[0].action, "open");
  assert.equal(pending1[0].side, "BUY");
  assert.equal(pending1[1].action, "close");
  assert.equal(pending1[1].side, "SELL");

  const marked = markRealMirrorsApplied(withOpen, pending1.map((p) => p.key), {
    qty: "0.01",
    side: "BUY",
  });
  assert.equal(marked.realOpenQty, "0.01");
  assert.equal(marked.realOpenSide, "BUY");
  const pending2 = pendingRealMirrors(withOpen, marked);
  assert.equal(pending2.length, 0, "already applied keys must not re-fire");

  // Rebuild-style advance preserves markers
  const rebuilt = advanceCloudArmJob(marked, candles, startedAt + 11 * 60 * 1000);
  assert.deepEqual(rebuilt.realAppliedEventKeys, marked.realAppliedEventKeys);
  assert.equal(rebuilt.realOpenQty, "0.01");
});

test("cancel REAL with open mirrored position sets needsRealFlatten", () => {
  const job = createCloudArmJob({
    symbol: "SOLUSDT",
    strategyPreset: "biblioteca",
    stake: 2,
    leverage: 1,
    granularity: 300,
    durationMinutes: 60,
    clientId: "c_testclient03",
    mode: "REAL",
  }, Date.now());
  const withPos = { ...job, realOpenQty: "1.5", realOpenSide: "BUY" as const };
  const cancelled = cancelCloudArmJob(withPos, Date.now());
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.stopReason, "manual");
  assert.equal(cancelled.needsRealFlatten, true);
  assert.equal(publicCloudArmJob(cancelled).needsRealFlatten, true);

  const paper = createCloudArmJob({
    symbol: "SOLUSDT",
    strategyPreset: "biblioteca",
    stake: 2,
    leverage: 1,
    granularity: 300,
    durationMinutes: 60,
    clientId: "c_testclient03",
  }, Date.now());
  const cancelledPaper = cancelCloudArmJob(paper, Date.now());
  assert.equal(cancelledPaper.needsRealFlatten, false);
});

test("cloudArmEventKey stable", () => {
  assert.equal(
    cloudArmEventKey({ type: "trade_opened", at: 1, direction: 1 }),
    "trade_opened:1:1:",
  );
  assert.equal(
    cloudArmEventKey({ type: "trade_closed", at: 2, direction: -1, r: 0.5 }),
    "trade_closed:2:-1:0.5",
  );
});

test("closedCandlesOnly filters forming candle", () => {
  const nowMs = 1_700_000_000_000;
  const gran = 300;
  const candles: Candle[] = [
    { epoch: 1_700_000_000 - 600, open: 1, high: 2, low: 0.5, close: 1.5 },
    { epoch: Math.floor(nowMs / 1000) - 10, open: 1, high: 2, low: 0.5, close: 1.5 },
  ];
  const closed = closedCandlesOnly(candles, gran, nowMs);
  assert.equal(closed.length, 1);
});

test("API files: PAPER|REAL + confirmReal + no Deriv OAuth touch", () => {
  const jobs = readFileSync(join(root, "api/bybit-arm.js"), "utf8");
  const store = readFileSync(join(root, "lib/arm-store.js"), "utf8");
  const place = readFileSync(join(root, "lib/bybit-place.js"), "utf8");
  const vercel = readFileSync(join(root, "vercel.json"), "utf8");
  assert.match(jobs, /confirmReal/);
  assert.match(jobs, /pendingRealMirrors/);
  assert.match(jobs, /placeLinearMarketOrder/);
  assert.match(jobs, /keys_missing/);
  assert.match(jobs, /createCloudArmJob/);
  assert.match(jobs, /advanceCloudArmJob/);
  assert.doesNotMatch(jobs, /Force PAPER/);
  assert.match(store, /UPSTASH_REDIS_REST|KV_REST_API/);
  assert.match(store, /ephemeral|memory/);
  assert.match(place, /placeLinearMarketOrder/);
  assert.match(vercel, /bybit-arm\?tick=1/);
  assert.match(vercel, /crons/);
  assert.doesNotMatch(jobs, /token\.js|deriv/i);
});

test("UI: cloud follows PAPER/REAL toggle + chart light history", () => {
  const bybitJs = readFileSync(join(root, "public/assets/bybit.js"), "utf8");
  const bybitHtml = readFileSync(join(root, "public/bybit.html"), "utf8");
  assert.match(bybitHtml, /Armar na nuvem \(Simulado\)/);
  assert.match(bybitHtml, /ARMAR neste ecrã/);
  assert.match(bybitHtml, /btnCloudArm/);
  assert.match(bybitHtml, /segue o toggle PAPER\/REAL/i);
  assert.match(bybitJs, /CHART_HISTORY = 96/);
  assert.match(bybitJs, /startCloudArm/);
  assert.match(bybitJs, /setData\(\[\]\)/);
  assert.match(bybitJs, /wsProxTick/);
  assert.match(bybitJs, /confirmReal\s*=\s*true|confirmReal:\s*true/);
  assert.match(bybitJs, /Armar na nuvem \(REAL\)/);
  assert.match(bybitJs, /Armar na nuvem \(Simulado\)/);
  assert.match(bybitJs, /isRealTradingMode\(\)\s*\?\s*"REAL"\s*:\s*"PAPER"/);
});

test("validateCloudArmCreate aceita blitz_zero", () => {
  const v = validateCloudArmCreate({
    symbol: "ETHUSDT",
    strategyPreset: "blitz_zero",
    stake: 1,
    leverage: 1,
    granularity: 60,
    durationMinutes: 30,
    clientId: "c_blitzzero1",
  });
  assert.equal(v.strategyPreset, "blitz_zero");
  assert.equal(v.granularity, 60);
});

test("cloud-arm e presets: Agressivo (blitz_zero) = porta AGILE 10 + maxTrades 10", async () => {
  const { strategyPreset, oosMinForPreset } = await import("../src/core/strategies.ts");
  const bz = strategyPreset("blitz_zero")!;
  assert.equal(bz.label, "Agressivo");
  assert.equal(bz.preferredGate?.minLabel, "AGILE");
  assert.equal(bz.preferredGate?.maxBars, 10);
  assert.equal(oosMinForPreset("blitz_zero"), 10);
  const armSrc = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/core/cloud-arm.ts", import.meta.url), "utf8"),
  );
  assert.match(armSrc, /strategyPreset === "blitz_zero" \? 10 : 50/);
});
