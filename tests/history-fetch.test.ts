// lib/history.js — histórico profundo por janelas alinhadas. fetch simulado (nenhum pedido real à Bybit).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JS sem tipos
import { planWindows, fetchWindow, fetchDeepHistory, windowSeconds, lastClosedStart, HistoryError } from "../lib/history.js";

const GRAN = 300;
const NOW_MS = 1_760_000_000_000 + 123_456; // instante arbitrário a meio de uma vela
const NOW_S = Math.floor(NOW_MS / 1000);

type Row = string[];
interface FakeOpts {
  /** Primeira vela existente (epoch s). Antes disto: lista vazia (símbolo ainda não existia). */
  listing?: number;
  /** Chamada n (0-based) a esta janela → resposta personalizada. */
  intercept?: (call: { url: URL; base: string; n: number; windowStart: number }) => Response | undefined | Promise<Response | undefined>;
  duplicateEdge?: boolean;
  zeroVolBefore?: number;
  openCandle?: boolean;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function makeFake(o: FakeOpts = {}) {
  const log: { url: URL; base: string; at: number }[] = [];
  const perWindow = new Map<number, number>();
  let inflight = 0;
  let maxInflight = 0;
  const fn = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const base = url.origin;
    log.push({ url, base, at: log.length });
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      await new Promise((r) => setTimeout(r, 2)); // deixa os pedidos sobrepor-se
      const start = Number(url.searchParams.get("start")) / 1000;
      const end = (Number(url.searchParams.get("end")) + 1) / 1000;
      const limit = Number(url.searchParams.get("limit"));
      const n = perWindow.get(start) ?? 0;
      perWindow.set(start, n + 1);
      if (o.intercept) {
        const r = await o.intercept({ url, base, n, windowStart: start });
        if (r) return r;
      }
      const listing = o.listing ?? 0;
      const rows: Row[] = [];
      const lastStart = Math.floor(NOW_S / GRAN) * GRAN; // vela em formação
      for (let e = Math.min(end - GRAN, lastStart); e >= Math.max(start, listing); e -= GRAN) {
        if (e < start) break;
        const price = 100 + (e / GRAN) % 7;
        const vol = o.zeroVolBefore && e < o.zeroVolBefore ? "0" : "12.5";
        rows.push([String(e * 1000), String(price), String(price + 1), String(price - 1), String(price + 0.5), vol, "1"]);
        if (rows.length >= limit) break;
      }
      if (o.duplicateEdge && rows.length > 2) rows.splice(1, 0, rows[0]!.slice()); // linha repetida
      return json({ retCode: 0, retMsg: "OK", result: { list: rows } });
    } finally {
      inflight -= 1;
    }
  };
  return { fn: fn as unknown as typeof fetch, log, get maxInflight() { return maxInflight; } };
}

const noSleep = { sleep: async () => {}, random: () => 0.5, now: () => NOW_MS };

test("planWindows: janelas alinhadas, contíguas, sem sobreposição, a cobrir `count` velas", () => {
  const w = windowSeconds(GRAN);
  assert.equal(w, 300_000);
  const wins = planWindows(NOW_MS, GRAN, 2500);
  assert.ok(wins.length >= 3 && wins.length <= 4);
  for (const x of wins) {
    assert.equal(x.start % w, 0);
    assert.equal(x.end - x.start, w);
  }
  for (let i = 1; i < wins.length; i++) assert.equal(wins[i - 1]!.start, wins[i]!.end); // mais recente primeiro, contíguas
  const newest = lastClosedStart(NOW_MS, GRAN);
  assert.ok(wins[0]!.start <= newest && newest < wins[0]!.end);
  assert.ok(wins[wins.length - 1]!.start <= newest - 2499 * GRAN);
  assert.equal(planWindows(NOW_MS, GRAN, 1).length, 1);
  assert.throws(() => planWindows(NOW_MS, GRAN, 0), RangeError);
  assert.throws(() => planWindows(NOW_MS, 123, 10), RangeError);
  // 90 dias em 5m = 25 920 velas → 26 ou 27 janelas
  const n90 = planWindows(NOW_MS, GRAN, 25_920).length;
  assert.ok(n90 === 26 || n90 === 27, String(n90));
});

test("histórico: ordenado, sem duplicados, só fechadas, exactamente `count` velas contíguas", async () => {
  const fake = makeFake();
  const r = await fetchDeepHistory("BTCUSDT", GRAN, { count: 2500, fetchImpl: fake.fn, ...noSleep });
  assert.equal(r.complete, true);
  assert.equal(r.candles.length, 2500);
  const newest = lastClosedStart(NOW_MS, GRAN);
  assert.equal(r.newestEpoch, newest);
  assert.equal(r.oldestEpoch, newest - 2499 * GRAN);
  for (let i = 1; i < r.candles.length; i++) assert.equal(r.candles[i].epoch - r.candles[i - 1].epoch, GRAN);
  assert.equal(r.openDropped, 1); // a vela em formação foi recebida e descartada
  // pedidos: janelas alinhadas, limite 1000, end inclusivo = fim da janela - 1 ms
  for (const l of fake.log) {
    const s = Number(l.url.searchParams.get("start"));
    const e = Number(l.url.searchParams.get("end"));
    assert.equal(s % 300_000_000, 0);
    assert.equal(e - s + 1, 300_000_000);
    assert.equal(l.url.searchParams.get("limit"), "1000");
    assert.equal(l.url.searchParams.get("category"), "linear");
  }
});

test("vela aberta nunca entra, mesmo que o servidor a envie com volume", async () => {
  const fake = makeFake({ openCandle: true });
  const r = await fetchDeepHistory("BTCUSDT", GRAN, { count: 300, fetchImpl: fake.fn, ...noSleep });
  const lastOpenStart = Math.floor(NOW_S / GRAN) * GRAN;
  assert.ok(r.candles.every((c: { epoch: number }) => c.epoch + GRAN <= NOW_S));
  assert.ok(!r.candles.some((c: { epoch: number }) => c.epoch === lastOpenStart));
});

test("duplicados dentro de uma janela são removidos", async () => {
  const fake = makeFake({ duplicateEdge: true });
  const r = await fetchDeepHistory("ETHUSDT", GRAN, { count: 1500, fetchImpl: fake.fn, ...noSleep });
  assert.equal(r.candles.length, 1500);
  assert.equal(new Set(r.candles.map((c: { epoch: number }) => c.epoch)).size, 1500);
});

test("velas com volume 0 são filtradas (história antiga) e contadas", async () => {
  const newest = lastClosedStart(NOW_MS, GRAN);
  const fake = makeFake({ zeroVolBefore: newest - 999 * GRAN });
  const r = await fetchDeepHistory("BTCUSDT", GRAN, { count: 2000, fetchImpl: fake.fn, ...noSleep });
  assert.equal(r.candles.length, 1000);
  assert.ok(r.zeroVolumeDropped >= 1000); // inclui as da janela mais antiga, que é buscada inteira
  assert.equal(r.oldestEpoch, newest - 999 * GRAN);
  const keep = await fetchDeepHistory("BTCUSDT", GRAN, { count: 2000, fetchImpl: makeFake({ zeroVolBefore: newest - 999 * GRAN }).fn, dropZeroVolume: false, ...noSleep });
  assert.equal(keep.candles.length, 2000);
});

test("erro 500 temporário: repete com recuo exponencial e acaba completo", async () => {
  const delays: number[] = [];
  let hits = 0;
  const fake = makeFake({
    intercept: ({ n }) => {
      hits += 1;
      if (n < 4) return new Response("boom", { status: 502 });
      return undefined;
    },
  });
  const r = await fetchWindow("BTCUSDT", GRAN, planWindows(NOW_MS, GRAN, 10)[0], {
    fetchImpl: fake.fn,
    now: () => NOW_MS,
    random: () => 0.5,
    sleep: async (ms: number) => { delays.push(ms); },
    baseDelayMs: 100,
  });
  assert.ok(r.candles.length > 0);
  assert.ok(hits >= 5);
  assert.equal(delays.length >= 2, true);
  assert.ok(delays[1]! > delays[0]!, `recuo cresce: ${delays}`);
});

test("limite de pedidos (429 + Retry-After): respeita a pausa e partilha-a entre trabalhadores", async () => {
  const delays: number[] = [];
  let first = true;
  const fake = makeFake({
    intercept: () => {
      if (first) {
        first = false;
        return new Response("slow down", { status: 429, headers: { "retry-after": "3" } });
      }
      return undefined;
    },
  });
  const r = await fetchDeepHistory("BTCUSDT", GRAN, {
    count: 3000, fetchImpl: fake.fn, now: () => NOW_MS, random: () => 0.5,
    sleep: async (ms: number) => { delays.push(ms); },
  });
  assert.equal(r.complete, true);
  assert.equal(r.candles.length, 3000);
  assert.ok(delays.some((d) => d >= 3000), `esperou o Retry-After: ${delays}`);
});

test("retCode 10006 (rate limit da Bybit no corpo) também é repetido", async () => {
  let n = 0;
  const fake = makeFake({ intercept: () => (n++ === 0 ? json({ retCode: 10006, retMsg: "Too many visits" }) : undefined) });
  const r = await fetchDeepHistory("BTCUSDT", GRAN, { count: 500, fetchImpl: fake.fn, ...noSleep });
  assert.equal(r.complete, true);
  assert.equal(r.candles.length, 500);
});

test("403 na base principal: usa a base alternativa", async () => {
  const fake = makeFake({ intercept: ({ base }) => (base === "https://api.bybit.com" ? new Response("blocked", { status: 403 }) : undefined) });
  const r = await fetchDeepHistory("BTCUSDT", GRAN, { count: 800, fetchImpl: fake.fn, ...noSleep });
  assert.equal(r.complete, true);
  assert.equal(r.candles.length, 800);
  assert.ok(fake.log.some((l) => l.base === "https://api.bytick.com"));
});

test("403 em todas as bases: erro fatal imediato, sem martelar a API", async () => {
  const fake = makeFake({ intercept: () => new Response("blocked", { status: 403 }) });
  await assert.rejects(
    fetchDeepHistory("BTCUSDT", GRAN, { count: 20_000, fetchImpl: fake.fn, ...noSleep }),
    (e: { code: string; fatal: boolean }) => e.code === "blocked" && e.fatal === true,
  );
  assert.ok(fake.log.length <= 12, `pedidos: ${fake.log.length}`); // concorrência x 2 bases, não 20 janelas x repetições
});

test("símbolo inválido (retCode 10001): falha permanente, sem repetições", async () => {
  const fake = makeFake({ intercept: () => json({ retCode: 10001, retMsg: "Illegal category/symbol" }) });
  await assert.rejects(
    fetchDeepHistory("XXXUSDT", GRAN, { count: 3000, fetchImpl: fake.fn, ...noSleep }),
    (e: { code: string }) => e.code === "bybit_10001",
  );
  assert.ok(fake.log.length <= 5);
});

test("janela do meio falha para sempre: devolve só a cauda contígua mais recente e complete=false", async () => {
  const wins = planWindows(NOW_MS, GRAN, 3500);
  assert.ok(wins.length >= 4);
  const bad = wins[1]!.start;
  const fake = makeFake({ intercept: ({ windowStart }) => (windowStart === bad ? new Response("x", { status: 503 }) : undefined) });
  const r = await fetchDeepHistory("BTCUSDT", GRAN, { count: 3500, fetchImpl: fake.fn, retries: 2, ...noSleep });
  assert.equal(r.complete, false);
  assert.equal(r.failedWindows.length, 1);
  assert.equal(r.failedWindows[0].start, bad);
  assert.ok(r.oldestEpoch >= wins[1]!.end, "nada de antes do buraco");
  assert.equal(r.newestEpoch, lastClosedStart(NOW_MS, GRAN));
  for (let i = 1; i < r.candles.length; i++) assert.equal(r.candles[i].epoch - r.candles[i - 1].epoch, GRAN);
});

test("símbolo recente (janelas antigas vazias): pára cedo, complete=true e poucos pedidos", async () => {
  const newest = lastClosedStart(NOW_MS, GRAN);
  const fake = makeFake({ listing: newest - 1200 * GRAN });
  const r = await fetchDeepHistory("NEWUSDT", GRAN, { days: 90, fetchImpl: fake.fn, concurrency: 2, ...noSleep });
  assert.equal(r.complete, true);
  assert.equal(r.candles.length, 1201);
  assert.ok(r.windows >= 26);
  assert.ok(fake.log.length < 10, `pedidos: ${fake.log.length} de ${r.windows} janelas`);
});

test("resposta vazia temporária: confirma uma vez e recupera os dados", async () => {
  let n = 0;
  const fake = makeFake({ intercept: () => (n++ === 0 ? json({ retCode: 0, result: { list: [] } }) : undefined) });
  const r = await fetchDeepHistory("BTCUSDT", GRAN, { count: 400, fetchImpl: fake.fn, ...noSleep });
  assert.equal(r.candles.length, 400);
});

test("concorrência limitada: paralelo (>1) mas nunca acima do máximo pedido", async () => {
  const fake = makeFake();
  const r = await fetchDeepHistory("BTCUSDT", GRAN, { days: 30, fetchImpl: fake.fn, concurrency: 4, ...noSleep });
  assert.equal(r.candles.length, 8640);
  assert.ok(fake.maxInflight > 1 && fake.maxInflight <= 4, `max em voo: ${fake.maxInflight}`);
  assert.ok(r.windows >= 9 && r.windows <= 10);
  assert.equal(r.requests, fake.log.length);
});

test("linhas inválidas / fora da janela / lixo são ignoradas", async () => {
  const fake = makeFake({
    intercept: ({ windowStart }) => {
      const s = windowStart;
      const good = (e: number) => [String(e * 1000), "10", "11", "9", "10.5", "5", "1"];
      return json({
        retCode: 0,
        result: { list: [good(s + 300), ["x", "1", "1", "1", "1"], ["short"], good(s - 300), [String((s + 301) * 1000), "10", "11", "9", "10", "5"], [String((s + 600) * 1000), "10", "9", "11", "10", "5"], good(s + 900)] },
      });
    },
  });
  const w = planWindows(NOW_MS, GRAN, 10)[0]!;
  const r = await fetchWindow("BTCUSDT", GRAN, { start: w.start - 300_000, end: w.start }, { fetchImpl: fake.fn, ...noSleep });
  assert.deepEqual(r.candles.map((c: { epoch: number }) => c.epoch), [w.start - 300_000 + 300, w.start - 300_000 + 900]);
});

test("HistoryError exportado", () => {
  assert.ok(new HistoryError("x", "y", true).fatal);
});
