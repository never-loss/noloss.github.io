// src/core/stats.ts
var AGILE_MIN_OBS = 10;
var PRELIMINARY_MIN_OBS = 100;
var EVIDENCE_MIN_OBS = 1e3;
var ALPHA = 0.05;
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const c = [
    0.9999999999998099,
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9984369578019572e-21,
    15056327351493116e-23
  ];
  const xm = x - 1;
  let a = c[0];
  const t = xm + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}
function gammaPSeries(a, x) {
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n < 1e3; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}
function gammaQContinuedFraction(a, x) {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1e3; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}
function gammaQ(a, x) {
  if (!(a > 0) || x < 0 || !Number.isFinite(x)) throw new RangeError("argumentos inv\xE1lidos");
  if (x === 0) return 1;
  return x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQContinuedFraction(a, x);
}
function classify(n, adjustedP) {
  if (n < AGILE_MIN_OBS) return "INSUFFICIENT";
  if (adjustedP >= ALPHA) return "NO_EVIDENCE";
  if (n < PRELIMINARY_MIN_OBS) return "AGILE";
  if (n < EVIDENCE_MIN_OBS) return "PRELIMINARY";
  return "EVIDENCE";
}

// src/core/indicators.ts
function assertPeriod(p, label = "period", min = 1) {
  if (!Number.isInteger(p) || p < min) throw new RangeError(`${label} inv\xE1lido: ${p}`);
}
function assertValues(values) {
  for (const v of values) if (!Number.isFinite(v)) throw new RangeError(`Valor inv\xE1lido: ${v}`);
}
function assertCandles(candles) {
  for (const c of candles) {
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite) || c.high < c.low) {
      throw new RangeError("Vela inv\xE1lida");
    }
  }
}
var empty = (n) => new Array(n).fill(null);
function sma(values, period) {
  assertPeriod(period);
  assertValues(values);
  const out = empty(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function ema(values, period) {
  assertPeriod(period);
  assertValues(values);
  const out = empty(values.length);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rsi(closes2, period = 14) {
  assertPeriod(period);
  assertValues(closes2);
  const out = empty(closes2.length);
  if (closes2.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes2[i] - closes2[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const toRsi = (g, l) => g === 0 && l === 0 ? 50 : l === 0 ? 100 : 100 - 100 / (1 + g / l);
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < closes2.length; i++) {
    const d = closes2[i] - closes2[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}
function macd(closes2, fast = 12, slow = 26, signalPeriod = 9) {
  assertPeriod(fast, "fast");
  assertPeriod(slow, "slow");
  assertPeriod(signalPeriod, "signal");
  if (fast >= slow) throw new RangeError("fast tem de ser menor que slow");
  const f = ema(closes2, fast);
  const s = ema(closes2, slow);
  const line = empty(closes2.length);
  for (let i = 0; i < closes2.length; i++) {
    if (f[i] !== null && s[i] !== null) line[i] = f[i] - s[i];
  }
  const first = line.findIndex((x) => x !== null);
  const signal = empty(closes2.length);
  const hist = empty(closes2.length);
  if (first >= 0) {
    const defined = line.slice(first);
    const sig = ema(defined, signalPeriod);
    for (let j = 0; j < sig.length; j++) {
      if (sig[j] !== null) {
        signal[first + j] = sig[j];
        hist[first + j] = line[first + j] - sig[j];
      }
    }
  }
  return { macd: line, signal, hist };
}
function bollinger(closes2, period = 20, k = 2) {
  assertPeriod(period);
  if (!Number.isFinite(k) || k <= 0) throw new RangeError(`k inv\xE1lido: ${k}`);
  const mid = sma(closes2, period);
  const upper = empty(closes2.length);
  const lower = empty(closes2.length);
  for (let i = period - 1; i < closes2.length; i++) {
    const m = mid[i];
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes2[j] - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { mid, upper, lower };
}
function atr(candles, period = 14) {
  assertPeriod(period);
  assertCandles(candles);
  const out = empty(candles.length);
  if (candles.length < period) return out;
  const tr = candles.map(
    (c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))
  );
  let prev = 0;
  for (let i = 0; i < period; i++) prev += tr[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}
function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  assertPeriod(kPeriod, "kPeriod");
  assertPeriod(dPeriod, "dPeriod");
  assertCandles(candles);
  const k = empty(candles.length);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    k[i] = hh === ll ? 50 : 100 * (candles[i].close - ll) / (hh - ll);
  }
  const d = empty(candles.length);
  for (let i = kPeriod - 1 + dPeriod - 1; i < candles.length; i++) {
    let s = 0;
    for (let j = i - dPeriod + 1; j <= i; j++) s += k[j];
    d[i] = s / dPeriod;
  }
  return { k, d };
}
function adx(candles, period = 14) {
  assertPeriod(period);
  assertCandles(candles);
  const n = candles.length;
  const out = { adx: empty(n), plusDI: empty(n), minusDI: empty(n) };
  if (n <= period) return out;
  const tr = [0];
  const pdm = [0];
  const mdm = [0];
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const p = candles[i - 1];
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
    sTr += tr[i];
    sP += pdm[i];
    sM += mdm[i];
  }
  const dx = [];
  const setDI = (i) => {
    const pDI = sTr === 0 ? 0 : 100 * sP / sTr;
    const mDI = sTr === 0 ? 0 : 100 * sM / sTr;
    out.plusDI[i] = pDI;
    out.minusDI[i] = mDI;
    dx.push(pDI + mDI === 0 ? 0 : 100 * Math.abs(pDI - mDI) / (pDI + mDI));
  };
  setDI(period);
  for (let i = period + 1; i < n; i++) {
    sTr = sTr - sTr / period + tr[i];
    sP = sP - sP / period + pdm[i];
    sM = sM - sM / period + mdm[i];
    setDI(i);
  }
  if (dx.length >= period) {
    let a = 0;
    for (let j = 0; j < period; j++) a += dx[j];
    a /= period;
    out.adx[2 * period - 1] = a;
    for (let j = period; j < dx.length; j++) {
      a = (a * (period - 1) + dx[j]) / period;
      out.adx[period + j] = a;
    }
  }
  return out;
}

// src/core/candle-backtest.ts
function assertOpts(o) {
  if (!(o.slAtr > 0) || !Number.isFinite(o.slAtr)) throw new RangeError(`slAtr inv\xE1lido: ${o.slAtr}`);
  if (!(o.tpR > 0) || !Number.isFinite(o.tpR)) throw new RangeError(`tpR inv\xE1lido: ${o.tpR}`);
  if (!Number.isInteger(o.maxBars) || o.maxBars < 1) throw new RangeError(`maxBars inv\xE1lido: ${o.maxBars}`);
  if (!Number.isFinite(o.costFraction) || o.costFraction < 0) throw new RangeError(`costFraction inv\xE1lido: ${o.costFraction}`);
}
function expectancyPValue(rs) {
  const n = rs.length;
  if (n < 2) return null;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  if (sd === 0) return mean > 0 ? 0 : 1;
  const z = mean / (sd / Math.sqrt(n));
  const tail = 0.5 * gammaQ(0.5, z * z / 2);
  return z >= 0 ? tail : 1 - tail;
}
function summarizeR(rs) {
  const trades = rs.length;
  let wins = 0;
  let net = 0;
  let peak = 0;
  let dd = 0;
  let streak = 0;
  let longest = 0;
  let gw = 0;
  let gl = 0;
  for (const r of rs) {
    net += r;
    if (r > 0) {
      wins += 1;
      gw += r;
      streak = 0;
    } else {
      gl += -r;
      streak += 1;
      if (streak > longest) longest = streak;
    }
    if (net > peak) peak = net;
    if (peak - net > dd) dd = peak - net;
  }
  const mean = trades === 0 ? 0 : net / trades;
  const sd = trades < 2 ? 0 : Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (trades - 1));
  return {
    trades,
    wins,
    winRate: trades === 0 ? 0 : wins / trades,
    netR: net,
    meanR: mean,
    profitFactor: gl === 0 ? null : gw / gl,
    maxDrawdownR: dd,
    longestLosingStreak: longest,
    stdDevR: sd,
    pValue: trades < 2 ? null : expectancyPValue(rs)
  };
}
function prepareBacktest(candles, strategy, atrPeriod = 14) {
  return { signals: strategy.signals(candles), atrs: atr(candles, atrPeriod) };
}
function runCandleBacktest(candles, strategy, opts, prepared) {
  assertOpts(opts);
  const n = candles.length;
  const start = opts.start ?? 0;
  const end = opts.end ?? n;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > n || start > end) {
    throw new RangeError(`Intervalo inv\xE1lido: ${start}..${end}`);
  }
  const dirs = opts.directions ?? "both";
  const signals = prepared ? prepared.signals : strategy.signals(candles);
  if (signals.length !== n) throw new RangeError("A estrat\xE9gia devolveu um n\xFAmero errado de sinais");
  const atrs = prepared ? prepared.atrs : atr(candles, opts.atrPeriod ?? 14);
  if (atrs.length !== n) throw new RangeError("ATR com tamanho errado");
  const trades = [];
  let i = start;
  while (i < end - 1) {
    const sig = signals[i];
    const a = atrs[i];
    const allowed = sig === 1 ? dirs !== "short" : sig === -1 ? dirs !== "long" : false;
    if (!allowed || a === null || a === void 0 || !(a > 0)) {
      i += 1;
      continue;
    }
    const dir = sig;
    const entryIndex = i + 1;
    const entry = candles[entryIndex].open;
    const dist = opts.slAtr * a;
    const sl = entry - dir * dist;
    const tp = entry + dir * opts.tpR * dist;
    const cost = entry * opts.costFraction / dist;
    const last = Math.min(entryIndex + opts.maxBars, end - 1);
    let exitIndex = last;
    let exitPrice = candles[last].close;
    let reason = "time";
    for (let j = entryIndex; j <= last; j++) {
      const c = candles[j];
      if (j > entryIndex) {
        if (dir === 1 ? c.open <= sl : c.open >= sl) {
          exitIndex = j;
          exitPrice = c.open;
          reason = "sl";
          break;
        }
        if (dir === 1 ? c.open >= tp : c.open <= tp) {
          exitIndex = j;
          exitPrice = c.open;
          reason = "tp";
          break;
        }
      }
      const hitSl = dir === 1 ? c.low <= sl : c.high >= sl;
      const hitTp = dir === 1 ? c.high >= tp : c.low <= tp;
      if (hitSl) {
        exitIndex = j;
        exitPrice = sl;
        reason = "sl";
        break;
      }
      if (hitTp) {
        exitIndex = j;
        exitPrice = tp;
        reason = "tp";
        break;
      }
    }
    const r = dir * (exitPrice - entry) / dist - cost;
    trades.push({ entryIndex, exitIndex, direction: dir, entry, exit: exitPrice, r, reason });
    i = exitIndex;
    if (i <= entryIndex - 1) i = entryIndex;
  }
  return { trades, metrics: summarizeR(trades.map((t) => t.r)) };
}

// src/core/gate.ts
var GATE_ALPHA = 0.01;

// src/core/candle-gate.ts
function requiredOosForCandleMinLabel(minLabel = "PRELIMINARY") {
  if (minLabel === "EVIDENCE") return EVIDENCE_MIN_OBS;
  if (minLabel === "AGILE") return AGILE_MIN_OBS;
  return PRELIMINARY_MIN_OBS;
}
function candleLabelPermitted(label, minLabel) {
  if (minLabel === "EVIDENCE") return label === "EVIDENCE";
  if (minLabel === "PRELIMINARY") return label === "PRELIMINARY" || label === "EVIDENCE";
  return label === "AGILE" || label === "PRELIMINARY" || label === "EVIDENCE";
}

// src/core/gate-ledger.ts
var LEDGER_VERSION = 1;
var LEDGER_BLOCK_CANDLES = 500;
var LEDGER_WARMUP = 600;
var LEDGER_KEEP_FOLDS = 160;
function hashString(s) {
  let h1 = 3735928559;
  let h2 = 1103547991;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
  h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
function paramsHash(p) {
  const canon = JSON.stringify([
    LEDGER_VERSION,
    p.gran,
    p.blockCandles,
    p.trainSize,
    p.warmup,
    p.slAtr,
    p.tpR,
    p.maxBars,
    p.costFraction,
    p.atrPeriod,
    p.directions,
    p.minTrainTrades,
    p.strategies
  ]);
  return hashString(canon);
}
function makeLedgerParams(strategies, gate, gran, over = {}) {
  if (!Number.isInteger(gran) || gran < 1) throw new RangeError("gran inv\xE1lida");
  const blockCandles = over.blockCandles ?? LEDGER_BLOCK_CANDLES;
  const warmup = over.warmup ?? LEDGER_WARMUP;
  if (!Number.isInteger(blockCandles) || blockCandles < 1) throw new RangeError("blockCandles inv\xE1lido");
  if (!Number.isInteger(warmup) || warmup < 0) throw new RangeError("warmup inv\xE1lido");
  if (!Number.isInteger(gate.trainSize) || gate.trainSize < 1) throw new RangeError("trainSize inv\xE1lido");
  return {
    gran,
    blockCandles,
    trainSize: gate.trainSize,
    warmup,
    slAtr: gate.slAtr,
    tpR: gate.tpR,
    maxBars: gate.maxBars,
    costFraction: gate.costFraction,
    atrPeriod: gate.atrPeriod ?? 14,
    directions: gate.directions ?? "both",
    minTrainTrades: gate.minTrainTrades ?? 20,
    strategies: strategies.map((s) => s.name)
  };
}
function ledgerTailNeeded(p, blocks = 2) {
  return p.warmup + p.trainSize + p.blockCandles * blocks;
}
function blockSeconds(p) {
  return p.blockCandles * p.gran;
}
function lowerBound(candles, e) {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = lo + hi >>> 1;
    if (candles[mid].epoch < e) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function assertAscending(candles) {
  for (let i = 1; i < candles.length; i++) {
    if (!(candles[i].epoch > candles[i - 1].epoch)) throw new RangeError("velas fora de ordem ou duplicadas");
  }
}
function computeFold(candles, block, bi, be, p, strategies) {
  const T = p.trainSize;
  const W = p.warmup;
  const local = candles.slice(bi - T - W, be);
  const trainStart = W;
  const testStart = W + T;
  const bt = { slAtr: p.slAtr, tpR: p.tpR, maxBars: p.maxBars, costFraction: p.costFraction, atrPeriod: p.atrPeriod, directions: p.directions };
  const atrs = atr(local, p.atrPeriod);
  const prepared = strategies.map((s) => ({ s, prep: { signals: s.signals(local), atrs } }));
  let chosen = null;
  let chosenTrain = null;
  for (const x of prepared) {
    const m = runCandleBacktest(local, x.s, { ...bt, start: trainStart, end: testStart }, x.prep).metrics;
    if (m.trades < p.minTrainTrades) continue;
    if (chosenTrain === null || m.netR > chosenTrain.netR) {
      chosen = x;
      chosenTrain = m;
    }
  }
  const r = [];
  if (chosen !== null) {
    const res = runCandleBacktest(local, chosen.s, { ...bt, start: testStart, end: local.length }, chosen.prep);
    for (const t of res.trades) r.push(t.r);
  }
  let sumR = 0;
  let sumR2 = 0;
  let wins = 0;
  for (const x of r) {
    sumR += x;
    sumR2 += x * x;
    if (x > 0) wins += 1;
  }
  const bs = blockSeconds(p);
  return {
    block,
    start: block * bs,
    end: (block + 1) * bs,
    nCandles: be - bi,
    chosen: chosen?.s.name ?? null,
    trainTrades: chosenTrain?.trades ?? 0,
    trainNetR: chosenTrain?.netR ?? null,
    n: r.length,
    sumR,
    sumR2,
    wins,
    r
  };
}
function updateLedger(prev, candles, strategies, params, opts = {}) {
  if (strategies.length === 0) throw new RangeError("Sem estrat\xE9gias");
  if (strategies.length !== params.strategies.length || strategies.some((s, i) => s.name !== params.strategies[i])) {
    throw new RangeError("estrat\xE9gias n\xE3o correspondem aos par\xE2metros do livro");
  }
  assertAscending(candles);
  const hash = paramsHash(params);
  const valid = prev !== null && prev.version === LEDGER_VERSION && prev.paramsHash === hash;
  let folds = valid ? prev.folds.slice() : [];
  if (candles.length > 0) {
    const bs = blockSeconds(params);
    const first = candles[0].epoch;
    const lastEnd = candles[candles.length - 1].epoch + params.gran;
    const lastKnown = folds.length ? folds[folds.length - 1].block : Number.NEGATIVE_INFINITY;
    let b = Math.max(Math.floor(first / bs), Number.isFinite(lastKnown) ? lastKnown + 1 : Number.NEGATIVE_INFINITY);
    for (; (b + 1) * bs <= lastEnd; b++) {
      const bi = lowerBound(candles, b * bs);
      const be = lowerBound(candles, (b + 1) * bs);
      if (be - bi < 1) continue;
      if (bi - params.trainSize - params.warmup < 0) continue;
      folds.push(computeFold(candles, b, bi, be, params, strategies));
    }
  }
  const keep = opts.keepFolds ?? LEDGER_KEEP_FOLDS;
  if (folds.length > keep) folds = folds.slice(folds.length - keep);
  return { version: LEDGER_VERSION, paramsHash: hash, params, folds };
}
function computeLedger(candles, strategies, params, opts = {}) {
  return updateLedger(null, candles, strategies, params, opts);
}
function ledgerOos(ledger, lastFolds) {
  const folds = lastFolds !== void 0 ? ledger.folds.slice(-lastFolds) : ledger.folds;
  const rs = [];
  for (const f of folds) for (const x of f.r) rs.push(x);
  return summarizeR(rs);
}
var sgn = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
function evaluateLedgerGate(ledger, tail, strategies, gate) {
  const p = ledger.params;
  const alpha = gate.alpha ?? GATE_ALPHA;
  const minLabel = gate.minLabel ?? "PRELIMINARY";
  const f = ledger.folds;
  const withTrades = f.filter((x) => x.n > 0);
  const positive = withTrades.filter((x) => x.sumR > 0).length;
  const asOf = f.length ? f[f.length - 1].end : null;
  const depthDays = f.length ? (f[f.length - 1].end - f[0].start) / 86400 : 0;
  const meta = { folds: f.length, foldsPositive: positive, foldsWithTrades: withTrades.length, asOf, depthDays };
  const closedRes = (label2, reason, over = {}) => ({
    allowed: false,
    label: label2,
    reason,
    strategy: null,
    oosTrades: 0,
    meanR: 0,
    pValue: null,
    ...over,
    ...meta
  });
  const oos = ledgerOos(ledger);
  const needOos = requiredOosForCandleMinLabel(minLabel);
  if (oos.trades < needOos || oos.pValue === null) {
    return closedRes("INSUFFICIENT", `s\xF3 ${oos.trades} opera\xE7\xF5es fora da amostra (m\xEDnimo ${needOos})`, { oosTrades: oos.trades });
  }
  const base = { oosTrades: oos.trades, meanR: oos.meanR, pValue: oos.pValue };
  if (oos.pValue >= alpha || oos.meanR <= 0) {
    return closedRes("NO_EVIDENCE", `sem evid\xEAncia: m\xE9dia ${sgn(oos.meanR)}R por opera\xE7\xE3o em ${oos.trades} opera\xE7\xF5es (p = ${oos.pValue.toFixed(3)})`, base);
  }
  const label = classify(oos.trades, oos.pValue);
  if (!candleLabelPermitted(label, minLabel)) {
    return closedRes(label, `evid\xEAncia ${label} insuficiente para este modo (pede ${minLabel})`, base);
  }
  const need = p.trainSize + p.warmup;
  if (tail.length < need) return closedRes(label, `cauda curta (${tail.length} de ${need} velas) para escolher a estrat\xE9gia`, base);
  const local = tail.slice(tail.length - need);
  const bt = { slAtr: p.slAtr, tpR: p.tpR, maxBars: p.maxBars, costFraction: p.costFraction, atrPeriod: p.atrPeriod, directions: p.directions };
  let best = null;
  let bestNet = -Infinity;
  for (const s of strategies) {
    const prep = prepareBacktest(local, s, p.atrPeriod);
    const m = runCandleBacktest(local, s, { ...bt, start: p.warmup, end: local.length }, prep).metrics;
    if (m.trades < p.minTrainTrades) continue;
    if (m.netR > bestNet) {
      best = s;
      bestNet = m.netR;
    }
  }
  if (best === null) return closedRes(label, "nenhuma estrat\xE9gia serviu no treino recente", base);
  return {
    allowed: true,
    label,
    reason: `evid\xEAncia ${label}: m\xE9dia ${sgn(oos.meanR)}R em ${oos.trades} opera\xE7\xF5es (p = ${oos.pValue.toFixed(4)}); estrat\xE9gia ${best.name}`,
    strategy: best,
    ...base,
    ...meta
  };
}

// src/core/ledger-gate-controller.ts
var GATE_VERDICT_FOLDS = 100;
function ledgerAsOf(ledger, endSec, maxFolds = GATE_VERDICT_FOLDS) {
  const folds = ledger.folds.filter((f) => f.end <= endSec);
  return { ...ledger, folds: folds.length > maxFolds ? folds.slice(folds.length - maxFolds) : folds };
}

// src/core/strategies.ts
function closes(candles) {
  return candles.map((c) => c.close);
}
function crossedUp(a, b, i) {
  const a0 = a[i - 1];
  const b0 = b[i - 1];
  const a1 = a[i];
  const b1 = b[i];
  if (i < 1 || a0 == null || b0 == null || a1 == null || b1 == null) return false;
  return a0 <= b0 && a1 > b1;
}
function crossedDown(a, b, i) {
  const a0 = a[i - 1];
  const b0 = b[i - 1];
  const a1 = a[i];
  const b1 = b[i];
  if (i < 1 || a0 == null || b0 == null || a1 == null || b1 == null) return false;
  return a0 >= b0 && a1 < b1;
}
function build(n, f) {
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) out[i] = f(i);
  return out;
}
function level(v) {
  return v == null ? null : v;
}
function emaCross(opts) {
  if (!(opts.fast < opts.slow)) throw new RangeError("fast tem de ser menor que slow");
  return {
    name: `ema-cruza ${opts.fast}/${opts.slow}`,
    signals(candles) {
      const c = closes(candles);
      const f = ema(c, opts.fast);
      const s = ema(c, opts.slow);
      return build(c.length, (i) => crossedUp(f, s, i) ? 1 : crossedDown(f, s, i) ? -1 : 0);
    }
  };
}
function rsiReversion(opts) {
  if (!(opts.low < opts.high)) throw new RangeError("low tem de ser menor que high");
  return {
    name: `rsi-reversao ${opts.period} ${opts.low}/${opts.high}`,
    signals(candles) {
      const r = rsi(closes(candles), opts.period);
      return build(r.length, (i) => {
        const p = level(r[i - 1]);
        const x = level(r[i]);
        if (i < 1 || p === null || x === null) return 0;
        if (p < opts.low && x >= opts.low) return 1;
        if (p > opts.high && x <= opts.high) return -1;
        return 0;
      });
    }
  };
}
function macdCross(opts) {
  return {
    name: `macd-cruza ${opts.fast}/${opts.slow}/${opts.signal}`,
    signals(candles) {
      const m = macd(closes(candles), opts.fast, opts.slow, opts.signal);
      return build(candles.length, (i) => crossedUp(m.macd, m.signal, i) ? 1 : crossedDown(m.macd, m.signal, i) ? -1 : 0);
    }
  };
}
function bollingerReversion(opts) {
  return {
    name: `bollinger-reversao ${opts.period} k${opts.k}`,
    signals(candles) {
      const c = closes(candles);
      const b = bollinger(c, opts.period, opts.k);
      return build(c.length, (i) => {
        const lo0 = level(b.lower[i - 1]);
        const lo1 = level(b.lower[i]);
        const up0 = level(b.upper[i - 1]);
        const up1 = level(b.upper[i]);
        if (i < 1 || lo0 === null || lo1 === null || up0 === null || up1 === null) return 0;
        if (c[i - 1] < lo0 && c[i] >= lo1) return 1;
        if (c[i - 1] > up0 && c[i] <= up1) return -1;
        return 0;
      });
    }
  };
}
function bollingerBreakout(opts) {
  return {
    name: `bollinger-rompe ${opts.period} k${opts.k}`,
    signals(candles) {
      const c = closes(candles);
      const b = bollinger(c, opts.period, opts.k);
      return build(c.length, (i) => {
        const lo0 = level(b.lower[i - 1]);
        const lo1 = level(b.lower[i]);
        const up0 = level(b.upper[i - 1]);
        const up1 = level(b.upper[i]);
        if (i < 1 || lo0 === null || lo1 === null || up0 === null || up1 === null) return 0;
        if (c[i - 1] <= up0 && c[i] > up1) return 1;
        if (c[i - 1] >= lo0 && c[i] < lo1) return -1;
        return 0;
      });
    }
  };
}
function stochasticCross(opts) {
  return {
    name: `estocastico ${opts.k}/${opts.d} ${opts.low}/${opts.high}`,
    signals(candles) {
      const s = stochastic(candles, opts.k, opts.d);
      return build(candles.length, (i) => {
        const k0 = level(s.k[i - 1]);
        if (i < 1 || k0 === null) return 0;
        if (crossedUp(s.k, s.d, i) && k0 < opts.low) return 1;
        if (crossedDown(s.k, s.d, i) && k0 > opts.high) return -1;
        return 0;
      });
    }
  };
}
function adxTrend(opts) {
  return {
    name: `adx-tendencia ${opts.period} min${opts.minAdx}`,
    signals(candles) {
      const a = adx(candles, opts.period);
      return build(candles.length, (i) => {
        const v = level(a.adx[i]);
        if (v === null || v < opts.minAdx) return 0;
        return crossedUp(a.plusDI, a.minusDI, i) ? 1 : crossedDown(a.plusDI, a.minusDI, i) ? -1 : 0;
      });
    }
  };
}
function dailyTrendAtrBreakout(opts) {
  if (!Number.isInteger(opts.lookback) || opts.lookback < 2) {
    throw new RangeError(`lookback inv\xE1lido: ${opts.lookback}`);
  }
  if (!(opts.atrMult > 0)) throw new RangeError(`atrMult inv\xE1lido: ${opts.atrMult}`);
  const minAdx = opts.minAdx;
  return {
    name: `tend\xEAncia-di\xE1ria breakout-ATR ${opts.lookback}\xD7${opts.atrMult}` + (minAdx != null ? ` adx${minAdx}` : ""),
    signals(candles) {
      const a = atr(candles, opts.atrPeriod);
      const trend = minAdx != null ? adx(candles, 14) : null;
      return build(candles.length, (i) => {
        if (i < opts.lookback) return 0;
        const atrV = level(a[i]);
        if (atrV === null || atrV <= 0) return 0;
        if (trend && minAdx != null) {
          const adxV = level(trend.adx[i]);
          if (adxV === null || adxV < minAdx) return 0;
        }
        let hi = -Infinity;
        let lo = Infinity;
        for (let j = i - opts.lookback; j < i; j++) {
          const c = candles[j];
          if (c.high > hi) hi = c.high;
          if (c.low < lo) lo = c.low;
        }
        const close = candles[i].close;
        const pad = opts.atrMult * atrV;
        if (close > hi + pad) return 1;
        if (close < lo - pad) return -1;
        return 0;
      });
    }
  };
}
function confluence(opts) {
  if (opts.strategies.length < 2) throw new RangeError("Precisas de pelo menos 2 estrat\xE9gias");
  if (!Number.isInteger(opts.minAgree) || opts.minAgree < 2 || opts.minAgree > opts.strategies.length) {
    throw new RangeError(`minAgree inv\xE1lido: ${opts.minAgree}`);
  }
  if (!Number.isInteger(opts.hold) || opts.hold < 1) throw new RangeError(`hold inv\xE1lido: ${opts.hold}`);
  return {
    name: `confluencia(${opts.strategies.map((s) => s.name).join(" + ")}) >=${opts.minAgree} h${opts.hold}`,
    signals(candles) {
      const all = opts.strategies.map((s) => s.signals(candles));
      return build(candles.length, (i) => {
        let longs = 0;
        let shorts = 0;
        for (const sig of all) {
          for (let j = i; j > i - opts.hold && j >= 0; j--) {
            if (sig[j] !== 0) {
              if (sig[j] === 1) longs += 1;
              else shorts += 1;
              break;
            }
          }
        }
        if (longs >= opts.minAgree && shorts === 0) return 1;
        if (shorts >= opts.minAgree && longs === 0) return -1;
        return 0;
      });
    }
  };
}
function strategyLibrary() {
  const trend = [
    emaCross({ fast: 9, slow: 21 }),
    emaCross({ fast: 12, slow: 26 }),
    emaCross({ fast: 20, slow: 50 }),
    macdCross({ fast: 12, slow: 26, signal: 9 }),
    macdCross({ fast: 8, slow: 17, signal: 9 }),
    adxTrend({ period: 14, minAdx: 20 }),
    adxTrend({ period: 14, minAdx: 25 }),
    bollingerBreakout({ period: 20, k: 2 }),
    // Movimentos diários mais fortes (cripto): mesma porta de evidência.
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 0.5, minAdx: 20 }),
    dailyTrendAtrBreakout({ lookback: 48, atrPeriod: 14, atrMult: 0.75, minAdx: 25 })
  ];
  const reversion = [
    rsiReversion({ period: 14, low: 30, high: 70 }),
    rsiReversion({ period: 14, low: 25, high: 75 }),
    rsiReversion({ period: 7, low: 20, high: 80 }),
    bollingerReversion({ period: 20, k: 2 }),
    bollingerReversion({ period: 20, k: 2.5 }),
    stochasticCross({ k: 14, d: 3, low: 20, high: 80 })
  ];
  const combos = [
    confluence({ strategies: [emaCross({ fast: 12, slow: 26 }), adxTrend({ period: 14, minAdx: 25 })], minAgree: 2, hold: 3 }),
    confluence({ strategies: [macdCross({ fast: 12, slow: 26, signal: 9 }), adxTrend({ period: 14, minAdx: 20 })], minAgree: 2, hold: 3 }),
    confluence({
      strategies: [rsiReversion({ period: 14, low: 30, high: 70 }), bollingerReversion({ period: 20, k: 2 })],
      minAgree: 2,
      hold: 3
    }),
    confluence({
      strategies: [stochasticCross({ k: 14, d: 3, low: 20, high: 80 }), rsiReversion({ period: 14, low: 30, high: 70 })],
      minAgree: 2,
      hold: 3
    })
  ];
  return [...trend, ...reversion, ...combos];
}
function dailyTrendStrategySet() {
  return [
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 0.5, minAdx: 20 }),
    dailyTrendAtrBreakout({ lookback: 48, atrPeriod: 14, atrMult: 0.75, minAdx: 25 }),
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 1 })
  ];
}
function lucroRapidoStrategySet() {
  return [
    emaCross({ fast: 9, slow: 21 }),
    emaCross({ fast: 12, slow: 26 }),
    macdCross({ fast: 8, slow: 17, signal: 9 }),
    bollingerBreakout({ period: 20, k: 2 }),
    rsiReversion({ period: 7, low: 20, high: 80 }),
    stochasticCross({ k: 14, d: 3, low: 20, high: 80 }),
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 0.5, minAdx: 20 })
  ];
}
function lossZeroStrategySet() {
  return [
    confluence({
      strategies: [emaCross({ fast: 12, slow: 26 }), adxTrend({ period: 14, minAdx: 25 })],
      minAgree: 2,
      hold: 3
    }),
    confluence({
      strategies: [macdCross({ fast: 12, slow: 26, signal: 9 }), adxTrend({ period: 14, minAdx: 20 })],
      minAgree: 2,
      hold: 3
    }),
    confluence({
      strategies: [rsiReversion({ period: 14, low: 30, high: 70 }), bollingerReversion({ period: 20, k: 2 })],
      minAgree: 2,
      hold: 3
    }),
    confluence({
      strategies: [stochasticCross({ k: 14, d: 3, low: 20, high: 80 }), rsiReversion({ period: 14, low: 30, high: 70 })],
      minAgree: 2,
      hold: 3
    }),
    adxTrend({ period: 14, minAdx: 25 }),
    dailyTrendAtrBreakout({ lookback: 48, atrPeriod: 14, atrMult: 0.75, minAdx: 25 }),
    dailyTrendAtrBreakout({ lookback: 24, atrPeriod: 14, atrMult: 1 })
  ];
}
function blitzZeroStrategySet() {
  return [
    confluence({
      strategies: [emaCross({ fast: 12, slow: 26 }), adxTrend({ period: 14, minAdx: 25 })],
      minAgree: 2,
      hold: 2
    }),
    confluence({
      strategies: [macdCross({ fast: 12, slow: 26, signal: 9 }), adxTrend({ period: 14, minAdx: 20 })],
      minAgree: 2,
      hold: 2
    }),
    confluence({
      strategies: [rsiReversion({ period: 14, low: 30, high: 70 }), bollingerReversion({ period: 20, k: 2 })],
      minAgree: 2,
      hold: 2
    }),
    confluence({
      strategies: [stochasticCross({ k: 14, d: 3, low: 20, high: 80 }), rsiReversion({ period: 14, low: 30, high: 70 })],
      minAgree: 2,
      hold: 2
    }),
    // Twin ligeiramente mais rápido (EMA 9/21 + ADX 22) — ainda confluência minAgree 2.
    confluence({
      strategies: [emaCross({ fast: 9, slow: 21 }), adxTrend({ period: 14, minAdx: 22 })],
      minAgree: 2,
      hold: 2
    }),
    adxTrend({ period: 14, minAdx: 25 }),
    dailyTrendAtrBreakout({ lookback: 30, atrPeriod: 14, atrMult: 0.6, minAdx: 25 }),
    dailyTrendAtrBreakout({ lookback: 20, atrPeriod: 14, atrMult: 0.85 })
  ];
}
var STRATEGY_PRESETS = [
  {
    id: "lucro_rapido",
    label: "Lucro r\xE1pido",
    description: "Sinais mais curtos (EMA/MACD/RSI r\xE1pidos). Stake fixa \xB7 porta de evid\xEAncia \xB7 NO TRADE se falhar \xB7 sem martingale. N\xE3o garante lucro.",
    preferredGate: { tpR: 1.5, maxBars: 12, slAtr: 1.2, minLabel: "PRELIMINARY" },
    strategies: lucroRapidoStrategySet
  },
  {
    id: "loss_zero",
    label: "Loss zero",
    description: "Mais seletivo (conflu\xEAncia + ADX + tend\xEAncia di\xE1ria). Exige evid\xEAncia mais forte. N\xC3O promete zero perdas \u2014 NO TRADE se a porta falhar. Stake fixa, sem martingale.",
    preferredGate: { tpR: 2, maxBars: 24, slAtr: 1.5, minLabel: "EVIDENCE" },
    strategies: lossZeroStrategySet
  },
  {
    id: "blitz_zero",
    label: "Agressivo",
    description: "Modo \xE1gil 1m (futuros Linear USDT) da conflu\xEAncia Loss zero. Porta \xE1gil (10 OOS) \xB7 m\xE1x. 10 ops/sess\xE3o. Stake fixa \xB7 NO TRADE se falhar \xB7 sem martingale. N\xC3O garante lucro.",
    preferredGate: { tpR: 1.5, maxBars: 10, slAtr: 1.2, minLabel: "AGILE" },
    strategies: blitzZeroStrategySet
  },
  {
    id: "tendencia_diaria",
    label: "Tend\xEAncia di\xE1ria / breakout-ATR",
    description: "S\xF3 breakouts ATR de tend\xEAncia di\xE1ria. Ainda exige walk-forward e pode fechar em NO TRADE.",
    preferredGate: { tpR: 2, maxBars: 24, slAtr: 1.5, minLabel: "PRELIMINARY" },
    strategies: dailyTrendStrategySet
  },
  {
    id: "biblioteca",
    label: "Biblioteca completa",
    description: "Toda a biblioteca: a porta escolhe a que passa fora da amostra. Sem martingale \xB7 stake fixa \xB7 paper.",
    preferredGate: { tpR: 2, maxBars: 24, slAtr: 1.5, minLabel: "PRELIMINARY" },
    strategies: strategyLibrary
  }
];
function strategyPreset(id) {
  const found = STRATEGY_PRESETS.find((p) => p.id === id);
  return found ?? null;
}
function strategiesForPreset(id) {
  const p = strategyPreset(id);
  if (!p) throw new RangeError(`preset de estrat\xE9gia desconhecido: ${id}`);
  return p.strategies();
}

// src/core/feasible.ts
function assertOpts2(o) {
  if (!(o.slAtr > 0) || !Number.isFinite(o.slAtr)) throw new RangeError(`slAtr inv\xE1lido: ${o.slAtr}`);
  if (!(o.maxStopFraction > 0) || !Number.isFinite(o.maxStopFraction)) {
    throw new RangeError(`maxStopFraction inv\xE1lido: ${o.maxStopFraction}`);
  }
}
function feasible(strategy, opts) {
  assertOpts2(opts);
  return {
    name: strategy.name,
    signals(candles) {
      const raw = strategy.signals(candles);
      const a = atr(candles, opts.atrPeriod ?? 14);
      return raw.map((s, i) => {
        if (s === 0) return 0;
        const av = a[i];
        if (av === null || av === void 0) return 0;
        const stopFraction = opts.slAtr * av / candles[i].close;
        return stopFraction <= opts.maxStopFraction ? s : 0;
      });
    }
  };
}

// src/core/markets.ts
var MARKETS = {
  forex: { kind: "forex", label: "FOREX (pares de moedas)", alwaysOpen: false, assumedCostFraction: 1e-4 },
  metals: { kind: "metals", label: "METAIS (ouro, prata...)", alwaysOpen: false, assumedCostFraction: 2e-4 },
  crypto: { kind: "crypto", label: "CRIPTO", alwaysOpen: true, assumedCostFraction: 1e-3 }
};

// src/core/gate-service.ts
var GATE_PRESET_IDS = ["lucro_rapido", "loss_zero", "blitz_zero"];
var GATE_GRAN = 300;
var GATE_MIN_MULTIPLIER = 100;
var GATE_TRAIN = 1e3;
var GATE_BLOCK = 500;
var GATE_WARMUP = 600;
var GATE_KEEP_FOLDS = 120;
var GATE_TAIL_KEEP = 2700;
var GATE_COLD_DAYS = 90;
var GATE_STREAK_GAP_CANDLES = 12;
var GATE_CONFIRMATIONS = 2;
var GATE_MAX_WARM_GAP_CANDLES = 480;
var GATE_FRESH_MS = 15 * 60 * 1e3;
function gateCostFraction() {
  return MARKETS.crypto.assumedCostFraction;
}
function gateSetup(presetId, gran = GATE_GRAN, costFraction = gateCostFraction()) {
  const preset = strategyPreset(presetId);
  if (!preset) throw new RangeError(`preset desconhecido: ${presetId}`);
  const g = preset.preferredGate ?? {};
  const slAtr = g.slAtr || 1.5;
  const strategies = strategiesForPreset(presetId).map((s) => feasible(s, { slAtr, maxStopFraction: 1 / GATE_MIN_MULTIPLIER }));
  const params = makeLedgerParams(
    strategies,
    { slAtr, tpR: g.tpR || 2, maxBars: g.maxBars || 24, costFraction, trainSize: GATE_TRAIN },
    gran,
    { blockCandles: GATE_BLOCK, warmup: GATE_WARMUP }
  );
  return { presetId, strategies, params, minLabel: g.minLabel || "PRELIMINARY" };
}
function summarizeEntry(e) {
  const { ledgers: _l, tail: _t, ...rest } = e;
  void _l;
  void _t;
  return rest;
}
function candlesToTail(candles, keep = GATE_TAIL_KEEP) {
  return candles.slice(-keep).map((c) => [c.epoch, c.open, c.high, c.low, c.close]);
}
function tailToCandles(tail) {
  return tail.map((r) => ({ epoch: r[0], open: r[1], high: r[2], low: r[3], close: r[4] }));
}
function nextStreak(prev, allowed, lastEpoch, gran, minGapCandles = GATE_STREAK_GAP_CANDLES) {
  if (!allowed) return { streak: 0, streakAt: null };
  if (!prev || prev.streak < 1 || prev.streakAt === null) return { streak: 1, streakAt: lastEpoch };
  if (lastEpoch - prev.streakAt >= minGapCandles * gran) return { streak: prev.streak + 1, streakAt: lastEpoch };
  return { streak: prev.streak, streakAt: prev.streakAt };
}
function configInfo(setups) {
  const hashes = {};
  for (const s of setups) hashes[s.presetId] = paramsHash(s.params);
  return {
    gran: GATE_GRAN,
    minMultiplier: GATE_MIN_MULTIPLIER,
    costFraction: gateCostFraction(),
    trainSize: GATE_TRAIN,
    blockCandles: GATE_BLOCK,
    warmup: GATE_WARMUP,
    ledgerVersion: LEDGER_VERSION,
    hashes
  };
}
function computeGateEntry(prev, symbol, candles, nowMs, opts = {}) {
  if (candles.length === 0) throw new RangeError("sem velas");
  const ids = opts.presets ?? GATE_PRESET_IDS;
  const setups = ids.map((id) => gateSetup(id));
  const lastEpoch = candles[candles.length - 1].epoch;
  const tailForGate = candles.slice(-Math.max(GATE_TAIL_KEEP, ledgerTailNeeded(setups[0].params, 2)));
  const verdicts = {};
  const ledgers = {};
  for (const s of setups) {
    const prevLedger = prev && prev.symbol === symbol ? prev.ledgers[s.presetId] ?? null : null;
    const ledger = prevLedger ? updateLedger(prevLedger, candles, s.strategies, s.params, { keepFolds: GATE_KEEP_FOLDS }) : computeLedger(candles, s.strategies, s.params, { keepFolds: GATE_KEEP_FOLDS });
    ledgers[s.presetId] = ledger;
    const r = evaluateLedgerGate(ledgerAsOf(ledger, Number.POSITIVE_INFINITY, GATE_VERDICT_FOLDS), tailForGate, s.strategies, { minLabel: s.minLabel });
    const sameCfg = prevLedger !== null && prevLedger.paramsHash === ledger.paramsHash;
    const pv = sameCfg && prev ? prev.verdicts[s.presetId] ?? null : null;
    const st = nextStreak(pv ? { streak: pv.streak, streakAt: pv.streakAt } : null, r.allowed, lastEpoch, GATE_GRAN);
    verdicts[s.presetId] = {
      allowed: r.allowed,
      label: r.label,
      reason: r.reason,
      strategy: r.strategy ? r.strategy.name : null,
      nOOS: r.oosTrades,
      meanR: r.meanR,
      p: r.pValue,
      folds: r.folds,
      foldsPositive: r.foldsPositive,
      foldsWithTrades: r.foldsWithTrades,
      asOf: r.asOf,
      depthDays: Math.round(r.depthDays * 10) / 10,
      streak: st.streak,
      streakAt: st.streakAt,
      minLabel: s.minLabel,
      needOos: s.minLabel === "EVIDENCE" ? 1e3 : s.minLabel === "AGILE" ? 10 : 100
    };
  }
  return {
    v: 1,
    symbol,
    gran: GATE_GRAN,
    updatedAt: nowMs,
    lastEpoch,
    historyFrom: opts.historyFrom ?? prev?.historyFrom ?? candles[0].epoch,
    cfg: configInfo(setups),
    verdicts,
    ledgers,
    tail: candlesToTail(candles)
  };
}
function verdictIsOpen(v, confirmations = GATE_CONFIRMATIONS) {
  return v.allowed && v.streak >= confirmations;
}
function isFresh(s, nowMs, maxAgeMs = GATE_FRESH_MS) {
  return nowMs - s.updatedAt <= maxAgeMs;
}
export {
  GATE_BLOCK,
  GATE_COLD_DAYS,
  GATE_CONFIRMATIONS,
  GATE_FRESH_MS,
  GATE_GRAN,
  GATE_KEEP_FOLDS,
  GATE_MAX_WARM_GAP_CANDLES,
  GATE_MIN_MULTIPLIER,
  GATE_PRESET_IDS,
  GATE_STREAK_GAP_CANDLES,
  GATE_TAIL_KEEP,
  GATE_TRAIN,
  GATE_WARMUP,
  candlesToTail,
  computeGateEntry,
  configInfo,
  gateCostFraction,
  gateSetup,
  isFresh,
  nextStreak,
  summarizeEntry,
  tailToCandles,
  verdictIsOpen
};
