// NEVER LOSS - indicadores técnicos (funções puras, sem rede).
// Cada função devolve uma série do mesmo tamanho da entrada; `null` = ainda sem dados suficientes.
// Nenhum indicador garante lucro: a porta de evidência decide quais servem, com dados fora da amostra.

import type { Candle } from "./market-data.ts";

export type Series = (number | null)[];

function assertPeriod(p: number, label = "period", min = 1): void {
  if (!Number.isInteger(p) || p < min) throw new RangeError(`${label} inválido: ${p}`);
}

function assertValues(values: readonly number[]): void {
  for (const v of values) if (!Number.isFinite(v)) throw new RangeError(`Valor inválido: ${v}`);
}

function assertCandles(candles: readonly Candle[]): void {
  for (const c of candles) {
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite) || c.high < c.low) {
      throw new RangeError("Vela inválida");
    }
  }
}

const empty = (n: number): Series => new Array<number | null>(n).fill(null);

/** Média móvel simples. */
export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  assertValues(values);
  const out = empty(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Média móvel exponencial (semente = média simples dos primeiros `period` valores). */
export function ema(values: readonly number[], period: number): Series {
  assertPeriod(period);
  assertValues(values);
  const out = empty(values.length);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI de Wilder. Mercado parado (sem ganhos nem perdas) dá 50. */
export function rsi(closes: readonly number[], period = 14): Series {
  assertPeriod(period);
  assertValues(closes);
  const out = empty(closes.length);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = (g: number, l: number): number => (g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  hist: Series;
}

/** MACD: EMA rápida - EMA lenta, linha de sinal (EMA do MACD) e histograma. */
export function macd(closes: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  assertPeriod(fast, "fast");
  assertPeriod(slow, "slow");
  assertPeriod(signalPeriod, "signal");
  if (fast >= slow) throw new RangeError("fast tem de ser menor que slow");
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = empty(closes.length);
  for (let i = 0; i < closes.length; i++) {
    if (f[i] !== null && s[i] !== null) line[i] = f[i]! - s[i]!;
  }
  const first = line.findIndex((x) => x !== null);
  const signal = empty(closes.length);
  const hist = empty(closes.length);
  if (first >= 0) {
    const defined = line.slice(first) as number[];
    const sig = ema(defined, signalPeriod);
    for (let j = 0; j < sig.length; j++) {
      if (sig[j] !== null) {
        signal[first + j] = sig[j]!;
        hist[first + j] = line[first + j]! - sig[j]!;
      }
    }
  }
  return { macd: line, signal, hist };
}

export interface BollingerResult {
  mid: Series;
  upper: Series;
  lower: Series;
}

/** Bandas de Bollinger (desvio-padrão populacional). */
export function bollinger(closes: readonly number[], period = 20, k = 2): BollingerResult {
  assertPeriod(period);
  if (!Number.isFinite(k) || k <= 0) throw new RangeError(`k inválido: ${k}`);
  const mid = sma(closes, period);
  const upper = empty(closes.length);
  const lower = empty(closes.length);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i]!;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j]! - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}

/** Amplitude verdadeira média (ATR de Wilder). */
export function atr(candles: readonly Candle[], period = 14): Series {
  assertPeriod(period);
  assertCandles(candles);
  const out = empty(candles.length);
  if (candles.length < period) return out;
  const tr: number[] = candles.map((c, i) =>
    i === 0
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1]!.close), Math.abs(c.low - candles[i - 1]!.close)),
  );
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export interface StochasticResult {
  k: Series;
  d: Series;
}

/** Oscilador estocástico (%K e %D). Sem amplitude no período dá 50. */
export function stochastic(candles: readonly Candle[], kPeriod = 14, dPeriod = 3): StochasticResult {
  assertPeriod(kPeriod, "kPeriod");
  assertPeriod(dPeriod, "dPeriod");
  assertCandles(candles);
  const k = empty(candles.length);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j]!.high);
      ll = Math.min(ll, candles[j]!.low);
    }
    k[i] = hh === ll ? 50 : (100 * (candles[i]!.close - ll)) / (hh - ll);
  }
  const d = empty(candles.length);
  for (let i = kPeriod - 1 + dPeriod - 1; i < candles.length; i++) {
    let s = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) s += k[j]!;
    d[i] = s / dPeriod;
  }
  return { k, d };
}

export interface AdxResult {
  adx: Series;
  plusDI: Series;
  minusDI: Series;
}

/** ADX de Wilder com +DI e -DI (força e direção da tendência). */
export function adx(candles: readonly Candle[], period = 14): AdxResult {
  assertPeriod(period);
  assertCandles(candles);
  const n = candles.length;
  const out: AdxResult = { adx: empty(n), plusDI: empty(n), minusDI: empty(n) };
  if (n <= period) return out;

  const tr: number[] = [0];
  const pdm: number[] = [0];
  const mdm: number[] = [0];
  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high;
    const down = p.low - c.low;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
  }

  let sTr = 0;
  let sP = 0;
  let sM = 0;
  for (let i = 1; i <= period; i++) {
    sTr += tr[i]!;
    sP += pdm[i]!;
    sM += mdm[i]!;
  }
  const dx: number[] = [];
  const setDI = (i: number): void => {
    const pDI = sTr === 0 ? 0 : (100 * sP) / sTr;
    const mDI = sTr === 0 ? 0 : (100 * sM) / sTr;
    out.plusDI[i] = pDI;
    out.minusDI[i] = mDI;
    dx.push(pDI + mDI === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / (pDI + mDI));
  };
  setDI(period);
  for (let i = period + 1; i < n; i++) {
    sTr = sTr - sTr / period + tr[i]!;
    sP = sP - sP / period + pdm[i]!;
    sM = sM - sM / period + mdm[i]!;
    setDI(i);
  }
  // dx[0] corresponde ao índice `period`; o primeiro ADX é a média dos primeiros `period` DX.
  if (dx.length >= period) {
    let a = 0;
    for (let j = 0; j < period; j++) a += dx[j]!;
    a /= period;
    out.adx[2 * period - 1] = a;
    for (let j = period; j < dx.length; j++) {
      a = (a * (period - 1) + dx[j]!) / period;
      out.adx[period + j] = a;
    }
  }
  return out;
      }
