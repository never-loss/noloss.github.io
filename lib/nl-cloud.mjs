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

// src/core/paper.ts
var MIN_STAKE = 0.5;
var MAX_SESSION_MS = 12 * 60 * 60 * 1e3;

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
function runCandleBacktest(candles, strategy, opts) {
  assertOpts(opts);
  const n = candles.length;
  const start = opts.start ?? 0;
  const end = opts.end ?? n;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > n || start > end) {
    throw new RangeError(`Intervalo inv\xE1lido: ${start}..${end}`);
  }
  const dirs = opts.directions ?? "both";
  const signals = strategy.signals(candles);
  if (signals.length !== n) throw new RangeError("A estrat\xE9gia devolveu um n\xFAmero errado de sinais");
  const atrs = atr(candles, opts.atrPeriod ?? 14);
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
function walkForwardCandles(candles, strategies, opts) {
  if (strategies.length === 0) throw new RangeError("Sem estrat\xE9gias");
  if (!Number.isInteger(opts.trainSize) || opts.trainSize < 1) throw new RangeError("trainSize inv\xE1lido");
  if (!Number.isInteger(opts.testSize) || opts.testSize < 1) throw new RangeError("testSize inv\xE1lido");
  const minTrades = opts.minTrainTrades ?? 20;
  const { trainSize, testSize, minTrainTrades: _ignored, ...base } = opts;
  void _ignored;
  const folds = [];
  const oosR = [];
  let start = 0;
  let fold = 0;
  while (start + trainSize + testSize <= candles.length) {
    const testStart = start + trainSize;
    const testEnd = testStart + testSize;
    let chosen = null;
    let chosenTrain = null;
    for (const s of strategies) {
      const m = runCandleBacktest(candles, s, { ...base, start, end: testStart }).metrics;
      if (m.trades < minTrades) continue;
      if (chosenTrain === null || m.netR > chosenTrain.netR) {
        chosen = s;
        chosenTrain = m;
      }
    }
    let test = null;
    if (chosen !== null) {
      const r = runCandleBacktest(candles, chosen, { ...base, start: testStart, end: testEnd });
      oosR.push(...r.trades.map((t) => t.r));
      test = r.metrics;
    }
    folds.push({ fold, trainStart: start, testStart, testEnd, chosen: chosen?.name ?? null, train: chosenTrain, test });
    fold += 1;
    start += testSize;
  }
  return { folds, oosR, oos: summarizeR(oosR) };
}

// src/core/candle-paper.ts
var ALLOWED_KEYS = /* @__PURE__ */ new Set([
  "strategy",
  "stake",
  "slAtr",
  "tpR",
  "maxBars",
  "costFraction",
  "atrPeriod",
  "directions",
  "maxBuffer",
  "maxLoss",
  "maxTrades",
  "maxDurationMs",
  "maxConsecutiveLosses",
  "cooldownCandles"
]);
function positive(v, label) {
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${label} inv\xE1lido: ${v}`);
}
function positiveInt(v, label) {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${label} inv\xE1lido: ${v}`);
}
function validate(cfg) {
  for (const key of Object.keys(cfg)) {
    if (!ALLOWED_KEYS.has(key)) throw new RangeError(`Op\xE7\xE3o n\xE3o permitida: ${key}`);
  }
  if (!cfg.strategy || typeof cfg.strategy.signals !== "function") throw new RangeError("Estrat\xE9gia em falta");
  if (!Number.isFinite(cfg.stake) || cfg.stake < MIN_STAKE) throw new RangeError(`Stake m\xEDnima \xE9 ${MIN_STAKE}`);
  positive(cfg.slAtr, "slAtr");
  positive(cfg.tpR, "tpR");
  positiveInt(cfg.maxBars, "maxBars");
  if (!Number.isFinite(cfg.costFraction) || cfg.costFraction < 0) throw new RangeError(`costFraction inv\xE1lido: ${cfg.costFraction}`);
  positive(cfg.maxLoss, "maxLoss");
  if (cfg.maxLoss < cfg.stake) throw new RangeError("maxLoss tem de ser pelo menos uma stake");
  positiveInt(cfg.maxTrades, "maxTrades");
  positive(cfg.maxDurationMs, "maxDurationMs");
  if (cfg.maxDurationMs > MAX_SESSION_MS) throw new RangeError("Dura\xE7\xE3o m\xE1xima \xE9 12 horas");
  positiveInt(cfg.maxConsecutiveLosses, "maxConsecutiveLosses");
  if (!Number.isInteger(cfg.cooldownCandles) || cfg.cooldownCandles < 0) throw new RangeError(`cooldownCandles inv\xE1lido: ${cfg.cooldownCandles}`);
  if (cfg.maxBuffer !== void 0) positiveInt(cfg.maxBuffer, "maxBuffer");
}
var CandlePaperSession = class {
  #cfg;
  #status = "STOPPED";
  #stopReason = null;
  #startedAt = null;
  #buffer = [];
  #pending = null;
  #position = null;
  #rs = [];
  #opened = 0;
  #pnl = 0;
  #peak = 0;
  #maxDrawdown = 0;
  #consecutiveLosses = 0;
  #cooldown = 0;
  constructor(cfg) {
    validate(cfg);
    this.#cfg = Object.freeze({ ...cfg });
  }
  get status() {
    return this.#status;
  }
  /** Epoch ms do arranque da sessão (null se ainda não arrancou). */
  get startedAtMs() {
    return this.#startedAt;
  }
  get stopReason() {
    return this.#stopReason;
  }
  get totalPnl() {
    return this.#pnl;
  }
  get hasOpenPosition() {
    return this.#position !== null;
  }
  /** PLAY: liga a análise. Não força nenhuma operação. */
  start(nowMs) {
    if (this.#status === "RUNNING") return [];
    if (this.#status === "STOPPED" && this.#startedAt !== null) throw new Error("Sess\xE3o terminada: cria uma nova sess\xE3o");
    if (this.#startedAt === null) this.#startedAt = nowMs;
    this.#status = "RUNNING";
    return [{ type: "started", at: nowMs }];
  }
  /** PAUSE: bloqueia novas entradas. Uma operação aberta continua até sair. */
  pause(nowMs) {
    if (this.#status !== "RUNNING") return [];
    this.#status = "PAUSED";
    return [{ type: "paused", at: nowMs }];
  }
  /** STOP: termina a sessão. Uma operação aberta continua até sair. */
  stop(nowMs) {
    if (this.#status === "STOPPED") return [];
    return [this.#doStop(nowMs, "manual")];
  }
  #doStop(nowMs, reason) {
    this.#status = "STOPPED";
    this.#stopReason = reason;
    this.#pending = null;
    return { type: "stopped", at: nowMs, reason };
  }
  /** Recebe cada vela FECHADA, por ordem. Devolve os eventos que aconteceram. */
  onCandle(c) {
    if (![c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite) || c.high < c.low) {
      throw new RangeError("Vela inv\xE1lida");
    }
    if (this.#startedAt === null) return [];
    const now = c.epoch * 1e3;
    const events = [];
    const cfg = this.#cfg;
    this.#buffer.push(c);
    const maxBuffer = cfg.maxBuffer ?? 1500;
    if (this.#buffer.length > maxBuffer) this.#buffer.splice(0, this.#buffer.length - maxBuffer);
    let entryCandle = false;
    if (this.#pending !== null) {
      const p = this.#pending;
      this.#pending = null;
      if (this.#status === "RUNNING" && this.#position === null) {
        const entry = c.open;
        const dist = cfg.slAtr * p.atr;
        this.#position = {
          dir: p.dir,
          entry,
          sl: entry - p.dir * dist,
          tp: entry + p.dir * cfg.tpR * dist,
          dist,
          cost: entry * cfg.costFraction / dist,
          barsHeld: 0
        };
        this.#opened += 1;
        entryCandle = true;
        events.push({
          type: "trade_opened",
          at: now,
          direction: p.dir,
          entry,
          stopLoss: this.#position.sl,
          takeProfit: this.#position.tp,
          strategy: cfg.strategy.name
        });
      }
    }
    if (this.#position !== null) {
      const pos = this.#position;
      if (!entryCandle) pos.barsHeld += 1;
      let exit = null;
      let reason = "time";
      if (!entryCandle) {
        if (pos.dir === 1 ? c.open <= pos.sl : c.open >= pos.sl) {
          exit = c.open;
          reason = "sl";
        } else if (pos.dir === 1 ? c.open >= pos.tp : c.open <= pos.tp) {
          exit = c.open;
          reason = "tp";
        }
      }
      if (exit === null) {
        const hitSl = pos.dir === 1 ? c.low <= pos.sl : c.high >= pos.sl;
        const hitTp = pos.dir === 1 ? c.high >= pos.tp : c.low <= pos.tp;
        if (hitSl) {
          exit = pos.sl;
          reason = "sl";
        } else if (hitTp) {
          exit = pos.tp;
          reason = "tp";
        } else if (pos.barsHeld >= cfg.maxBars) {
          exit = c.close;
          reason = "time";
        }
      }
      if (exit !== null) {
        const r = pos.dir * (exit - pos.entry) / pos.dist - pos.cost;
        const pnl = r * cfg.stake;
        this.#position = null;
        this.#rs.push(r);
        this.#pnl += pnl;
        if (r > 0) {
          this.#consecutiveLosses = 0;
        } else {
          this.#consecutiveLosses += 1;
          this.#cooldown = cfg.cooldownCandles;
        }
        if (this.#pnl > this.#peak) this.#peak = this.#pnl;
        if (this.#peak - this.#pnl > this.#maxDrawdown) this.#maxDrawdown = this.#peak - this.#pnl;
        events.push({ type: "trade_closed", at: now, direction: pos.dir, entry: pos.entry, exit, reason, r, pnl, totalPnl: this.#pnl });
        if (this.#status !== "STOPPED") {
          const why = this.#limitReached();
          if (why !== null) events.push(this.#doStop(now, why));
        }
      }
    }
    if (this.#status !== "RUNNING" || this.#position !== null) return events;
    if (now - this.#startedAt >= cfg.maxDurationMs) {
      events.push(this.#doStop(now, "max_duration"));
      return events;
    }
    if (this.#cooldown > 0) {
      this.#cooldown -= 1;
      return events;
    }
    if (this.#opened >= cfg.maxTrades) return events;
    const sigs = cfg.strategy.signals(this.#buffer);
    const last = this.#buffer.length - 1;
    const sig = sigs[last];
    const dirs = cfg.directions ?? "both";
    const allowed = sig === 1 ? dirs !== "short" : sig === -1 ? dirs !== "long" : false;
    if (!allowed) return events;
    const a = atr(this.#buffer, cfg.atrPeriod ?? 14)[last];
    if (a === null || a === void 0 || !(a > 0)) return events;
    this.#pending = { dir: sig, atr: a };
    return events;
  }
  #limitReached() {
    const c = this.#cfg;
    if (this.#pnl <= -c.maxLoss) return "max_loss";
    if (this.#consecutiveLosses >= c.maxConsecutiveLosses) return "max_consecutive_losses";
    if (this.#rs.length >= c.maxTrades) return "max_trades";
    return null;
  }
  summary() {
    return {
      status: this.#status,
      stopReason: this.#stopReason,
      stake: this.#cfg.stake,
      maxTrades: this.#cfg.maxTrades,
      opened: this.#opened,
      closed: this.#rs.length,
      hasOpenPosition: this.#position !== null,
      totalPnl: this.#pnl,
      maxDrawdown: this.#maxDrawdown,
      metrics: summarizeR(this.#rs)
    };
  }
};

// src/core/gate.ts
var GATE_ALPHA = 0.01;

// src/core/candle-gate.ts
function closed(label, reason, over = {}) {
  return { allowed: false, label, reason, strategy: null, oosTrades: 0, meanR: 0, pValue: null, ...over };
}
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
var sgn = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
function evaluateCandleGate(candles, strategies, opts) {
  if (strategies.length === 0) throw new RangeError("Sem estrat\xE9gias");
  const alpha = opts.alpha ?? GATE_ALPHA;
  const minLabel = opts.minLabel ?? "PRELIMINARY";
  const need = opts.trainSize + opts.testSize;
  if (candles.length < need) {
    return closed("INSUFFICIENT", `poucas velas (${candles.length} de ${need} necess\xE1rias)`);
  }
  const { trainSize, testSize, minLabel: _a, alpha: _b, minTrainTrades, ...bt } = opts;
  void _a;
  void _b;
  const wf = walkForwardCandles(candles, strategies, { ...bt, trainSize, testSize, ...minTrainTrades !== void 0 ? { minTrainTrades } : {} });
  const oos = wf.oos;
  const needOos = requiredOosForCandleMinLabel(minLabel);
  if (oos.trades < needOos || oos.pValue === null) {
    return closed("INSUFFICIENT", `s\xF3 ${oos.trades} opera\xE7\xF5es fora da amostra (m\xEDnimo ${needOos})`, { oosTrades: oos.trades });
  }
  const base = { oosTrades: oos.trades, meanR: oos.meanR, pValue: oos.pValue };
  if (oos.pValue >= alpha || oos.meanR <= 0) {
    return closed("NO_EVIDENCE", `sem evid\xEAncia: m\xE9dia ${sgn(oos.meanR)}R por opera\xE7\xE3o em ${oos.trades} opera\xE7\xF5es (p = ${oos.pValue.toFixed(3)})`, base);
  }
  const label = classify(oos.trades, oos.pValue);
  if (!candleLabelPermitted(label, minLabel)) {
    return closed(label, `evid\xEAncia ${label} insuficiente para este modo (pede ${minLabel})`, base);
  }
  const start = Math.max(0, candles.length - trainSize);
  let best = null;
  let bestNet = -Infinity;
  for (const s of strategies) {
    const m = runCandleBacktest(candles, s, { ...bt, start, end: candles.length }).metrics;
    if (m.trades < (minTrainTrades ?? 20)) continue;
    if (m.netR > bestNet) {
      best = s;
      bestNet = m.netR;
    }
  }
  if (best === null) return closed(label, "nenhuma estrat\xE9gia serviu no treino recente", base);
  return {
    allowed: true,
    label,
    reason: `evid\xEAncia ${label}: m\xE9dia ${sgn(oos.meanR)}R em ${oos.trades} opera\xE7\xF5es (p = ${oos.pValue.toFixed(4)}); estrat\xE9gia ${best.name}`,
    strategy: best,
    ...base
  };
}
var CandleGateController = class {
  #opts;
  #buffer;
  #since = 0;
  #streak = 0;
  #open = false;
  #result;
  constructor(opts) {
    if (!Number.isInteger(opts.revalidateEvery) || opts.revalidateEvery < 1) {
      throw new RangeError(`revalidateEvery inv\xE1lido: ${opts.revalidateEvery}`);
    }
    this.#opts = opts;
    this.#buffer = [...opts.initial ?? []];
    this.#trim();
    this.#result = closed("INSUFFICIENT", "a aguardar a primeira valida\xE7\xE3o");
    this.#check();
  }
  get result() {
    return this.#result;
  }
  get isOpen() {
    return this.#open;
  }
  get candles() {
    return this.#buffer.length;
  }
  #trim() {
    const max = this.#opts.maxBuffer ?? 3e3;
    if (this.#buffer.length > max) this.#buffer.splice(0, this.#buffer.length - max);
  }
  #check() {
    const before = this.#open;
    const res = evaluateCandleGate(this.#buffer, this.#opts.strategies, this.#opts.gate);
    this.#result = res;
    this.#streak = res.allowed ? this.#streak + 1 : 0;
    this.#open = res.allowed && this.#streak >= (this.#opts.confirmations ?? 2);
    this.#since = 0;
    return before !== this.#open;
  }
  /** Recebe uma vela fechada nova. Devolve true se a porta abriu ou fechou. */
  push(c) {
    this.#buffer.push(c);
    this.#trim();
    this.#since += 1;
    return this.#since >= this.#opts.revalidateEvery ? this.#check() : false;
  }
  /** Estratégia para a sessão: só dá sinais quando a porta está aberta. */
  asStrategy() {
    return {
      name: "porta-de-evidencia",
      signals: (candles) => {
        const zeros = () => new Array(candles.length).fill(0);
        if (!this.#open || this.#result.strategy === null) return zeros();
        return this.#result.strategy.signals(candles);
      }
    };
  }
};

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
function marketOf(symbol) {
  if (/^cry[A-Z0-9]+USD$/.test(symbol)) return "crypto";
  if (/^[A-Z0-9]{2,20}USDT$/.test(symbol)) return "crypto";
  if (/^frx(XAU|XAG|XPD|XPT)[A-Z]{3}$/.test(symbol)) return "metals";
  if (/^frx[A-Z]{6}$/.test(symbol)) return "forex";
  return null;
}

// src/core/cloud-arm.ts
var CLOUD_ARM_MODE = "PAPER";
var CLOUD_ARM_WARMUP = 1500;
var CLOUD_ARM_MAX_EVENTS = 80;
var CLOUD_ARM_REVALIDATE_EVERY = 12;
var CLOUD_ARM_MIN_MULTIPLIER = 100;
var CLOUD_ARM_MAX_MIRROR_KEYS = 40;
var CLOUD_ARM_MAX_DURATION_MINUTES = 720;
var CLOUD_ARM_TZ = "Africa/Luanda";
var CLOUD_ARM_WINDOW_START_HOUR = 8;
var CLOUD_ARM_WINDOW_END_HOUR = 20;
var PRESET_IDS = /* @__PURE__ */ new Set(["lucro_rapido", "loss_zero", "blitz_zero", "tendencia_diaria", "biblioteca"]);
function positiveInt2(v, label) {
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${label} inv\xE1lido`);
}
function parseMode(raw) {
  const m = String(raw == null || raw === "" ? CLOUD_ARM_MODE : raw).trim().toUpperCase();
  if (m === "PAPER" || m === "REAL") return m;
  throw new RangeError("mode inv\xE1lido (PAPER|REAL)");
}
function validateCloudArmCreate(input) {
  const symbol = String(input.symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new RangeError("s\xEDmbolo inv\xE1lido (s\xF3 Linear USDT)");
  const strategyPreset2 = String(input.strategyPreset || "").trim();
  if (!PRESET_IDS.has(strategyPreset2)) throw new RangeError("estrat\xE9gia inv\xE1lida");
  const stake = Number(input.stake);
  if (!Number.isFinite(stake) || stake < MIN_STAKE) throw new RangeError(`stake m\xEDnima ${MIN_STAKE}`);
  const leverage = Number(input.leverage);
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 100) throw new RangeError("alavancagem inv\xE1lida");
  const granularity = Number(input.granularity);
  if (![60, 300, 900, 3600].includes(granularity)) throw new RangeError("intervalo de vela inv\xE1lido");
  const durationMinutes = Math.floor(Number(input.durationMinutes));
  positiveInt2(durationMinutes, "dura\xE7\xE3o");
  if (durationMinutes > CLOUD_ARM_MAX_DURATION_MINUTES) {
    throw new RangeError(`dura\xE7\xE3o m\xE1xima \xE9 ${CLOUD_ARM_MAX_DURATION_MINUTES} minutos (12 h)`);
  }
  const durationMs = durationMinutes * 60 * 1e3;
  if (durationMs > MAX_SESSION_MS) throw new RangeError("dura\xE7\xE3o m\xE1xima \xE9 12 horas");
  const clientId = String(input.clientId || "").trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(clientId)) throw new RangeError("clientId inv\xE1lido");
  const mode = parseMode(input.mode);
  return {
    symbol,
    strategyPreset: strategyPreset2,
    stake,
    leverage,
    granularity,
    durationMs,
    clientId,
    mode
  };
}
function newCloudArmId(nowMs = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 10);
  return `arm_${nowMs.toString(36)}_${rand}`;
}
function createCloudArmJob(input, nowMs = Date.now()) {
  const v = validateCloudArmCreate(input);
  return {
    id: newCloudArmId(nowMs),
    clientId: v.clientId,
    symbol: v.symbol,
    strategyPreset: v.strategyPreset,
    stake: v.stake,
    leverage: v.leverage,
    granularity: v.granularity,
    durationMs: v.durationMs,
    mode: v.mode,
    status: "RUNNING",
    stopReason: null,
    createdAt: nowMs,
    startedAt: nowMs,
    endsAt: nowMs + v.durationMs,
    updatedAt: nowMs,
    lastTickAt: null,
    events: [],
    summary: {
      status: "RUNNING",
      stopReason: null,
      maxTrades: v.strategyPreset === "blitz_zero" ? 10 : 50,
      opened: 0,
      closed: 0,
      hasOpenPosition: false,
      totalPnl: 0,
      maxDrawdown: 0
    },
    gate: null,
    realOpenQty: null,
    realOpenSide: null,
    realAppliedEventKeys: [],
    needsRealFlatten: false
  };
}
function costFractionFor(symbol) {
  const kind = marketOf(symbol);
  return kind && MARKETS[kind] ? MARKETS[kind].assumedCostFraction : 1e-3;
}
function gateOptsFor(presetId, costFraction, trainSize, testSize) {
  const preset = strategyPreset(presetId);
  const g = preset && preset.preferredGate || {};
  return {
    slAtr: g.slAtr || 1.5,
    tpR: g.tpR || 2,
    maxBars: g.maxBars || 24,
    costFraction,
    trainSize,
    testSize,
    minLabel: g.minLabel || "PRELIMINARY"
  };
}
function strategiesFor(presetId) {
  const raw = strategiesForPreset(presetId);
  const preset = strategyPreset(presetId);
  const slAtr = preset && preset.preferredGate && preset.preferredGate.slAtr || 1.5;
  return raw.map((s) => feasible(s, { slAtr, maxStopFraction: 1 / CLOUD_ARM_MIN_MULTIPLIER }));
}
function snapGate(res, open) {
  return {
    allowed: open && res.allowed,
    label: res.label,
    reason: res.reason,
    strategyName: res.strategy ? res.strategy.name : null,
    oosTrades: res.oosTrades,
    meanR: res.meanR
  };
}
function snapSummary(s) {
  return {
    status: s.status,
    stopReason: s.stopReason,
    maxTrades: s.maxTrades,
    opened: s.opened,
    closed: s.closed,
    hasOpenPosition: s.hasOpenPosition,
    totalPnl: s.totalPnl,
    maxDrawdown: s.maxDrawdown
  };
}
function eventText(ev, mode) {
  switch (ev.type) {
    case "started":
      return `PLAY sess\xE3o (nuvem ${mode})`;
    case "paused":
      return "PAUSE";
    case "stopped":
      return `STOP ${ev.reason}`;
    case "trade_opened":
      return `ABRE ${ev.direction === 1 ? "COMPRA" : "VENDA"} @ ${ev.entry}`;
    case "trade_closed":
      return `FECHA ${ev.reason} ${ev.r >= 0 ? "+" : ""}${ev.r.toFixed(2)}R pnl=${ev.pnl.toFixed(2)}`;
    default:
      return String(ev.type);
  }
}
function snapEvent(ev, mode) {
  const base = { type: ev.type, at: ev.at, text: eventText(ev, mode) };
  if (ev.type === "trade_opened") {
    base.direction = ev.direction;
    base.entry = ev.entry;
  }
  if (ev.type === "trade_closed") {
    base.direction = ev.direction;
    base.r = ev.r;
    base.pnl = ev.pnl;
    base.entry = ev.entry;
  }
  return base;
}
function cloudArmEventKey(ev) {
  const dir = ev.direction != null ? String(ev.direction) : "";
  const r = ev.r != null && Number.isFinite(ev.r) ? String(ev.r) : "";
  return `${ev.type}:${ev.at}:${dir}:${r}`;
}
function pendingRealMirrors(jobBefore, jobAfter) {
  if (jobAfter.mode !== "REAL") return [];
  const applied = new Set(jobAfter.realAppliedEventKeys || jobBefore.realAppliedEventKeys || []);
  const out = [];
  for (const ev of jobAfter.events) {
    if (ev.type !== "trade_opened" && ev.type !== "trade_closed") continue;
    const key = cloudArmEventKey(ev);
    if (applied.has(key)) continue;
    if (ev.type === "trade_opened") {
      const side = ev.direction === 1 ? "BUY" : "SELL";
      out.push({
        action: "open",
        side,
        key,
        entry: ev.entry,
        // Paper session only opens when gate was open; trust historical open.
        evidenceAllowed: true
      });
    } else {
      const openSide = ev.direction === 1 ? "BUY" : "SELL";
      const closeSide = openSide === "BUY" ? "SELL" : "BUY";
      out.push({
        action: "close",
        side: closeSide,
        key,
        entry: ev.entry,
        evidenceAllowed: true
      });
    }
  }
  return out;
}
function markRealMirrorsApplied(job, keys, position) {
  const prev = job.realAppliedEventKeys || [];
  const merged = [...prev];
  for (const k of keys) {
    if (!merged.includes(k)) merged.push(k);
  }
  const capped = merged.length > CLOUD_ARM_MAX_MIRROR_KEYS ? merged.slice(-CLOUD_ARM_MAX_MIRROR_KEYS) : merged;
  return {
    ...job,
    realAppliedEventKeys: capped,
    realOpenQty: position ? position.qty : job.realOpenQty,
    realOpenSide: position ? position.side : job.realOpenSide
  };
}
function closedCandlesOnly(candles, granularity, nowMs) {
  const nowSec = nowMs / 1e3;
  return candles.filter((c) => c.epoch + granularity <= nowSec);
}
function advanceCloudArmJob(job, candlesAsc, nowMs = Date.now()) {
  if (job.mode !== "PAPER" && job.mode !== "REAL") {
    throw new Error("cloud arm mode must be PAPER or REAL");
  }
  if (job.status === "CANCELLED") {
    return { ...job, updatedAt: nowMs, lastTickAt: nowMs };
  }
  const closed2 = closedCandlesOnly(candlesAsc, job.granularity, nowMs).slice().sort((a, b) => a.epoch - b.epoch);
  const warmup = closed2.filter((c) => c.epoch * 1e3 < job.startedAt);
  const live = closed2.filter((c) => c.epoch * 1e3 >= job.startedAt);
  const costFraction = costFractionFor(job.symbol);
  const n = Math.max(warmup.length, 100);
  const trainSize = Math.min(1e3, Math.floor(n * 0.4));
  const testSize = Math.min(500, Math.floor(n * 0.2));
  const strategies = strategiesFor(job.strategyPreset);
  const gate = gateOptsFor(job.strategyPreset, costFraction, Math.max(50, trainSize), Math.max(30, testSize));
  const controller = new CandleGateController({
    strategies,
    gate,
    revalidateEvery: CLOUD_ARM_REVALIDATE_EVERY,
    maxBuffer: CLOUD_ARM_WARMUP,
    initial: warmup.slice(-CLOUD_ARM_WARMUP)
  });
  const maxTrades = job.strategyPreset === "blitz_zero" ? 10 : 50;
  const session = new CandlePaperSession({
    strategy: controller.asStrategy(),
    stake: job.stake,
    slAtr: gate.slAtr,
    tpR: gate.tpR,
    maxBars: gate.maxBars,
    costFraction,
    maxLoss: job.stake * 10,
    maxTrades,
    maxDurationMs: job.durationMs,
    maxConsecutiveLosses: 6,
    cooldownCandles: 0
  });
  const events = [];
  for (const ev of session.start(job.startedAt)) events.push(snapEvent(ev, job.mode));
  for (const c of live) {
    controller.push(c);
    for (const ev of session.onCandle(c)) events.push(snapEvent(ev, job.mode));
  }
  let forcedMaxDuration = false;
  if (nowMs >= job.endsAt && session.status === "RUNNING") {
    forcedMaxDuration = true;
    for (const ev of session.stop(nowMs)) {
      const snap = snapEvent(ev, job.mode);
      if (ev.type === "stopped") {
        events.push({ ...snap, text: "STOP max_duration", type: "stopped" });
      } else {
        events.push(snap);
      }
    }
  }
  const summary = snapSummary(session.summary());
  let status = job.status === "CANCELLED" ? "CANCELLED" : "RUNNING";
  let stopReason = job.stopReason;
  if (summary.status === "STOPPED") {
    status = "STOPPED";
    stopReason = forcedMaxDuration ? "max_duration" : summary.stopReason;
  } else if (nowMs >= job.endsAt && !summary.hasOpenPosition) {
    status = "STOPPED";
    stopReason = stopReason || "max_duration";
  }
  const capped = events.length > CLOUD_ARM_MAX_EVENTS ? events.slice(-CLOUD_ARM_MAX_EVENTS) : events;
  const summaryOut = {
    ...summary,
    status: status === "RUNNING" ? summary.status : "STOPPED",
    stopReason: status === "RUNNING" ? summary.stopReason : stopReason
  };
  return {
    ...job,
    status,
    stopReason,
    updatedAt: nowMs,
    lastTickAt: nowMs,
    events: capped,
    summary: summaryOut,
    gate: snapGate(controller.result, controller.isOpen),
    // Preserve REAL mirror state across deterministic rebuilds
    realOpenQty: job.realOpenQty ?? null,
    realOpenSide: job.realOpenSide ?? null,
    realAppliedEventKeys: job.realAppliedEventKeys ? [...job.realAppliedEventKeys] : [],
    needsRealFlatten: job.needsRealFlatten === true
  };
}
function cancelCloudArmJob(job, nowMs = Date.now()) {
  if (job.status !== "RUNNING") {
    return { ...job, updatedAt: nowMs };
  }
  const hadRealOpen = job.mode === "REAL" && !!(job.realOpenQty && job.realOpenSide);
  return {
    ...job,
    status: "CANCELLED",
    stopReason: "manual",
    updatedAt: nowMs,
    lastTickAt: nowMs,
    needsRealFlatten: hadRealOpen || job.needsRealFlatten === true,
    summary: {
      ...job.summary,
      status: "STOPPED",
      stopReason: "manual"
    },
    events: [
      ...job.events,
      { type: "stopped", at: nowMs, text: "STOP manual (nuvem)" }
    ].slice(-CLOUD_ARM_MAX_EVENTS)
  };
}
function luandaDateParts(nowMs, tz = CLOUD_ARM_TZ) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = fmt.formatToParts(new Date(nowMs));
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) {
    throw new Error("luandaDateParts_failed");
  }
  const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, hour, minute, dateKey };
}
function isInTradingWindow(nowMs, startHour = CLOUD_ARM_WINDOW_START_HOUR, endHour = CLOUD_ARM_WINDOW_END_HOUR, tz = CLOUD_ARM_TZ) {
  const { hour } = luandaDateParts(nowMs, tz);
  return hour >= startHour && hour < endHour;
}
function tzOffsetMs(nowMs, tz = CLOUD_ARM_TZ) {
  const d = new Date(nowMs);
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(d.toLocaleString("en-US", { timeZone: tz }));
  return local.getTime() - utc.getTime();
}
function windowEndMs(nowMs, endHour = CLOUD_ARM_WINDOW_END_HOUR, tz = CLOUD_ARM_TZ) {
  const p = luandaDateParts(nowMs, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, endHour, 0, 0, 0);
  return asIfUtc - tzOffsetMs(nowMs, tz);
}
function durationMinutesUntilWindowEnd(nowMs, startHour = CLOUD_ARM_WINDOW_START_HOUR, endHour = CLOUD_ARM_WINDOW_END_HOUR, tz = CLOUD_ARM_TZ) {
  if (!isInTradingWindow(nowMs, startHour, endHour, tz)) return 0;
  const end = windowEndMs(nowMs, endHour, tz);
  const mins = Math.ceil((end - nowMs) / 6e4);
  return Math.max(1, Math.min(CLOUD_ARM_MAX_DURATION_MINUTES, mins));
}
function createDailySchedule(input, nowMs = Date.now()) {
  const v = validateCloudArmCreate({
    ...input,
    // Placeholder duration for validate; schedule uses window length at start time.
    durationMinutes: Math.min(
      CLOUD_ARM_MAX_DURATION_MINUTES,
      Math.max(1, Math.floor(Number(input.durationMinutes) || CLOUD_ARM_MAX_DURATION_MINUTES))
    )
  });
  const startHour = input.startHour == null ? CLOUD_ARM_WINDOW_START_HOUR : Number(input.startHour);
  const endHour = input.endHour == null ? CLOUD_ARM_WINDOW_END_HOUR : Number(input.endHour);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) throw new RangeError("startHour inv\xE1lido");
  if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) throw new RangeError("endHour inv\xE1lido");
  if (endHour <= startHour) throw new RangeError("janela inv\xE1lida (endHour > startHour)");
  return {
    enabled: true,
    clientId: v.clientId,
    symbol: v.symbol,
    strategyPreset: v.strategyPreset,
    stake: v.stake,
    leverage: v.leverage,
    granularity: v.granularity,
    mode: v.mode,
    startHour,
    endHour,
    tz: String(input.tz || CLOUD_ARM_TZ),
    createdAt: nowMs,
    updatedAt: nowMs,
    lastSessionDate: null,
    activeJobId: null
  };
}
function disableDailySchedule(schedule, nowMs = Date.now()) {
  return {
    ...schedule,
    enabled: false,
    updatedAt: nowMs,
    activeJobId: null
  };
}
function reconcileDailySchedule(schedule, activeJob, nowMs = Date.now()) {
  if (!schedule || !schedule.enabled) return { action: "idle", reason: "disabled" };
  const tz = schedule.tz || CLOUD_ARM_TZ;
  const startH = schedule.startHour ?? CLOUD_ARM_WINDOW_START_HOUR;
  const endH = schedule.endHour ?? CLOUD_ARM_WINDOW_END_HOUR;
  const parts = luandaDateParts(nowMs, tz);
  const inWindow = parts.hour >= startH && parts.hour < endH;
  const running = activeJob && activeJob.status === "RUNNING";
  if (!inWindow) {
    if (running) return { action: "stop_active", reason: "outside_window" };
    return { action: "idle", reason: "outside_window" };
  }
  if (running) return { action: "idle", reason: "already_running" };
  if (schedule.lastSessionDate === parts.dateKey) {
    return { action: "idle", reason: "already_ran_today" };
  }
  const durationMinutes = durationMinutesUntilWindowEnd(nowMs, startH, endH, tz);
  if (durationMinutes < 1) return { action: "idle", reason: "window_ending" };
  return { action: "start", durationMinutes, dateKey: parts.dateKey };
}
function publicCloudArmSchedule(schedule) {
  if (!schedule) return null;
  return {
    enabled: schedule.enabled,
    clientId: schedule.clientId,
    symbol: schedule.symbol,
    strategyPreset: schedule.strategyPreset,
    stake: schedule.stake,
    leverage: schedule.leverage,
    granularity: schedule.granularity,
    mode: schedule.mode,
    startHour: schedule.startHour,
    endHour: schedule.endHour,
    tz: schedule.tz,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    lastSessionDate: schedule.lastSessionDate,
    activeJobId: schedule.activeJobId,
    windowLabel: `${String(schedule.startHour).padStart(2, "0")}:00\u2013${String(schedule.endHour).padStart(2, "0")}:00 ${schedule.tz}`
  };
}
function publicCloudArmJob(job) {
  return {
    id: job.id,
    symbol: job.symbol,
    strategyPreset: job.strategyPreset,
    stake: job.stake,
    leverage: job.leverage,
    granularity: job.granularity,
    durationMs: job.durationMs,
    mode: job.mode,
    status: job.status,
    stopReason: job.stopReason,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endsAt: job.endsAt,
    updatedAt: job.updatedAt,
    lastTickAt: job.lastTickAt,
    events: job.events,
    summary: job.summary,
    gate: job.gate,
    remainingMs: job.status === "RUNNING" ? Math.max(0, job.endsAt - Date.now()) : 0,
    needsRealFlatten: job.needsRealFlatten === true,
    realOpenSide: job.realOpenSide || null,
    hasRealOpen: !!(job.realOpenQty && job.realOpenSide)
  };
}
export {
  CLOUD_ARM_MAX_DURATION_MINUTES,
  CLOUD_ARM_MAX_EVENTS,
  CLOUD_ARM_MAX_MIRROR_KEYS,
  CLOUD_ARM_MIN_MULTIPLIER,
  CLOUD_ARM_MODE,
  CLOUD_ARM_REVALIDATE_EVERY,
  CLOUD_ARM_TZ,
  CLOUD_ARM_WARMUP,
  CLOUD_ARM_WINDOW_END_HOUR,
  CLOUD_ARM_WINDOW_START_HOUR,
  advanceCloudArmJob,
  cancelCloudArmJob,
  closedCandlesOnly,
  cloudArmEventKey,
  createCloudArmJob,
  createDailySchedule,
  disableDailySchedule,
  durationMinutesUntilWindowEnd,
  isInTradingWindow,
  luandaDateParts,
  markRealMirrorsApplied,
  newCloudArmId,
  pendingRealMirrors,
  publicCloudArmJob,
  publicCloudArmSchedule,
  reconcileDailySchedule,
  tzOffsetMs,
  validateCloudArmCreate,
  windowEndMs
};
