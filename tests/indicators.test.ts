import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, macd, bollinger, atr, stochastic, adx } from "../src/core/indicators.ts";
import type { Candle } from "../src/core/market-data.ts";

function close(actual: number | null, expected: number, tol = 1e-9): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `${actual} não está perto de ${expected}`);
}

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

function randomCandles(seed: number, n: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close2 = open + (r() - 0.5) * 2;
    const high = Math.max(open, close2) + r() * 0.5;
    const low = Math.min(open, close2) - r() * 0.5;
    out.push({ epoch: 1_700_000_000 + i * 300, open, high, low, close: close2 });
    price = close2;
  }
  return out;
}

test("SMA: valores conhecidos e posição dos nulos", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(sma([5], 1), [5]);
  assert.deepEqual(sma([1, 2], 3), [null, null]);
});

test("EMA: numa reta o atraso é constante e a semente é a média simples", () => {
  const e = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  close(e[2], 2);
  close(e[3], 3);
  close(e[9], 9);
});

test("RSI: conta à mão com período 2", () => {
  const r = rsi([1, 2, 1, 2], 2);
  assert.deepEqual(r.slice(0, 2), [null, null]);
  close(r[2], 50);
  close(r[3], 75);
});

test("RSI: só subidas = 100, só descidas = 0, parado = 50", () => {
  const up = rsi(Array.from({ length: 30 }, (_, i) => i), 14);
  const down = rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
  const flat = rsi(new Array(30).fill(5), 14);
  close(up[29], 100);
  close(down[29], 0);
  close(flat[29], 50);
  assert.equal(up[13], null);
  assert.notEqual(up[14], null);
});

test("Bollinger: conta à mão e série constante", () => {
  const b = bollinger([1, 2, 3], 3, 2);
  close(b.mid[2], 2);
  close(b.upper[2], 2 + 2 * Math.sqrt(2 / 3));
  close(b.lower[2], 2 - 2 * Math.sqrt(2 / 3));
  const c = bollinger(new Array(25).fill(7), 20, 2);
  close(c.upper[24], 7);
  close(c.lower[24], 7);
  assert.equal(c.mid[18], null);
});

test("MACD: série constante dá zero e as posições dos nulos estão certas", () => {
  const m = macd(new Array(60).fill(10));
  assert.equal(m.macd[24], null);
  close(m.macd[25], 0);
  assert.equal(m.signal[32], null);
  close(m.signal[33], 0);
  close(m.hist[33], 0);
});

test("MACD: em subida forte fica positivo", () => {
  const m = macd(Array.from({ length: 80 }, (_, i) => 100 + i));
  assert.ok(m.macd[79]! > 0);
});

test("ATR: amplitude constante", () => {
  const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
    epoch: i, open: 10, high: 11, low: 9, close: 10,
  }));
  const a = atr(candles, 14);
  assert.equal(a[12], null);
  close(a[13], 2);
  close(a[29], 2);
});

test("Estocástico: fecho no máximo = 100 e no mínimo = 0", () => {
  const subida: Candle[] = Array.from({ length: 20 }, (_, i) => ({
    epoch: i, open: i, high: i + 1, low: i - 1, close: i + 1,
  }));
  const s = stochastic(subida, 5, 3);
  close(s.k[19], 100);
  const descida: Candle[] = Array.from({ length: 20 }, (_, i) => ({
    epoch: i, open: 100 - i, high: 101 - i, low: 99 - i, close: 99 - i,
  }));
  close(stochastic(descida, 5, 3).k[19], 0);
  assert.equal(s.k[3], null);
  assert.equal(s.d[5], null);
  assert.notEqual(s.d[6], null);
});

test("ADX: tendência limpa de subida dá ADX 100 e -DI 0", () => {
  const candles: Candle[] = Array.from({ length: 60 }, (_, i) => ({
    epoch: i, open: 100 + i, high: 100.5 + i, low: 99.5 + i, close: 100 + i,
  }));
  const a = adx(candles, 14);
  assert.equal(a.adx[26], null);
  close(a.adx[27], 100);
  close(a.minusDI[40], 0);
  assert.ok(a.plusDI[40]! > 0);
});

test("propriedades em dados aleatórios: limites e ordem das bandas", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const c = randomCandles(seed, 400);
    const closes = c.map((x) => x.close);
    for (const v of rsi(closes)) if (v !== null) assert.ok(v >= 0 && v <= 100);
    const st = stochastic(c);
    for (const v of [...st.k, ...st.d]) if (v !== null) assert.ok(v >= 0 && v <= 100 + 1e-9);
    const ad = adx(c);
    for (const v of ad.adx) if (v !== null) assert.ok(v >= 0 && v <= 100 + 1e-9);
    for (const v of atr(c)) if (v !== null) assert.ok(v > 0);
    const bb = bollinger(closes);
    bb.mid.forEach((m, i) => {
      if (m !== null) assert.ok(bb.upper[i]! >= m && m >= bb.lower[i]!);
    });
    const mc = macd(closes);
    mc.hist.forEach((h, i) => {
      if (h !== null) close(h, mc.macd[i]! - mc.signal[i]!, 1e-9);
    });
  }
});

test("todas as séries têm o tamanho da entrada", () => {
  const c = randomCandles(3, 120);
  const closes = c.map((x) => x.close);
  const n = closes.length;
  assert.equal(sma(closes, 10).length, n);
  assert.equal(ema(closes, 10).length, n);
  assert.equal(rsi(closes).length, n);
  assert.equal(macd(closes).signal.length, n);
  assert.equal(bollinger(closes).upper.length, n);
  assert.equal(atr(c).length, n);
  assert.equal(stochastic(c).d.length, n);
  assert.equal(adx(c).adx.length, n);
});

test("dados curtos dão só nulos, sem erro", () => {
  assert.ok(rsi([1, 2, 3], 14).every((x) => x === null));
  assert.ok(macd([1, 2, 3]).macd.every((x) => x === null));
  assert.ok(adx(randomCandles(1, 10), 14).adx.every((x) => x === null));
});

test("entradas inválidas são rejeitadas", () => {
  assert.throws(() => sma([1, 2, 3], 0), RangeError);
  assert.throws(() => sma([1, NaN, 3], 2), RangeError);
  assert.throws(() => ema([1, 2, 3], 2.5), RangeError);
  assert.throws(() => rsi([1, Infinity], 2), RangeError);
  assert.throws(() => macd([1, 2, 3], 26, 12, 9), RangeError);
  assert.throws(() => bollinger([1, 2, 3], 3, 0), RangeError);
  const ruim = [{ epoch: 1, open: 1, high: 0, low: 2, close: 1 }];
  assert.throws(() => atr(ruim, 1), RangeError);
  assert.throws(() => stochastic(ruim, 1, 1), RangeError);
  assert.throws(() => adx(ruim, 1), RangeError);
});
