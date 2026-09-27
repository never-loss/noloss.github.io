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

test("validate: rejects REAL/non-USDT/over-3h", () => {
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
  const ok = validateCloudArmCreate({
    symbol: "btcusdt", strategyPreset: "loss_zero", stake: 1, leverage: 2,
    granularity: 300, durationMinutes: 30, clientId: "c_abcdefgh",
  });
  assert.equal(ok.symbol, "BTCUSDT");
  assert.equal(ok.durationMs, 30 * 60 * 1000);
});

test("create job is PAPER with endsAt = started + duration", () => {
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
  const pub = publicCloudArmJob(job);
  assert.equal(pub.mode, "PAPER");
  assert.ok(typeof pub.remainingMs === "number");
});

test("advance: timer ends job at endsAt (max_duration)", () => {
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
    durationMinutes: 15,
    clientId: "c_testclient02",
  }, startedAt);
  // Far past endsAt
  const advanced = advanceCloudArmJob(job, candles, startedAt + 20 * 60 * 1000);
  assert.equal(advanced.status, "STOPPED");
  assert.equal(advanced.stopReason, "max_duration");
  assert.equal(advanced.mode, "PAPER");
});

test("cancel marks CANCELLED", () => {
  const job = createCloudArmJob({
    symbol: "SOLUSDT",
    strategyPreset: "biblioteca",
    stake: 2,
    leverage: 1,
    granularity: 300,
    durationMinutes: 60,
    clientId: "c_testclient03",
  }, Date.now());
  const cancelled = cancelCloudArmJob(job, Date.now());
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.stopReason, "manual");
});

test("closedCandlesOnly filters forming candle", () => {
  const nowMs = 1_700_000_000_000;
  const gran = 300;
  const candles: Candle[] = [
    { epoch: 1_700_000_000 - 600, open: 1, high: 2, low: 0.5, close: 1.5 },
    { epoch: Math.floor(nowMs / 1000) - 10, open: 1, high: 2, low: 0.5, close: 1.5 }, // still forming
  ];
  const closed = closedCandlesOnly(candles, gran, nowMs);
  assert.equal(closed.length, 1);
});

test("API files: PAPER-only + no Deriv OAuth touch", () => {
  const jobs = readFileSync(join(root, "api/bybit-arm.js"), "utf8");
  const tick = readFileSync(join(root, "api/bybit-arm.js"), "utf8");
  const store = readFileSync(join(root, "lib/arm-store.js"), "utf8");
  assert.match(jobs, /Force PAPER/);
  assert.match(jobs, /createCloudArmJob/);
  assert.match(tick, /advanceCloudArmJob/);
  assert.match(store, /UPSTASH_REDIS_REST/);
  assert.match(store, /ephemeral|memory/);
  // OAuth files untouched — existence check via git in CI; here assert we don't import token
  assert.doesNotMatch(jobs, /token\.js|deriv/i);
  assert.ok(readFileSync(join(root, "api/bybit-arm.js"), "utf8").includes("advanceCloudArmJob"));
  // Cron optional on Hobby — lazy advance on GET is the primary path; external cron can hit /api/bybit-arm?tick=1.
});

test("UI: neste ecrã vs nuvem labels + chart light history", () => {
  const bybitJs = readFileSync(join(root, "public/assets/bybit.js"), "utf8");
  const bybitHtml = readFileSync(join(root, "public/bybit.html"), "utf8");
  assert.match(bybitHtml, /Armar na nuvem \(PAPER\)/);
  assert.match(bybitHtml, /ARMAR neste ecrã/);
  assert.match(bybitHtml, /btnCloudArm/);
  assert.match(bybitJs, /CHART_HISTORY = 96/);
  assert.match(bybitJs, /startCloudArm/);
  assert.match(bybitJs, /setData\(\[\]\)/);
  assert.match(bybitJs, /wsProxTick/);
  // No REAL cloud path
  assert.match(bybitJs, /mode: "PAPER"/);
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
