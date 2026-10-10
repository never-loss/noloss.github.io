// api/bybit-klines.js — modos gate / gate-backfill (Bybit e Redis simulados via fetch global) + proxy clássico intacto.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JS sem tipos
import handler from "../api/bybit-klines.js";
// @ts-expect-error JS sem tipos
import * as store from "../lib/gate-store.js";

const GRAN = 300;
interface Res { code: number; body: unknown; headers: Record<string, string> }
function call(url: string, headers: Record<string, string> = {}, method = "GET"): Promise<Res> {
  return new Promise((resolve, reject) => {
    const out: Res = { code: 200, body: null, headers: {} };
    const res = {
      setHeader: (k: string, v: string) => { out.headers[k.toLowerCase()] = v; },
      status(c: number) { out.code = c; return res; },
      json(b: unknown) { out.body = b; resolve(out); return res; },
      send(b: unknown) { out.body = b; resolve(out); return res; },
      end() { resolve(out); return res; },
    };
    Promise.resolve(handler({ method, url, headers }, res)).catch(reject);
  });
}

let seedRand = 1;
function rnd(): number { seedRand = (seedRand * 1664525 + 1013904223) % 4294967296; return seedRand / 4294967296; }

const realFetch = globalThis.fetch;
let bybitCalls = 0;
let tickersBody: unknown = null;
function installFetch(): void {
  globalThis.fetch = (async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.pathname === "/v5/market/tickers") {
      return new Response(JSON.stringify(tickersBody ?? { result: { list: [] } }), { status: 200 });
    }
    bybitCalls += 1;
    const symbol = u.searchParams.get("symbol");
    if (symbol === "NOPEUSDT") return new Response(JSON.stringify({ retCode: 10001, retMsg: "Illegal category/symbol" }), { status: 200 });
    const start = Number(u.searchParams.get("start") ?? 0) / 1000;
    const end = (Number(u.searchParams.get("end")) + 1) / 1000;
    const limit = Number(u.searchParams.get("limit"));
    const nowS = Math.floor(Date.now() / 1000);
    const lastStart = Math.floor(nowS / GRAN) * GRAN;
    const rows: string[][] = [];
    for (let e = Math.min(end - GRAN, lastStart); e >= Math.max(start, 0) && rows.length < limit; e -= GRAN) {
      const p = 100 + Math.sin(e / 5000) * 3 + rnd() * 0.2;
      rows.push([String(e * 1000), String(p), String(p + 0.3), String(p - 0.3), String(p + 0.05), "10", "1"]);
    }
    return new Response(JSON.stringify({ retCode: 0, result: { list: rows } }), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  store._resetGateMemory();
  bybitCalls = 0;
  tickersBody = null;
  seedRand = 1;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.CRON_SECRET;
  delete process.env.ARM_CRON_SECRET;
  installFetch();
});
afterEach(() => { globalThis.fetch = realFetch; });

test("mode=gate&symbol: arranque a frio devolve os 3 presets com os campos pedidos", async () => {
  const r = await call("/api/bybit-klines?mode=gate&symbol=btcusdt&interval=5");
  assert.equal(r.code, 200);
  const b = r.body as { ok: boolean; known: boolean; store: { backend: string }; gate: { symbol: string; presets: Record<string, Record<string, unknown>>; stale: boolean; historyDays: number } };
  assert.equal(b.ok, true);
  assert.equal(b.known, true);
  assert.equal(b.store.backend, "memory");
  assert.equal(b.gate.symbol, "BTCUSDT");
  assert.deepEqual(Object.keys(b.gate.presets).sort(), ["blitz_zero", "loss_zero", "lucro_rapido"]);
  for (const p of Object.values(b.gate.presets)) for (const k of ["allowed", "nOOS", "meanR", "p", "folds", "asOf", "depthDays", "streak"]) assert.ok(k in p, k);
  assert.ok(b.gate.historyDays > 85);
  assert.match(r.headers["cache-control"]!, /s-maxage/);
  const calls1 = bybitCalls;
  assert.ok(calls1 >= 26 && calls1 <= 30, `pedidos ${calls1}`);
  // 2.ª vez: cache, 0 pedidos novos
  const r2 = await call("/api/bybit-klines?mode=gate&symbol=BTCUSDT&interval=5m");
  assert.equal(bybitCalls, calls1);
  assert.equal((r2.body as { gate: { source: string } }).gate.source, "cache");
});

test("mode=gate: validações (símbolo, intervalo) e símbolo desconhecido", async () => {
  assert.equal((await call("/api/bybit-klines?mode=gate&symbol=BTC&interval=5")).code, 400);
  const bad = await call("/api/bybit-klines?mode=gate&symbol=BTCUSDT&interval=1");
  assert.equal(bad.code, 400);
  assert.equal((bad.body as { error: string }).error, "gate_only_5m");
  assert.equal((await call("/api/bybit-klines?mode=gate&symbol=NOPEUSDT&interval=5")).code, 404);
  assert.equal((await call("/api/bybit-klines?mode=gate&symbols=BTC,ETHUSDT&interval=5")).code, 400);
});

test("mode=gate&symbols=: leitura em massa (radar) sem pedir nada à Bybit", async () => {
  await call("/api/bybit-klines?mode=gate&symbol=ETHUSDT&interval=5");
  await call("/api/bybit-klines?mode=gate&symbol=SOLUSDT&interval=5");
  const n = bybitCalls;
  const all = await call("/api/bybit-klines?mode=gate&symbols=all&interval=5");
  assert.equal(bybitCalls, n);
  const b = all.body as { count: number; gates: Record<string, unknown> };
  assert.equal(b.count, 2);
  const some = await call("/api/bybit-klines?mode=gate&symbols=ETHUSDT,XRPUSDT");
  assert.deepEqual(Object.keys((some.body as { gates: object }).gates), ["ETHUSDT"]);
  assert.equal(bybitCalls, n);
});

test("refresh=0 não chama a Bybit", async () => {
  const r = await call("/api/bybit-klines?mode=gate&symbol=ADAUSDT&interval=5&refresh=0");
  assert.equal(r.code, 200);
  assert.equal((r.body as { known: boolean }).known, false);
  assert.equal(bybitCalls, 0);
});

test("gate-backfill: sem segredo corre; com CRON_SECRET exige Bearer", async () => {
  tickersBody = { result: { list: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"].map((s, i) => ({ symbol: s, turnover24h: String(1000 - i) })) } };
  process.env.CRON_SECRET = "s3cret";
  assert.equal((await call("/api/bybit-klines?mode=gate-backfill")).code, 401);
  assert.equal((await call("/api/bybit-klines?mode=gate-backfill", { authorization: "Bearer errado" })).code, 401);
  const ok = await call("/api/bybit-klines?mode=gate-backfill", { authorization: "Bearer s3cret" });
  assert.equal(ok.code, 200);
  const b = ok.body as { total: number; processed: number; cycleComplete: boolean; done: { symbol: string }[] };
  assert.equal(b.total, 5);
  assert.equal(b.cycleComplete, true);
  assert.equal(b.processed, 5);
  const radar = await call("/api/bybit-klines?mode=gate&symbols=all");
  assert.equal((radar.body as { count: number }).count, 5);
  assert.equal(ok.headers["cache-control"], "no-store");
});

test("Redis configurado mas em baixo → 503 gate_store_unavailable (a UI usa o cálculo local)", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  globalThis.fetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
  const r = await call("/api/bybit-klines?mode=gate&symbol=BTCUSDT&interval=5");
  assert.equal(r.code, 503);
  assert.equal((r.body as { error: string }).error, "gate_store_unavailable");
});

test("proxy clássico intacto: sem mode devolve o envelope da Bybit", async () => {
  const r = await call("/api/bybit-klines?symbol=BTCUSDT&interval=5&limit=3");
  assert.equal(r.code, 200);
  assert.equal(JSON.parse(r.body as string).retCode, 0);
  assert.equal((await call("/api/bybit-klines?symbol=XX&interval=5")).code, 400);
  assert.equal((await call("/api/bybit-klines?symbol=BTCUSDT&interval=7")).code, 400);
});

test("modo sombra + FDR: gate-shadow compara nova vs antiga; bulk traz fdr informativo sem mexer em allowed", async () => {
  await call("/api/bybit-klines?mode=gate&symbol=ETHUSDT&interval=5");
  await call("/api/bybit-klines?mode=gate&symbol=SOLUSDT&interval=5");
  const n = bybitCalls;
  const sh = await call("/api/bybit-klines?mode=gate-shadow");
  assert.equal(sh.code, 200);
  assert.equal(bybitCalls, n, "só leitura da cache");
  const b = sh.body as { symbols: number; q: number; presets: Record<string, { tested: number; bothClosed: number; newOpenFdrPass: number; newOpen: number }>; note: string };
  assert.equal(b.symbols, 2);
  assert.equal(b.q, 0.1);
  assert.deepEqual(Object.keys(b.presets).sort(), ["blitz_zero", "loss_zero", "lucro_rapido"]);
  for (const p of Object.values(b.presets)) {
    assert.equal(p.tested, 2);
    assert.ok(p.newOpenFdrPass <= p.newOpen);
  }
  assert.match(b.note, /Informativo/);
  const bulk = await call("/api/bybit-klines?mode=gate&symbols=all");
  const gates = (bulk.body as { gates: Record<string, { presets: Record<string, { allowed: boolean; fdr: { pass: boolean; strictOpen: boolean; m: number }; legacy: { label: string } | null }> }> }).gates;
  for (const g of Object.values(gates)) {
    for (const p of Object.values(g.presets)) {
      assert.ok(p.fdr && typeof p.fdr.pass === "boolean");
      if (p.fdr.strictOpen) assert.equal(p.allowed, true, "FDR só pode restringir, nunca abrir");
      assert.ok(p.legacy && typeof p.legacy.label === "string");
    }
  }
});
