// api/bybit-arm.js — escolha do modo da porta (ledger/legacy) ponta a ponta, com Redis (Upstash) e Bybit simulados.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error JS sem tipos
import handler from "../api/bybit-arm.js";
// @ts-expect-error JS sem tipos
import * as gateStore from "../lib/gate-store.js";
// @ts-expect-error JS sem tipos
import * as armStore from "../lib/arm-store.js";
import { createCloudArmJob } from "../src/core/cloud-arm.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GRAN = 300;

interface Res { code: number; body: Record<string, unknown> }
function call(url: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const out: Res = { code: 200, body: {} };
    const res = {
      setHeader() {},
      status(c: number) { out.code = c; return res; },
      json(b: Record<string, unknown>) { out.body = b; resolve(out); return res; },
      end() { resolve(out); return res; },
    };
    Promise.resolve(handler({ method: "GET", url, headers: {} }, res)).catch(reject);
  });
}

// --- mundo simulado: Redis (comandos soltos e /pipeline) + Bybit klines ---
const hashes = new Map<string, Map<string, string>>();
const kv = new Map<string, string>();
const sets = new Map<string, Set<string>>();
let redisDown = false;
let bybitCalls = 0;
let rseed = 7;
const rnd = () => { rseed = (rseed * 1664525 + 1013904223) % 4294967296; return rseed / 4294967296; };

function runCmd(c: string[]): { result?: unknown; error?: string } {
  const [op, key, ...rest] = c;
  switch (op) {
    case "HSET": { const h = hashes.get(key!) ?? new Map(); for (let i = 0; i < rest.length; i += 2) h.set(rest[i]!, rest[i + 1]!); hashes.set(key!, h); return { result: rest.length / 2 }; }
    case "HMGET": { const h = hashes.get(key!); return { result: rest.map((f) => (h && h.has(f) ? h.get(f)! : null)) }; }
    case "HGET": { const h = hashes.get(key!); return { result: h && h.has(rest[0]!) ? h.get(rest[0]!) : null }; }
    case "HGETALL": { const h = hashes.get(key!); return { result: h ? [...h].flat() : [] }; }
    case "SET": { if (rest.includes("NX") && kv.has(key!)) return { result: null }; kv.set(key!, rest[0]!); return { result: "OK" }; }
    case "GET": return { result: kv.get(key!) ?? null };
    case "DEL": kv.delete(key!); return { result: 1 };
    case "INCR": { const n = Number(kv.get(key!) ?? 0) + 1; kv.set(key!, String(n)); return { result: n }; }
    case "EXPIRE": return { result: 1 };
    case "SADD": { const s = sets.get(key!) ?? new Set(); rest.forEach((x) => s.add(x)); sets.set(key!, s); return { result: 1 }; }
    case "SREM": { sets.get(key!)?.delete(rest[0]!); return { result: 1 }; }
    case "SMEMBERS": return { result: [...(sets.get(key!) ?? [])] };
    default: return { error: `ERR unknown ${op}` };
  }
}

const realFetch = globalThis.fetch;
function install(): void {
  globalThis.fetch = (async (input: string | URL, init?: { body?: string }) => {
    const u = new URL(String(input));
    if (u.hostname === "redis.example") {
      const body = JSON.parse(init!.body!);
      // "cache indisponível" = só as chaves da porta falham (o armazém dos jobs continua a responder)
      const cmds: string[][] = u.pathname === "/pipeline" ? (body as string[][]) : [body as string[]];
      if (redisDown && cmds.some((c) => String(c[1]).startsWith("nl:gate:"))) return new Response("down", { status: 500 });
      if (u.pathname === "/pipeline") return new Response(JSON.stringify((body as string[][]).map(runCmd)));
      return new Response(JSON.stringify(runCmd(body as string[])));
    }
    bybitCalls += 1;
    const start = Number(u.searchParams.get("start") ?? 0) / 1000;
    const end = (Number(u.searchParams.get("end") ?? Date.now()) + 1) / 1000;
    const limit = Number(u.searchParams.get("limit"));
    const lastStart = Math.floor(Date.now() / 1000 / GRAN) * GRAN - GRAN;
    const rows: string[][] = [];
    for (let e = Math.min(end - GRAN, lastStart + GRAN); e >= Math.max(start, 0) && rows.length < limit; e -= GRAN) {
      const p = 100 + Math.sin(e / 5000) * 3 + rnd() * 0.2;
      rows.push([String(e * 1000), String(p), String(p + 0.3), String(p - 0.3), String(p + 0.05), "10", "1"]);
    }
    return new Response(JSON.stringify({ retCode: 0, result: { list: rows } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const REDIS_ENV = { UPSTASH_REDIS_REST_URL: "https://redis.example", UPSTASH_REDIS_REST_TOKEN: "t" };
beforeEach(() => {
  hashes.clear(); kv.clear(); sets.clear(); redisDown = false; bybitCalls = 0; rseed = 7;
  gateStore._resetGateMemory(); armStore._resetMemoryStore();
  delete process.env.CRON_SECRET; delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

function seedJob(preset: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return { ...createCloudArmJob({ symbol: "BTCUSDT", strategyPreset: preset, stake: 1, leverage: 1, granularity: 300, durationMinutes: 600, clientId: "client_test_1", mode: "PAPER" }, now - 2 * 3600_000), ...over };
}

test("job novo + Redis durável: modo ledger fixado no 1.º tick, 1 descarga profunda; ticks seguintes só velas novas", async () => {
  Object.assign(process.env, REDIS_ENV);
  const job = seedJob("blitz_zero");
  await armStore.saveArmJob(job);
  const r1 = await call(`/api/bybit-arm?id=${job.id}&clientId=client_test_1`);
  const j1 = r1.body.job as { gateMode: string; gate: { source: string; folds: number; streak: number }; status: string };
  assert.equal(j1.gateMode, "ledger");
  assert.equal(j1.gate.source, "ledger");
  assert.ok(j1.gate.folds > 10);
  assert.equal(r1.body.warning, undefined);
  const afterFirst = bybitCalls;
  assert.ok(afterFirst >= 26, `descarga profunda no arranque (${afterFirst})`);
  const saved = await armStore.getArmJob(job.id);
  assert.equal(saved.gateMode, "ledger");
  // 2.º tick: só velas novas (≤ 2 pedidos), mesmo modo
  const r2 = await call(`/api/bybit-arm?id=${job.id}&clientId=client_test_1`);
  assert.equal((r2.body.job as { gateMode: string }).gateMode, "ledger");
  assert.ok(bybitCalls - afterFirst <= 2, `pedidos no 2.º tick: ${bybitCalls - afterFirst}`);
});

test("modo ledger + cache indisponível → o tick é saltado (sem misturar dados parciais) e o job não muda", async () => {
  Object.assign(process.env, REDIS_ENV);
  const job = seedJob("blitz_zero");
  await armStore.saveArmJob(job);
  await call(`/api/bybit-arm?id=${job.id}&clientId=client_test_1`);
  const before = await armStore.getArmJob(job.id);
  redisDown = true;
  const r = await call(`/api/bybit-arm?id=${job.id}&clientId=client_test_1`);
  assert.match(String(r.body.warning), /advance_failed/);
  redisDown = false;
  const after = await armStore.getArmJob(job.id);
  assert.equal(after.lastTickAt, before.lastTickAt);
  assert.equal(after.gateMode, "ledger");
});

test("sem Redis durável: legacy (como antes)", async () => {
  const job = seedJob("blitz_zero");
  await armStore.saveArmJob(job);
  const r = await call(`/api/bybit-arm?id=${job.id}&clientId=client_test_1`);
  const j = r.body.job as { gateMode: string; gate: { source: string } };
  assert.equal(j.gateMode, "legacy");
  assert.equal(j.gate.source, "legacy");
});

test("job antigo em curso (já tinha ticks, sem gateMode) continua legacy mesmo com Redis", async () => {
  Object.assign(process.env, REDIS_ENV);
  const job = seedJob("lucro_rapido", { lastTickAt: Date.now() - 60_000 });
  await armStore.saveArmJob(job);
  const r = await call(`/api/bybit-arm?id=${job.id}&clientId=client_test_1`);
  assert.equal((r.body.job as { gateMode: string }).gateMode, "legacy");
});

test("presets fora da cache (Tendência diária) ficam legacy", async () => {
  Object.assign(process.env, REDIS_ENV);
  const job = seedJob("tendencia_diaria");
  await armStore.saveArmJob(job);
  const r = await call(`/api/bybit-arm?id=${job.id}&clientId=client_test_1`);
  assert.equal((r.body.job as { gateMode: string }).gateMode, "legacy");
});

test("código: PAPER por omissão, sem tocar na Deriv, modo decidido só no 1.º tick", () => {
  const api = readFileSync(join(root, "api/bybit-arm.js"), "utf8");
  assert.doesNotMatch(api, /deriv/i);
  assert.match(api, /gate_ledger_unavailable/);
  assert.match(api, /job\.lastTickAt == null/);
  assert.match(api, /gateStoreInfo\(\)\.durable/);
});
