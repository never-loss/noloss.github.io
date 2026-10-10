// lib/gate-cache.js + lib/gate-store.js — cache da porta (memória e Upstash simulado). Sem rede real.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JS sem tipos
import { getGate, refreshGate, backfillGate, topSymbols, publicGate, FALLBACK_TOP, COLD_BUDGET_PER_HOUR } from "../lib/gate-cache.js";
// @ts-expect-error JS sem tipos
import * as store from "../lib/gate-store.js";
// @ts-expect-error JS sem tipos
import { HistoryError, lastClosedStart } from "../lib/history.js";
import { computeGateEntry, GATE_PRESET_IDS } from "../src/core/gate-service.ts";
import type { Candle } from "../src/core/market-data.ts";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const GRAN = 300;
/** Série sintética que TERMINA na última vela fechada de `nowMs`. */
function series(seed: number, n: number, nowMs: number, phi = 0): Candle[] {
  const last = lastClosedStart(nowMs, GRAN);
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const ret = phi * prev + gauss(r) * 0.002;
    prev = ret;
    const open = price;
    const close = open * (1 + ret);
    out.push({
      epoch: last - (n - 1 - i) * GRAN, open, close,
      high: Math.max(open, close) * (1 + Math.abs(gauss(r)) * 0.0007),
      low: Math.min(open, close) * (1 - Math.abs(gauss(r)) * 0.0007),
    });
    price = close;
  }
  return out;
}

/** Mundo simulado: série longa fixa; "history" devolve a parte fechada até `now`. */
function world(seed = 1, total = 40000, phi = 0, startNow = 1_800_000_000_000 + 77_000) {
  const state = { now: startNow, calls: [] as { count?: number; days?: number }[], fail: null as null | (() => never) };
  const base = series(seed, total, startNow, phi);
  // velas "futuras": continuação determinística (mesma regra) para quando o relógio avança
  const extra = (() => {
    const r = mulberry32(seed + 999);
    const out: Candle[] = [];
    let price = base[base.length - 1]!.close;
    for (let i = 1; i <= 3000; i++) {
      const open = price;
      const close = open * (1 + gauss(r) * 0.002);
      out.push({ epoch: base[base.length - 1]!.epoch + i * GRAN, open, close, high: Math.max(open, close) * 1.0004, low: Math.min(open, close) * 0.9996 });
      price = close;
    }
    return out;
  })();
  const all = [...base, ...extra];
  const history = async (_s: string, _g: number, o: { count?: number; days?: number }) => {
    state.calls.push({ count: o.count, days: o.days });
    if (state.fail) state.fail();
    const last = lastClosedStart(state.now, GRAN);
    const upto = all.filter((c) => c.epoch <= last);
    const count = o.count ?? Math.ceil(((o.days ?? 90) * 86400) / GRAN);
    const candles = upto.slice(-count);
    return { candles, complete: true, failedWindows: [], windows: Math.ceil(count / 1000), requests: Math.ceil(count / 1000), requested: count };
  };
  return { state, history, all, now: () => state.now };
}

beforeEach(() => store._resetGateMemory());

const ENV = {} as NodeJS.ProcessEnv; // sem Redis → memória

test("arranque a frio: lê nada → descarrega 90 dias, calcula, grava e responde com os campos pedidos", async () => {
  const w = world();
  const r = await getGate("BTCUSDT", { env: ENV, history: w.history, now: w.now });
  assert.equal(r.known, true);
  assert.equal(w.state.calls.length, 1);
  assert.equal(w.state.calls[0]!.days, 90);
  const g = r.gate;
  assert.equal(g.source, "refreshed");
  assert.equal(g.symbol, "BTCUSDT");
  assert.deepEqual(Object.keys(g.presets).sort(), [...GATE_PRESET_IDS].sort());
  for (const p of Object.values(g.presets) as Record<string, unknown>[]) {
    for (const k of ["allowed", "nOOS", "meanR", "p", "folds", "asOf", "depthDays", "streak", "label", "reason"]) assert.ok(k in p, `campo ${k}`);
  }
  assert.ok(g.historyDays >= 89 && g.historyDays <= 91, `historyDays ${g.historyDays}`);
  assert.equal(g.stale, false);
  const full = await store.readGateEntry("BTCUSDT", 300, ENV);
  assert.equal(full.tail.length, 2700);
});

test("segunda leitura dentro de 15 min: vem da cache, sem tocar na Bybit", async () => {
  const w = world();
  await getGate("ETHUSDT", { env: ENV, history: w.history, now: w.now });
  w.state.now += 5 * 60_000;
  const r = await getGate("ETHUSDT", { env: ENV, history: w.history, now: w.now });
  assert.equal(w.state.calls.length, 1);
  assert.equal(r.gate.source, "cache");
  assert.equal(r.gate.ageMs, 5 * 60_000);
});

test("refresh=false nunca chama a Bybit e marca stale", async () => {
  const w = world();
  await getGate("SOLUSDT", { env: ENV, history: w.history, now: w.now });
  w.state.now += 3 * 3600_000;
  const r = await getGate("SOLUSDT", { env: ENV, history: w.history, now: w.now, refresh: false });
  assert.equal(w.state.calls.length, 1);
  assert.equal(r.gate.stale, true);
  const none = await getGate("NEWUSDT", { env: ENV, history: w.history, now: w.now, refresh: false });
  assert.equal(none.known, false);
});

test("actualização a quente: pede só as velas novas e o livro == recálculo completo", async () => {
  const w = world(3, 40000, 0.1);
  await getGate("XRPUSDT", { env: ENV, history: w.history, now: w.now });
  w.state.now += 60 * 60_000; // +12 velas
  const r = await getGate("XRPUSDT", { env: ENV, history: w.history, now: w.now });
  assert.equal(w.state.calls.length, 2);
  assert.ok((w.state.calls[1]!.count ?? 0) <= 20, `count ${w.state.calls[1]!.count}`);
  assert.equal(r.gate.source, "refreshed");
  const stored = await store.readGateEntry("XRPUSDT", 300, ENV);
  const last = lastClosedStart(w.state.now, GRAN);
  const hist = (await w.history("XRPUSDT", 300, { days: 90 })).candles as Candle[];
  assert.equal(hist[hist.length - 1]!.epoch, last);
  const fullCalc = computeGateEntry(null, "XRPUSDT", hist, w.state.now);
  for (const id of GATE_PRESET_IDS) assert.deepStrictEqual(stored.ledgers[id].folds, fullCalc.ledgers[id].folds, id);
  assert.equal(stored.lastEpoch, last);
  assert.equal(stored.tail.length, 2700);
});

test("buraco grande (> 480 velas) volta ao arranque a frio em vez de colar história", async () => {
  const w = world();
  await getGate("ADAUSDT", { env: ENV, history: w.history, now: w.now });
  w.state.now += 600 * 5 * 60_000; // +600 velas
  await getGate("ADAUSDT", { env: ENV, history: w.history, now: w.now });
  assert.equal(w.state.calls[1]!.days, 90);
});

test("símbolo inválido (retCode permanente): 404, cache negativa e sem novos pedidos", async () => {
  const w = world();
  w.state.fail = () => { throw new HistoryError("bybit_10001", "Illegal symbol", true); };
  const r = await getGate("FAKEUSDT", { env: ENV, history: w.history, now: w.now });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  const n = w.state.calls.length;
  const r2 = await getGate("FAKEUSDT", { env: ENV, history: w.history, now: w.now });
  assert.equal(r2.ok, false);
  assert.equal(w.state.calls.length, n, "cache negativa: não volta a pedir");
  assert.equal((await getGate("bad", { env: ENV })).ok, false);
});

test("falha temporária/histórico incompleto: não grava nada e não parte o que já existe", async () => {
  const w = world();
  await getGate("DOGEUSDT", { env: ENV, history: w.history, now: w.now });
  const before = await store.readGateSummary("DOGEUSDT", 300, ENV);
  w.state.now += 3600_000;
  const orig = w.history;
  const bad = async (...a: unknown[]) => ({ ...(await (orig as (...x: unknown[]) => Promise<Record<string, unknown>>)(...a)), complete: false });
  const r = await refreshGate("DOGEUSDT", { env: ENV, history: bad, now: w.now });
  assert.equal(r.status, "error");
  assert.deepStrictEqual(await store.readGateSummary("DOGEUSDT", 300, ENV), before);
  const boom = async () => { throw new Error("rede em baixo"); };
  const r2 = await refreshGate("DOGEUSDT", { env: ENV, history: boom, now: w.now });
  assert.equal(r2.status, "error");
  assert.deepStrictEqual(await store.readGateSummary("DOGEUSDT", 300, ENV), before);
});

test("dois pedidos em simultâneo ao mesmo símbolo: um actualiza, o outro vê o bloqueio", async () => {
  const w = world();
  const slow = async (...a: unknown[]) => { await new Promise((r) => setTimeout(r, 20)); return (w.history as (...x: unknown[]) => Promise<unknown>)(...a); };
  const [a, b] = await Promise.all([
    refreshGate("LTCUSDT", { env: ENV, history: slow, now: w.now }),
    refreshGate("LTCUSDT", { env: ENV, history: slow, now: w.now }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ["locked", "refreshed"]);
  assert.equal(w.state.calls.length, 1);
  // bloqueio libertado no fim
  w.state.now += 3600_000;
  assert.equal((await refreshGate("LTCUSDT", { env: ENV, history: w.history, now: w.now })).status, "refreshed");
});

test("orçamento global de arranques a frio por hora", async () => {
  const w = world();
  const hour = Math.floor(w.state.now / 3_600_000);
  for (let i = 0; i < COLD_BUDGET_PER_HOUR; i++) await store.bumpBudget(store.budgetKey("cold", hour), 7200, ENV);
  const r = await refreshGate("TRXUSDT", { env: ENV, history: w.history, now: w.now });
  assert.equal(r.status, "budget");
  assert.equal(w.state.calls.length, 0);
});

test("publicGate: idade, frescura e vista por preset", async () => {
  const w = world();
  await getGate("DOTUSDT", { env: ENV, history: w.history, now: w.now });
  const sum = await store.readGateSummary("DOTUSDT", 300, ENV);
  const v = publicGate(sum, w.state.now + 20 * 60_000);
  assert.equal(v.stale, true);
  assert.equal(v.ageMs, 20 * 60_000);
  assert.equal(publicGate(null, 1), null);
  for (const p of Object.values(v.presets) as { open: boolean; allowed: boolean; streak: number }[]) assert.equal(p.open, p.allowed && p.streak >= 2);
});

test("leitura em massa (radar): 1 resumo por símbolo", async () => {
  const w = world();
  for (const s of ["AAAUSDT", "BBBUSDT"]) await getGate(s, { env: ENV, history: w.history, now: w.now });
  const all = await store.readAllGateSummaries(300, ENV);
  assert.deepEqual(Object.keys(all).sort(), ["AAAUSDT", "BBBUSDT"]);
});

test("backfill: processa em lotes com cursor, retoma e fecha o ciclo", async () => {
  const w = world();
  const slow = async (...a: unknown[]) => { await new Promise((r) => setTimeout(r, 15)); return (w.history as (...x: unknown[]) => Promise<unknown>)(...a); };
  const symbols = ["S1USDT", "S2USDT", "S3USDT", "S4USDT", "S5USDT"];
  const r1 = await backfillGate({ env: ENV, history: slow, now: w.now, symbols, budgetMs: 1, concurrency: 2 });
  assert.equal(r1.cycleComplete, false);
  assert.equal(r1.processed, 2);
  assert.equal(r1.nextIndex, 2);
  const r2 = await backfillGate({ env: ENV, history: slow, now: w.now, symbols, budgetMs: 1, concurrency: 2 });
  assert.equal(r2.nextIndex, 4);
  const r3 = await backfillGate({ env: ENV, history: slow, now: w.now, symbols, budgetMs: 10_000, concurrency: 2 });
  assert.equal(r3.cycleComplete, true);
  assert.equal(r3.nextIndex, 0);
  assert.equal(Object.keys(await store.readAllGateSummaries(300, ENV)).length, 5);
  // novo ciclo: símbolos frescos não são descarregados outra vez
  const calls = w.state.calls.length;
  const r4 = await backfillGate({ env: ENV, history: slow, now: w.now, symbols, budgetMs: 10_000 });
  assert.equal(r4.cycleComplete, true);
  assert.equal(w.state.calls.length, calls);
});

test("topSymbols: ordena por turnover, filtra, guarda em cache; recurso se a Bybit falhar", async () => {
  const list = [
    { symbol: "ETHUSDT", turnover24h: "500" }, { symbol: "BTCUSDT", turnover24h: "900" }, { symbol: "BTC-26DEC25", turnover24h: "999" },
    { symbol: "SOLUSDT", turnover24h: "300" }, { symbol: "XRPUSDT", turnover24h: "200" }, { symbol: "ADAUSDT", turnover24h: "100" },
    { symbol: "DOGEUSDT", turnover24h: "50" }, { symbol: "ZEROUSDT", turnover24h: "0" },
  ];
  let calls = 0;
  const topFetch = async () => { calls += 1; return new Response(JSON.stringify({ result: { list } }), { status: 200 }); };
  const t = await topSymbols({ env: ENV, topFetch, topN: 5 });
  assert.deepEqual(t, ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT"]);
  await topSymbols({ env: ENV, topFetch, topN: 5 });
  assert.equal(calls, 1, "2.ª vez vem da cache");
  store._resetGateMemory();
  const dead = async () => new Response("x", { status: 403 });
  assert.deepEqual(await topSymbols({ env: ENV, topFetch: dead }), FALLBACK_TOP);
});

// ---------- Upstash simulado (/pipeline) ----------
function fakeUpstash() {
  const hashes = new Map<string, Map<string, string>>();
  const kv = new Map<string, string>();
  const requests: { url: string; auth: string | null; cmds: string[][] }[] = [];
  const fn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const cmds = JSON.parse(init.body) as string[][];
    requests.push({ url, auth: init.headers.Authorization ?? null, cmds });
    const out = cmds.map((c) => {
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
        default: return { error: `ERR unknown ${op}` };
      }
    });
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, requests, hashes, kv };
}

test("Upstash: escrita em lote (HSET+EXPIRE+HSET num só /pipeline), bloqueio SET NX EX, leitura barata", async () => {
  const w = world();
  const up = fakeUpstash();
  const env = { UPSTASH_REDIS_REST_URL: "https://redis.example/", UPSTASH_REDIS_REST_TOKEN: "tok" } as unknown as NodeJS.ProcessEnv;
  assert.deepEqual(store.gateStoreInfo(env), { backend: "upstash", durable: true });
  const r = await getGate("BTCUSDT", { env, fetchImpl: up.fn, history: w.history, now: w.now });
  assert.equal(r.known, true);
  for (const q of up.requests) {
    assert.equal(q.url, "https://redis.example/pipeline");
    assert.equal(q.auth, "Bearer tok");
  }
  const flat = up.requests.flatMap((q) => q.cmds);
  const lock = flat.find((c) => c[0] === "SET" && c.includes("NX"));
  assert.ok(lock && lock.includes("EX") && lock[1] === "nl:gate:v1:lock:BTCUSDT:300");
  assert.ok(flat.some((c) => c[0] === "DEL" && c[1] === "nl:gate:v1:lock:BTCUSDT:300"), "bloqueio libertado");
  const writeReq = up.requests.find((q) => q.cmds.some((c) => c[0] === "HSET" && c[1] === "nl:gate:v1:BTCUSDT:300"));
  assert.ok(writeReq);
  assert.deepEqual(writeReq!.cmds.map((c) => c[0]), ["HSET", "EXPIRE", "HSET"]);
  assert.equal(writeReq!.cmds[0]![2], "meta");
  assert.equal(writeReq!.cmds[2]![1], "nl:gate:v1:sum:300");
  // leitura do resumo = 1 comando; radar = 1 comando
  up.requests.length = 0;
  w.state.now += 60_000;
  await getGate("BTCUSDT", { env, fetchImpl: up.fn, history: w.history, now: w.now });
  assert.equal(up.requests.length, 1);
  assert.deepEqual(up.requests[0]!.cmds.map((c) => c[0]), ["HGET"]);
  up.requests.length = 0;
  const all = await store.readAllGateSummaries(300, env, up.fn);
  assert.deepEqual(Object.keys(all), ["BTCUSDT"]);
  assert.deepEqual(up.requests.map((q) => q.cmds.map((c) => c[0])), [["HGETALL"]]);
  // a cauda e os livros vão no registo completo, não no resumo
  const sumRaw = [...up.hashes.get("nl:gate:v1:sum:300")!.values()][0]!;
  assert.ok(sumRaw.length < 6000);
  assert.ok(up.hashes.get("nl:gate:v1:BTCUSDT:300")!.get("tail")!.length > 50_000);
});

test("Upstash em baixo: erro tratado (sem lançar para o chamador de refreshGate fora do bloqueio)", async () => {
  const w = world();
  const env = { KV_REST_API_URL: "https://redis.example", KV_REST_API_TOKEN: "t" } as unknown as NodeJS.ProcessEnv; // alias KV_*
  const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(refreshGate("BTCUSDT", { env, fetchImpl: down, history: w.history, now: w.now }));
});
