// Teste 4 h pré-registado em PAPER: núcleo, serviço (Upstash simulado em memória), endpoint e UI. Nunca REAL.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  F4H_CANDIDATES, F4H_SYMBOLS, F4H_GRAN, F4H_COST, F4H_DURATION_DAYS, F4H_LABEL,
  candidateTrades, forwardStats, forwardVerdict, forwardStartEpoch, mergeForwardTrades,
} from "../src/core/forward-4h.ts";
import type { F4hTrade } from "../src/core/forward-4h.ts";
import { STRATEGY_PRESETS } from "../src/core/strategies.ts";
import { MARKETS } from "../src/core/markets.ts";
import { GATE_PRESET_IDS } from "../src/core/gate-service.ts";
import type { Candle } from "../src/core/market-data.ts";
// @ts-expect-error JS sem tipos
import { advanceForward4h, startForward4h, publicForward4h } from "../lib/forward-4h-service.js";
// @ts-expect-error JS sem tipos
import * as armStore from "../lib/arm-store.js";
// @ts-expect-error JS sem tipos
import handler from "../api/bybit-arm.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = 1_790_000_000 - (1_790_000_000 % F4H_GRAN);

function series(n: number, f: (i: number) => number, t0 = T0): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const o = f(i), c = f(i + 1);
    return { epoch: t0 + i * F4H_GRAN, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c };
  });
}
// 300 velas laterais (onda) e depois subida forte → breakout Donchian na parte final
const wave = (i: number) => 100 + 2 * Math.sin(i / 5);
const breakout = (n: number) => series(n, (i) => (i < 300 ? wave(i) : wave(300) + (i - 300) * 0.8));

test("pré-registo: 5 candidatos fixos, 30 símbolos, custo 0,13 %, 90 dias; presets/porta/custo por omissão intactos", () => {
  assert.deepEqual(F4H_CANDIDATES.map((c) => c.id), ["A3", "A4", "B2", "C2", "D2"]);
  assert.equal(F4H_SYMBOLS.length, 30);
  assert.equal(F4H_COST, 0.0013);
  assert.equal(F4H_DURATION_DAYS, 90);
  assert.match(F4H_LABEL, /PAPER, sem evidência ainda/);
  assert.equal(MARKETS.crypto.assumedCostFraction, 0.001);
  assert.deepEqual(STRATEGY_PRESETS.map((p) => p.id), ["lucro_rapido", "loss_zero", "blitz_zero", "tendencia_diaria", "biblioteca", "giro_diario"]);
  assert.deepEqual([...GATE_PRESET_IDS], ["lucro_rapido", "loss_zero", "blitz_zero"]);
  const pre = readFileSync(join(root, "notes/preregistro-4h-forward-2026-10-15.md"), "utf8");
  assert.match(pre, /ANTES de descarregar/);
  assert.match(pre, /Duração: 90 dias/);
});

test("candidateTrades: só entradas a partir do início; posição sem saída fica ABERTA (sem fecho fictício)", () => {
  const c = breakout(320);
  const from = c[305]!.epoch;
  const tr = candidateTrades(c, F4H_CANDIDATES[0]!, "BTCUSDT", from);
  assert.ok(tr.length >= 1);
  assert.ok(tr.every((t) => t.entryEpoch > from), "nenhuma entrada antes do início");
  const last = tr.at(-1)!;
  assert.equal(last.direction, 1);
  assert.equal(last.r, null);
  assert.equal(last.exitEpoch, null);
  // mais velas → a mesma operação mantém-se, determinística
  const tr2 = candidateTrades(breakout(321), F4H_CANDIDATES[0]!, "BTCUSDT", from);
  assert.equal(tr2[0]!.entryEpoch, tr[0]!.entryEpoch);
  // início depois de todas as velas → nada
  assert.deepEqual(candidateTrades(c, F4H_CANDIDATES[0]!, "BTCUSDT", c.at(-1)!.epoch + F4H_GRAN), []);
  // poucas velas (aquecimento) → nada
  assert.deepEqual(candidateTrades(c.slice(0, 100), F4H_CANDIDATES[0]!, "BTCUSDT", T0), []);
});

test("candidateTrades: operação que bate no stop fecha com R ≈ -1 - custo", () => {
  const up = breakout(306);
  const crash = series(20, (i) => up.at(-1)!.close * (1 - 0.05 * (i + 1)), up.at(-1)!.epoch + F4H_GRAN);
  const c = [...up, ...crash];
  const tr = candidateTrades(c, F4H_CANDIDATES[0]!, "X", up[302]!.epoch).filter((t) => t.r !== null);
  assert.ok(tr.length >= 1);
  assert.ok(tr.some((t) => t.reason === "sl" && (t.r as number) <= -1));
});

test("início fixo na próxima vela 4 h; merge preserva firstSeenAt", () => {
  const now = (T0 + 100) * 1000;
  assert.equal(forwardStartEpoch(now), T0 + F4H_GRAN);
  assert.equal(forwardStartEpoch(T0 * 1000), T0 + F4H_GRAN);
  const a: F4hTrade = { candidate: "A3", symbol: "BTCUSDT", direction: 1, entryEpoch: 10, exitEpoch: null, entry: 1, exit: null, reason: null, r: null };
  const m1 = mergeForwardTrades([], [a], 111);
  const m2 = mergeForwardTrades(m1, [{ ...a, exitEpoch: 20, exit: 2, reason: "tp", r: 1.9 }], 222);
  assert.equal(m2[0]!.firstSeenAt, 111);
  assert.equal(m2[0]!.r, 1.9);
});

test("estatísticas e veredicto: nunca 'passa' antes do dia 90; critérios pré-registados", () => {
  const start = T0;
  const mk = (i: number, r: number): F4hTrade => ({ candidate: "A3", symbol: F4H_SYMBOLS[i % 30]!, direction: 1, entryEpoch: start + i * 3600, exitEpoch: start + i * 86400 / 2, entry: 1, exit: 1, reason: "tp", r });
  const trades = Array.from({ length: 120 }, (_, i) => mk(i, i % 3 === 0 ? -1 : 2));
  const now = start + 60 * 86400;
  const st = forwardStats(trades, start, now, 30);
  assert.equal(st.length, 5);
  const a3 = st.find((s) => s.id === "A3")!;
  assert.equal(a3.closed, 120);
  assert.ok(a3.meanR > 0);
  const early = forwardVerdict(st, start, now);
  assert.equal(early.final, false);
  assert.ok(early.verdicts.every((v) => !v.pass));
  const late = forwardVerdict(st, start, start + 91 * 86400);
  assert.equal(late.final, true);
  const vA3 = late.verdicts.find((v) => v.id === "A3")!;
  assert.equal(vA3.pass, (a3.adjP ?? 1) <= 0.1);
  assert.ok(late.verdicts.find((v) => v.id === "B2")!.reasons.some((r) => /operações fechadas/.test(r)));
});

// ---------------------------------------------------------------- serviço
function memDeps() {
  let st: unknown = null;
  return { getState: async () => st, saveState: async (s: unknown) => { st = s; }, peek: () => st as Record<string, any> };
}

test("serviço: sem início não faz nada; start é idempotente (o início nunca é reposto)", async () => {
  const d = memDeps();
  assert.deepEqual(await advanceForward4h(Date.now(), d), { advanced: false, state: null });
  const a = await startForward4h(T0 * 1000, d);
  assert.equal(a.created, true);
  assert.equal(a.state.mode, "PAPER");
  const b = await startForward4h((T0 + 99 * 86400) * 1000, d);
  assert.equal(b.created, false);
  assert.equal(b.state.startEpoch, a.state.startEpoch);
  assert.equal(publicForward4h(null).started, false);
});

test("serviço: avança com velas mockadas, só velas fechadas, mantém operações de símbolo que falhou, throttle 15 min", async () => {
  const d = memDeps();
  const c = breakout(330);
  const startMs = (c[302]!.epoch - 1) * 1000;
  await startForward4h(startMs, d);
  const nowMs = (c.at(-1)!.epoch + F4H_GRAN) * 1000; // última vela já fechada
  let calls = 0;
  const r1 = await advanceForward4h(nowMs, { ...d, fetchCandles: async () => { calls += 1; return c; } });
  assert.equal(r1.advanced, true);
  assert.equal(calls, 30);
  const n1 = r1.state.trades.length;
  assert.ok(n1 > 0);
  assert.ok(r1.state.trades.every((t: F4hTrade) => t.entryEpoch >= d.peek().startEpoch));
  // throttle
  const r2 = await advanceForward4h(nowMs + 60_000, { ...d, fetchCandles: async () => { throw new Error("não devia chamar"); } });
  assert.equal(r2.advanced, false);
  // falha de um símbolo → mantém as operações já gravadas dele
  const r3 = await advanceForward4h(nowMs + 20 * 60_000, { ...d, fetchCandles: async (s: string) => { if (s === "BTCUSDT") throw new Error("rede"); return c; } });
  assert.equal(r3.state.trades.length, n1);
  assert.equal(r3.state.lastErrors.length, 1);
  assert.match(r3.state.lastErrors[0], /BTCUSDT/);
  // a vela em formação nunca entra
  const forming = [...c, { epoch: c.at(-1)!.epoch + F4H_GRAN, open: 1e6, high: 1e6, low: 1e6, close: 1e6 }];
  const r4 = await advanceForward4h(nowMs + 40 * 60_000, { ...d, fetchCandles: async () => forming });
  assert.equal(r4.state.trades.length, n1);
  const pub = publicForward4h(r4.state, nowMs);
  assert.equal(pub.mode, "PAPER");
  assert.equal(pub.started, true);
  assert.match(pub.label, /sem evidência ainda/);
  assert.equal(pub.candidates.length, 5);
});

// ---------------------------------------------------------------- endpoint (store em memória, Bybit pública mockada)
interface Res { code: number; body: Record<string, any> }
function call(method: string, url: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const out: Res = { code: 200, body: {} };
    const res = {
      setHeader() {},
      status(c: number) { out.code = c; return res; },
      json(b: Record<string, any>) { out.body = b; resolve(out); return res; },
      send(t: string) { out.body = JSON.parse(t); resolve(out); return res; },
      end() { resolve(out); return res; },
    };
    Promise.resolve(handler({ method, url, headers: {}, body: body ?? {} }, res)).catch(reject);
  });
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; armStore._resetMemoryStore(); });

test("endpoint: GET mostra não iniciado; POST exige confirmPaper; start uma vez; sempre PAPER, sem chamadas privadas", async () => {
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.KV_REST_API_URL;
  const urls: string[] = [];
  globalThis.fetch = (async (u: unknown) => {
    const s = String(u);
    urls.push(s);
    if (!s.includes("/v5/market/kline")) throw new Error("chamada inesperada " + s);
    return { ok: true, status: 200, text: async () => JSON.stringify({ retCode: 0, result: { list: [] } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const g0 = await call("GET", "/api/bybit-arm?forward=4h");
  assert.equal(g0.code, 200);
  assert.equal(g0.body.forward4h.started, false);
  assert.equal(g0.body.forward4h.mode, "PAPER");
  assert.equal((await call("POST", "/api/bybit-arm?forward=4h", { action: "start" })).code, 400);
  assert.equal((await call("POST", "/api/bybit-arm?forward=4h", { action: "start", mode: "REAL" })).code, 400);
  const s1 = await call("POST", "/api/bybit-arm?forward=4h", { action: "start", confirmPaper: true, mode: "REAL" });
  assert.equal(s1.code, 200);
  assert.equal(s1.body.created, true);
  assert.equal(s1.body.forward4h.mode, "PAPER");
  const s2 = await call("POST", "/api/bybit-arm?forward=4h", { action: "start", confirmPaper: true });
  assert.equal(s2.body.created, false);
  assert.equal(s2.body.forward4h.startEpoch, s1.body.forward4h.startEpoch);
  const g1 = await call("GET", "/api/bybit-arm?forward=4h");
  assert.equal(g1.body.forward4h.started, true);
  assert.ok(urls.every((u) => !/order|execution|position|wallet/.test(u)), "só klines públicas");
});

test("código: o serviço 4 h não importa nada que coloque ordens; UI rotulada e sem opção REAL", () => {
  const svc = readFileSync(join(root, "lib/forward-4h-service.js"), "utf8");
  assert.doesNotMatch(svc, /bybit-place|placeLinearMarketOrder|order\/create/);
  const core = readFileSync(join(root, "src/core/forward-4h.ts"), "utf8");
  assert.doesNotMatch(core, /bybit-trading|placeLinear|order\/create/);
  const html = readFileSync(join(root, "public/bybit.html"), "utf8");
  assert.match(html, /id="f4hPanel"[^>]*hidden/);
  assert.match(html, /Iniciar teste 4 h \(só PAPER\)/);
  const js = readFileSync(join(root, "public/assets/bybit.js"), "utf8");
  const blk = js.slice(js.indexOf("Teste 4 h pré-registado em PAPER"), js.indexOf("function syncArmUi"));
  assert.ok(blk.length > 100);
  assert.doesNotMatch(blk, /REAL"|mode: "REAL"|placeBybitOrder|BYBIT_ORDER_URL/);
  assert.match(blk, /confirmPaper: true/);
  assert.match(blk, /simulado, sem dinheiro/);
  const kl = readFileSync(join(root, "lib/arm-klines.js"), "utf8");
  assert.match(kl, /14400: "240"/);
});
