// Custo por operação: modelado (PAPER) e real (execuções Bybit mockadas) vs assumido. Só medição: nada muda nas decisões.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BYBIT_TAKER_FEE, BYBIT_MAKER_FEE, ASSUMED_SLIPPAGE_PER_SIDE, MODELED_COST_LABEL,
  modelTradeFill, resolveFillModel, summarizeModeledFills, summarizeRealFills,
  formatRealCostLine, formatModeledCostLine,
} from "../src/core/trade-cost.ts";
import type { RealFill } from "../src/core/trade-cost.ts";
import { CandlePaperSession } from "../src/core/candle-paper.ts";
import type { CandlePaperConfig, CandlePaperEvent } from "../src/core/candle-paper.ts";
import { MARKETS } from "../src/core/markets.ts";
import {
  createCloudArmJob, addRealFill, publicCloudArmJob, pendingRealMirrors, CLOUD_ARM_MAX_REAL_FILLS,
  advanceCloudArmJob,
} from "../src/core/cloud-arm.ts";
import type { CloudArmJob } from "../src/core/cloud-arm.ts";
import type { Strategy, Signal } from "../src/core/strategies.ts";
import type { Candle } from "../src/core/market-data.ts";
// @ts-expect-error JS sem tipos
import * as place from "../lib/bybit-place.js";
// @ts-expect-error JS sem tipos
import { recordRealFill } from "../lib/arm-real-fill.js";
// @ts-expect-error JS sem tipos
import orderHandler from "../api/bybit-order.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const near = (a: number, b: number, tol = 1e-12): void => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

// ---------------------------------------------------------------- constantes
test("taxas oficiais Bybit VIP 0 e custo por omissão intactos", () => {
  assert.equal(BYBIT_TAKER_FEE, 0.00055);
  assert.equal(BYBIT_MAKER_FEE, 0.0002);
  assert.equal(MARKETS.crypto.assumedCostFraction, 0.001, "o custo por omissão NÃO muda");
  assert.match(MODELED_COST_LABEL, /SUPOSTA/);
  assert.throws(() => resolveFillModel({ takerFee: -1 }));
  assert.throws(() => resolveFillModel({ slippagePerSide: 0.5 }));
  assert.equal(resolveFillModel({ takerFee: 0.0004 }).takerFee, 0.0004);
});

// ---------------------------------------------------------------- modelo
test("modelTradeFill: stop (taker+taker+derrapagem), alvo (taker+maker), gap vs stop", () => {
  const base = { direction: 1 as const, entry: 100, stopPrice: 99, exitCandleClose: 98.9, dist: 1, assumedCostFrac: 0.001 };
  const sl = modelTradeFill({ ...base, exit: 99, reason: "sl" });
  near(sl.feeFrac, 0.0011);
  near(sl.slipFrac, 2 * ASSUMED_SLIPPAGE_PER_SIDE);
  near(sl.modeledCostFrac, 0.0013);
  near(sl.modeledCostR, 0.13); // 0,0013 × 100 / 1
  near(sl.assumedCostR, 0.1);
  assert.equal(sl.exitKind, "taker");
  near(sl.entryFill, 100 * (1 + ASSUMED_SLIPPAGE_PER_SIDE));
  near(sl.exitFill, 99 * (1 - ASSUMED_SLIPPAGE_PER_SIDE));
  near(sl.gapVsStopFrac, 0);

  const tp = modelTradeFill({ ...base, exit: 102, reason: "tp" });
  near(tp.feeFrac, 0.00055 + 0.0002);
  near(tp.slipFrac, ASSUMED_SLIPPAGE_PER_SIDE);
  assert.equal(tp.exitKind, "maker");
  assert.equal(tp.exitFill, 102);

  // salto (gap) abaixo do stop numa compra: saída pior que o stop
  const gap = modelTradeFill({ ...base, exit: 98.5, reason: "sl" });
  near(gap.gapVsStopFrac, 0.005);
  // venda: o sinal inverte
  const sh = modelTradeFill({ ...base, direction: -1, entry: 100, stopPrice: 101, exit: 101.5, reason: "sl" });
  near(sh.gapVsStopFrac, 0.005);
  assert.ok(sh.entryFill < 100);

  // configurável: alvo a mercado
  const tpTaker = modelTradeFill({ ...base, exit: 102, reason: "tp" }, resolveFillModel({ takeProfitIsMaker: false }));
  near(tpTaker.feeFrac, 0.0011);
});

test("resumos: n = 0 → null (a UI não mostra nada); médias corretas", () => {
  assert.equal(summarizeModeledFills([]), null);
  assert.equal(summarizeRealFills([]), null);
  assert.equal(formatRealCostLine(null, 0.001), null);
  assert.equal(formatModeledCostLine(null), null);
  const a = modelTradeFill({ direction: 1, entry: 100, exit: 99, stopPrice: 99, exitCandleClose: 99, dist: 1, reason: "sl", assumedCostFrac: 0.001 });
  const b = modelTradeFill({ direction: 1, entry: 100, exit: 102, stopPrice: 99, exitCandleClose: 102, dist: 1, reason: "tp", assumedCostFrac: 0.001 });
  const s = summarizeModeledFills([a, b])!;
  assert.equal(s.n, 2);
  near(s.meanModeledFrac, (a.modeledCostFrac + b.modeledCostFrac) / 2);
  near(s.meanAssumedFrac, 0.001);
  assert.match(formatModeledCostLine(s)!, /SUPOSTA.*n = 2.*assumido 0,10 %/);
});

function rf(over: Partial<RealFill>): RealFill {
  return { key: "k", action: "open", side: "BUY", symbol: "BTCUSDT", signalPrice: 100, avgPrice: 100.01, qty: 1, execFee: 0.055, feeFrac: 0.00055, slipFrac: 0.0001, costFrac: 0.00065, at: 1, ...over };
}
test("summarizeRealFills: emparelha abertura+fecho; sem par → por lado; linha honesta", () => {
  const only = summarizeRealFills([rf({})])!;
  assert.equal(only.fills, 1);
  assert.equal(only.roundTrips, 0);
  assert.equal(only.meanRoundTripFrac, null);
  assert.match(formatRealCostLine(only, 0.001)!, /por lado.*n = 1 execução.*sem operação completa.*assumido 0,10 %/);

  const two = summarizeRealFills([rf({ at: 1 }), rf({ key: "c", action: "close", side: "SELL", at: 2, feeFrac: 0.0005, slipFrac: 0.0003, costFrac: 0.0008 })])!;
  assert.equal(two.roundTrips, 1);
  near(two.meanRoundTripFrac!, 0.00055 + 0.0001 + 0.0005 + 0.0003);
  const line = formatRealCostLine(two, 0.001)!;
  assert.match(line, /^Custo real médio: 0,145 % por operação/);
  assert.match(line, /n = 1 operação/);
  // NaN ignorados
  assert.equal(summarizeRealFills([rf({ costFrac: NaN })]), null);
});

// ---------------------------------------------------------------- PAPER: só informação
function candles(n: number, f: (i: number) => [number, number, number, number]): Candle[] {
  return Array.from({ length: n }, (_, i) => { const [o, h, l, c] = f(i); return { epoch: 1_800_000_000 + i * 300, open: o, high: h, low: l, close: c }; });
}
function oneShot(at: number): Strategy {
  return { name: "um-tiro", signals: (c) => c.map((_, i): Signal => (i === at ? 1 : 0)) };
}
function paperCfg(over: Partial<CandlePaperConfig> = {}): CandlePaperConfig {
  return {
    strategy: oneShot(25), stake: 1, slAtr: 1, tpR: 2, maxBars: 5, costFraction: 0.001,
    maxLoss: 10, maxTrades: 5, maxDurationMs: 3 * 3600 * 1000, maxConsecutiveLosses: 6, cooldownCandles: 0, ...over,
  };
}
function runPaper(over: Partial<CandlePaperConfig> = {}, bars?: Candle[]): CandlePaperEvent[] {
  // preço sobe devagar com range 1; sinal na vela 25; depois cai para o stop
  const cs = bars ?? candles(40, (i) => (i <= 26 ? [100, 100.5, 99.5, 100] : [100, 100.2, 95, 96]));
  const ses = new CandlePaperSession(paperCfg(over));
  const ev: CandlePaperEvent[] = [];
  ev.push(...ses.start(cs[0]!.epoch * 1000));
  for (const c of cs) ev.push(...ses.onCandle(c));
  return ev;
}

test("PAPER: trade_closed leva fill modelado e r/pnl/entradas/saídas NÃO dependem do modelo", () => {
  const a = runPaper();
  const b = runPaper({ fillModel: { slippagePerSide: 0.01, takerFee: 0.01 } });
  const ca = a.find((e) => e.type === "trade_closed");
  const cb = b.find((e) => e.type === "trade_closed");
  assert.ok(ca && ca.type === "trade_closed" && cb && cb.type === "trade_closed");
  assert.ok(ca.fill && cb.fill);
  // mesmas decisões e mesmo resultado
  assert.equal(ca.r, cb.r);
  assert.equal(ca.pnl, cb.pnl);
  assert.equal(ca.entry, cb.entry);
  assert.equal(ca.exit, cb.exit);
  assert.equal(ca.reason, cb.reason);
  assert.deepEqual(a.map((e) => e.type), b.map((e) => e.type));
  // ... mas o custo modelado reflecte o modelo configurado
  assert.ok(cb.fill.modeledCostFrac > ca.fill.modeledCostFrac * 5);
  // custo assumido = o da simulação (0,1 %) → o r já o inclui
  assert.equal(ca.fill.assumedCostFrac, 0.001);
  near(ca.fill.assumedCostR, (0.001 * ca.entry) / ((ca.entry - ca.fill.stopPrice) / 1), 1e-9);
  assert.equal(ca.reason, "sl");
  assert.equal(ca.fill.exitKind, "taker");
  assert.equal(ca.fill.stopPrice < ca.entry, true);
  assert.ok(ca.fill.gapVsStopFrac >= 0);
});

test("PAPER: opção fillModel inválida é rejeitada; chaves desconhecidas continuam rejeitadas", () => {
  assert.throws(() => new CandlePaperSession(paperCfg({ fillModel: { takerFee: -0.1 } })));
  assert.throws(() => new CandlePaperSession({ ...paperCfg(), nope: 1 } as unknown as CandlePaperConfig));
});

// ---------------------------------------------------------------- cloud arm
test("cloud arm: snap do fecho leva exit+fill; pendingRealMirrors usa preço do sinal; realFills preservados", () => {
  const job = createCloudArmJob({ symbol: "BTCUSDT", strategyPreset: "lucro_rapido", stake: 1, leverage: 1, granularity: 300, durationMinutes: 60, clientId: "c_testclient99", mode: "REAL" }, 1_800_000_000_000);
  assert.deepEqual(job.realFills, []);
  const withEv: CloudArmJob = {
    ...job,
    events: [
      { type: "trade_opened", at: 1, text: "ABRE", direction: 1, entry: 100 },
      { type: "trade_closed", at: 2, text: "FECHA", direction: 1, r: -1, pnl: -1, entry: 100, exit: 99 },
    ],
  };
  const p = pendingRealMirrors(job, withEv);
  assert.equal(p[0]!.price, 100);
  assert.equal(p[1]!.price, 99);

  const fill = rf({ key: "x" });
  const j1 = addRealFill(job, fill);
  assert.equal(j1.realFills!.length, 1);
  assert.equal(addRealFill(j1, fill).realFills!.length, 1, "sem duplicados");
  let j2 = j1;
  for (let i = 0; i < CLOUD_ARM_MAX_REAL_FILLS + 10; i++) j2 = addRealFill(j2, rf({ key: `k${i}` }));
  assert.equal(j2.realFills!.length, CLOUD_ARM_MAX_REAL_FILLS);
  assert.deepEqual((publicCloudArmJob(j1) as { realFills: unknown[] }).realFills.length, 1);

  const gran = 300;
  const cs = candles(300, (i) => [100 + Math.sin(i / 7), 101 + Math.sin(i / 7), 99 + Math.sin(i / 7), 100 + Math.sin(i / 7 + 0.1)]).map((c, i) => ({ ...c, epoch: Math.floor(1_800_000_000_000 / 1000 / gran) * gran + (i - 299) * gran }));
  const rebuilt = advanceCloudArmJob(j1, cs, 1_800_000_000_000 + 10 * 60 * 1000);
  assert.equal(rebuilt.realFills!.length, 1, "o rebuild determinístico não perde as medições");
});

// ---------------------------------------------------------------- REAL: Bybit mockado
const ENV = { BYBIT_API_KEY: "key-123456789", BYBIT_API_SECRET: "secret-123456789", BYBIT_BASE_URL: "https://api.bybit.test" };
const execRow = (o: Record<string, unknown>) => ({ execId: "e1", orderId: "O1", symbol: "BTCUSDT", side: "Buy", execType: "Trade", execPrice: "100.02", execQty: "0.5", execFee: "0.0275", isMaker: false, ...o });
function mockFetch(handlers: (url: string, init: RequestInit) => { status?: number; body?: unknown; throws?: boolean } | undefined) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (u: unknown, init: RequestInit = {}) => {
    const url = String(u);
    calls.push({ url, init });
    const r = handlers(url, init);
    if (!r) throw new Error("fetch inesperado " + url);
    if (r.throws) throw new Error("rede em baixo");
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => text } as unknown as Response;
  };
  return { fn: fn as unknown as typeof fetch, calls };
}
const noSleep = { sleep: async () => {}, delayMs: 0 };

test("summarizeExecutions: média ponderada, taxas, derrapagem vs sinal (positivo = pior), ignora Funding", () => {
  const rows = [
    execRow({ execPrice: "100", execQty: "1", execFee: "0.055" }),
    execRow({ execId: "e2", execPrice: "100.10", execQty: "1", execFee: "0.0551", isMaker: true }),
    execRow({ execId: "f", execType: "Funding", execPrice: "1", execQty: "9", execFee: "5" }),
    execRow({ execId: "o", orderId: "OUTRA", execPrice: "500", execQty: "9", execFee: "5" }),
  ];
  const f = place.summarizeExecutions(rows, { side: "BUY", signalPrice: 100, symbol: "BTCUSDT", key: "k", action: "open", orderId: "O1" });
  near(f.avgPrice, 100.05, 1e-9);
  near(f.qty, 2);
  near(f.execFee, 0.1101, 1e-12);
  near(f.feeFrac, 0.1101 / 200.1, 1e-12);
  near(f.slipFrac, 0.0005, 1e-9); // comprou 0,05 % acima do sinal = pior
  near(f.costFrac, f.feeFrac + f.slipFrac);
  assert.equal(f.execs, 2);
  assert.equal(f.makerExecs, 1);
  // venda abaixo do sinal = pior
  const s = place.summarizeExecutions([execRow({ side: "Sell", execPrice: "99.9", execQty: "1", execFee: "0.05" })], { side: "SELL", signalPrice: 100, symbol: "BTCUSDT", key: "k", action: "close" });
  near(s.slipFrac, 0.001, 1e-9);
  // melhoria (venda acima do sinal) = negativo; rebate de taxa preservado
  const g = place.summarizeExecutions([execRow({ execPrice: "100.2", execQty: "1", execFee: "-0.01" })], { side: "SELL", signalPrice: 100, symbol: "BTCUSDT", key: "k", action: "close" });
  assert.ok(g.slipFrac < 0 && g.feeFrac < 0);
  assert.equal(place.summarizeExecutions([], { side: "BUY", signalPrice: 100, symbol: "X", key: "k", action: "open" }), null);
  assert.equal(place.summarizeExecutions([execRow({})], { side: "BUY", signalPrice: 0, symbol: "X", key: "k", action: "open" }), null);
});

test("fetchOrderExecutions: GET assinado em /v5/execution/list, repete se vazio, nunca lança", async () => {
  let n = 0;
  const m = mockFetch((url) => {
    if (!url.includes("/v5/execution/list")) return undefined;
    n += 1;
    return { body: { retCode: 0, result: { list: n < 2 ? [] : [execRow({})] } } };
  });
  const r = await place.fetchOrderExecutions({ symbol: "BTCUSDT", orderId: "O1" }, ENV, m.fn, noSleep);
  assert.equal(r.ok, true);
  assert.equal(m.calls.length, 2);
  const c = m.calls[0]!;
  assert.match(c.url, /^https:\/\/api\.bybit\.test\/v5\/execution\/list\?category=linear&symbol=BTCUSDT&limit=50&orderId=O1$/);
  assert.equal(c.init.method, "GET");
  const h = c.init.headers as Record<string, string>;
  assert.ok(h["X-BAPI-SIGN"] && h["X-BAPI-API-KEY"] === ENV.BYBIT_API_KEY && h["X-BAPI-TIMESTAMP"]);
  assert.equal(c.init.body, undefined);
  assert.ok(!JSON.stringify(h).includes(ENV.BYBIT_API_SECRET), "o segredo nunca vai nos headers");

  for (const bad of [
    { status: 500, body: "erro" },
    { body: { retCode: 10001, retMsg: "params" } },
    { throws: true },
    { body: { retCode: 0, result: { list: [] } } },
  ]) {
    const mm = mockFetch(() => bad);
    const rr = await place.fetchOrderExecutions({ symbol: "BTCUSDT", orderId: "O1" }, ENV, mm.fn, noSleep);
    assert.equal(rr.ok, false);
    assert.ok(typeof rr.error === "string" && rr.error.length > 0);
  }
  assert.deepEqual(await place.fetchOrderExecutions({ symbol: "BTCUSDT", orderId: "O1" }, {}, m.fn, noSleep), { ok: false, error: "keys_missing" });
  assert.equal((await place.fetchOrderExecutions({ symbol: "bad", orderId: "O1" }, ENV, m.fn, noSleep)).ok, false);
  assert.equal((await place.fetchOrderExecutions({ symbol: "BTCUSDT" }, ENV, m.fn, noSleep)).ok, false);
});

test("measureOrderFill: usa orderId da resposta; falhas devolvem ok:false sem lançar", async () => {
  const m = mockFetch((url) => (url.includes("orderId=O1") ? { body: { retCode: 0, result: { list: [execRow({ execPrice: "100.1", execQty: "1", execFee: "0.055" })] } } } : undefined));
  const order = { ok: true, body: { retCode: 0, result: { orderId: "O1" } } };
  const r = await place.measureOrderFill(order, { symbol: "BTCUSDT", side: "BUY", signalPrice: 100, key: "k", action: "open" }, ENV, m.fn, noSleep);
  assert.equal(r.ok, true);
  near(r.fill.slipFrac, 0.001, 1e-9);
  assert.equal((await place.measureOrderFill({ ok: false }, { symbol: "BTCUSDT", side: "BUY", signalPrice: 100, key: "k", action: "open" }, ENV, m.fn, noSleep)).error, "order_not_ok");
  assert.equal((await place.measureOrderFill(order, { symbol: "BTCUSDT", side: "BUY", key: "k", action: "open" }, ENV, m.fn, noSleep)).error, "signal_price_missing");
  assert.equal(m.calls.length, 1, "sem preço de sinal não há chamada à Bybit");
  const down = mockFetch(() => ({ throws: true }));
  assert.equal((await place.measureOrderFill(order, { symbol: "BTCUSDT", side: "BUY", signalPrice: 100, key: "k", action: "open" }, ENV, down.fn, noSleep)).ok, false);
});

test("arm: recordRealFill guarda a medição no job; falha só regista linha e não altera o resto", async () => {
  const job = createCloudArmJob({ symbol: "BTCUSDT", strategyPreset: "lucro_rapido", stake: 1, leverage: 1, granularity: 300, durationMinutes: 60, clientId: "c_testclient77", mode: "REAL" }, 1_800_000_000_000);
  const order = { ok: true, status: 200, body: { retCode: 0, result: { orderId: "O9" } } };
  const good = mockFetch(() => ({ body: { retCode: 0, result: { list: [execRow({ orderId: "O9", execPrice: "100.05", execQty: "0.01", execFee: "0.00055" })] } } }));
  const j1 = await recordRealFill(job, order, { side: "BUY", price: 100, key: "trade_opened:1:1:", action: "open" }, ENV, good.fn, noSleep);
  assert.equal(j1.realFills.length, 1);
  assert.equal(j1.realFills[0].action, "open");
  assert.match(j1.events.at(-1).text, /REAL custo open: taxa .*% \+ derrapagem .*% vs sinal/);
  assert.equal(j1.realOpenQty, job.realOpenQty);
  assert.equal(j1.status, job.status);

  const bad = mockFetch(() => ({ throws: true }));
  const j2 = await recordRealFill(job, order, { side: "SELL", price: 100, key: "k2", action: "close" }, ENV, bad.fn, noSleep);
  assert.equal((j2.realFills ?? []).length, 0);
  assert.match(j2.events.at(-1).text, /REAL custo não medido \(close\)/);
  assert.equal(j2.status, job.status);
});

// ---------------------------------------------------------------- api/bybit-order.js (caminho manual)
interface Res { code: number; text: string }
function callOrder(body: Record<string, unknown>): Promise<Res> {
  return new Promise((resolve, reject) => {
    const out: Res = { code: 200, text: "" };
    const res = {
      setHeader() {},
      status(c: number) { out.code = c; return res; },
      json(b: unknown) { out.text = JSON.stringify(b); resolve(out); return res; },
      send(t: string) { out.text = t; resolve(out); return res; },
      end() { resolve(out); return res; },
    };
    Promise.resolve(orderHandler({ method: "POST", url: "/api/bybit-order", headers: {}, body }, res)).catch(reject);
  });
}
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) { if (k in savedEnv) process.env[k] = savedEnv[k]!; else delete process.env[k]; }
});
const ORDER_OK = { retCode: 0, retMsg: "OK", result: { orderId: "O1", orderLinkId: "" }, time: 1 };
const manualBody = { mode: "REAL", symbol: "BTCUSDT", side: "BUY", quantity: "0.01", stake: 1, evidenceAllowed: true, sessionElapsedMs: 1000, signalPrice: 100 };

test("manual: ordem aceite + execução lida → resposta original + nlExecution", async () => {
  Object.assign(process.env, ENV);
  const m = mockFetch((url) => {
    if (url.includes("/v5/order/create")) return { body: ORDER_OK };
    if (url.includes("/v5/execution/list")) return { body: { retCode: 0, result: { list: [execRow({ execPrice: "100.03", execQty: "0.01", execFee: "0.000550" })] } } };
    return undefined;
  });
  globalThis.fetch = m.fn;
  const r = await callOrder(manualBody);
  assert.equal(r.code, 200);
  const j = JSON.parse(r.text);
  assert.equal(j.retCode, 0);
  assert.equal(j.result.orderId, "O1");
  assert.ok(j.nlExecution);
  near(j.nlExecution.slipFrac, 0.0003, 1e-9);
  assert.equal(j.nlExecution.action, "open");
  // a ordem foi colocada primeiro, uma só vez
  assert.equal(m.calls.filter((c) => c.url.includes("/v5/order/create")).length, 1);
});

test("manual: falha ao ler execuções NUNCA altera a ordem: corpo e estado idênticos ao da Bybit", async () => {
  Object.assign(process.env, ENV);
  for (const execBehaviour of [{ status: 500, body: "boom" }, { throws: true }, { body: { retCode: 10001, retMsg: "x" } }]) {
    const m = mockFetch((url) => {
      if (url.includes("/v5/order/create")) return { body: ORDER_OK };
      if (url.includes("/v5/execution/list")) return execBehaviour;
      return undefined;
    });
    globalThis.fetch = m.fn;
    const r = await callOrder(manualBody);
    assert.equal(r.code, 200);
    const j = JSON.parse(r.text);
    assert.equal(j.retCode, 0);
    assert.equal(j.result.orderId, "O1");
    assert.equal(j.nlExecution, undefined);
    assert.equal(typeof j.nlExecutionError, "string");
  }
});

test("manual: sem signalPrice não há leitura de execuções; ordem recusada pela Bybit não é medida e passa intacta", async () => {
  Object.assign(process.env, ENV);
  const m = mockFetch((url) => (url.includes("/v5/order/create") ? { body: ORDER_OK } : undefined));
  globalThis.fetch = m.fn;
  const { signalPrice: _s, ...noSig } = manualBody;
  void _s;
  const r = await callOrder(noSig);
  assert.equal(r.text, JSON.stringify(ORDER_OK), "resposta byte-a-byte igual");
  assert.equal(m.calls.length, 1);

  const rej = { retCode: 110007, retMsg: "insufficient" };
  const m2 = mockFetch((url) => (url.includes("/v5/order/create") ? { status: 200, body: rej } : undefined));
  globalThis.fetch = m2.fn;
  const r2 = await callOrder(manualBody);
  assert.equal(r2.text, JSON.stringify(rej));
  assert.equal(m2.calls.length, 1);
});

test("manual: guardas existentes intactas (porta fechada, PAPER, martingale)", async () => {
  Object.assign(process.env, ENV);
  globalThis.fetch = (async () => { throw new Error("não devia chamar a rede"); }) as unknown as typeof fetch;
  assert.equal((await callOrder({ ...manualBody, evidenceAllowed: false })).code, 403);
  assert.equal((await callOrder({ ...manualBody, mode: "PAPER" })).code, 403);
  assert.equal((await callOrder({ ...manualBody, martingale: true })).code, 400);
});

// ---------------------------------------------------------------- UI (estático)
test("UI: linhas de custo escondidas por omissão, só n>0, sem tocar no Deriv OAuth", () => {
  const html = readFileSync(join(root, "public/bybit.html"), "utf8");
  const js = readFileSync(join(root, "public/assets/bybit.js"), "utf8");
  assert.match(html, /id="costLineReal"[^>]*hidden/);
  assert.match(html, /id="costLineModeled"[^>]*hidden/);
  assert.match(js, /function renderCostLine\(/);
  assert.match(js, /realEl\.hidden = !realText/);
  assert.match(js, /summarizeRealFills/);
  assert.match(js, /signalPrice: e\.entry/);
  assert.match(js, /signalPrice: e\.exit/);
  assert.match(js, /nlExecution/);
  assert.match(js, /só informação/);
  const bundle = readFileSync(join(root, "public/assets/nl-core.js"), "utf8");
  assert.match(bundle, /summarizeRealFills/);
  assert.match(bundle, /formatModeledCostLine/);
  const cloud = readFileSync(join(root, "lib/nl-cloud.mjs"), "utf8");
  assert.match(cloud, /addRealFill/);
  const arm = readFileSync(join(root, "api/bybit-arm.js"), "utf8");
  assert.match(arm, /recordRealFill/);
});
