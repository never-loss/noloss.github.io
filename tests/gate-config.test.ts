// Configuração de plataforma (Vercel Hobby) e coerência do bundle do servidor com o código-fonte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configInfo, gateSetup, GATE_PRESET_IDS, GATE_TAIL_KEEP, GATE_COLD_DAYS, computeGateEntry } from "../src/core/gate-service.ts";
// @ts-expect-error bundle gerado
import * as bundle from "../lib/nl-gate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
  crons: { path: string; schedule: string }[];
  functions?: Record<string, { maxDuration?: number }>;
};

test("Hobby: crons só 1x/dia (minuto e hora fixos), <= 100 por projecto", () => {
  assert.ok(vercel.crons.length <= 100);
  for (const c of vercel.crons) {
    const [min, hour, dom, mon, dow] = c.schedule.split(" ");
    assert.ok(/^\d+$/.test(min!) && /^\d+$/.test(hour!), `cron diário: ${c.schedule}`);
    assert.equal(`${dom} ${mon} ${dow}`, "* * *");
  }
  assert.ok(vercel.crons.some((c) => c.path === "/api/bybit-klines?mode=gate-backfill"));
  // os crons do arm continuam como estavam
  assert.ok(vercel.crons.some((c) => c.path === "/api/bybit-arm?tick=1" && c.schedule === "0 7 * * *"));
  assert.ok(vercel.crons.some((c) => c.path === "/api/bybit-arm?tick=1" && c.schedule === "0 19 * * *"));
});

test("maxDuration do endpoint da porta <= 300 s (máximo do Hobby) e suficiente para o backfill (40 s)", () => {
  for (const f of ["api/bybit-klines.js", "api/bybit-arm.js"]) {
    const d = vercel.functions?.[f]?.maxDuration;
    assert.ok(d !== undefined && d >= 45 && d <= 300, `maxDuration ${f}: ${d}`);
  }
});

test("bundle do servidor (lib/nl-gate.mjs) está em dia com o código-fonte: mesmos hashes e mesmo resultado", () => {
  // Se falhar: npm run build:gate
  const src = configInfo(GATE_PRESET_IDS.map((id) => gateSetup(id)));
  const bun = bundle.configInfo(GATE_PRESET_IDS.map((id: string) => bundle.gateSetup(id)));
  assert.deepStrictEqual(bun, src);
  assert.equal(bundle.GATE_TAIL_KEEP, GATE_TAIL_KEEP);
  assert.equal(bundle.GATE_COLD_DAYS, GATE_COLD_DAYS);
  const candles = Array.from({ length: 3000 }, (_, i) => {
    const p = 100 + Math.sin(i / 30) * 2 + (i % 7) * 0.05;
    return { epoch: 1_700_000_100 + i * 300, open: p, high: p + 0.4, low: p - 0.4, close: p + 0.1 };
  });
  assert.deepStrictEqual(bundle.computeGateEntry(null, "XUSDT", candles, 1), computeGateEntry(null, "XUSDT", candles, 1));
});
