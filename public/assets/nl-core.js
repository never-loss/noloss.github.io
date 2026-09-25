var NL = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/browser/nl-core-entry.ts
  var nl_core_entry_exports = {};
  __export(nl_core_entry_exports, {
    CandleGateController: () => CandleGateController,
    CandlePaperSession: () => CandlePaperSession,
    MARKETS: () => MARKETS,
    MARKET_ORDER: () => MARKET_ORDER,
    MAX_SESSION_MS: () => MAX_SESSION_MS,
    MIN_STAKE: () => MIN_STAKE,
    evaluateCandleGate: () => evaluateCandleGate,
    feasible: () => feasible,
    filterCryptoUsd: () => filterCryptoUsd,
    formatCandleEvent: () => formatCandleEvent,
    formatCandleGate: () => formatCandleGate,
    formatCandleSummary: () => formatCandleSummary,
    isCryptoUsd: () => isCryptoUsd,
    isScheduledOpen: () => isScheduledOpen,
    marketOf: () => marketOf,
    marketStatus: () => marketStatus,
    maxStopFromMultiplier: () => maxStopFromMultiplier,
    mergeCandlePages: () => mergeCandlePages,
    nextCandleEnd: () => nextCandleEnd,
    parseActiveSymbols: () => parseActiveSymbols,
    parseCandlesMessage: () => parseCandlesMessage,
    strategyLibrary: () => strategyLibrary,
    summarizeMarkets: () => summarizeMarkets
  });

  // src/core/markets.ts
  var MARKETS = {
    forex: { kind: "forex", label: "FOREX (pares de moedas)", alwaysOpen: false, assumedCostFraction: 1e-4 },
    metals: { kind: "metals", label: "METAIS (ouro, prata...)", alwaysOpen: false, assumedCostFraction: 2e-4 },
    crypto: { kind: "crypto", label: "CRIPTO", alwaysOpen: true, assumedCostFraction: 1e-3 }
  };
  var MARKET_ORDER = ["forex", "metals", "crypto"];
  function marketOf(symbol) {
    if (/^cry[A-Z0-9]+USD$/.test(symbol)) return "crypto";
    if (/^frx(XAU|XAG|XPD|XPT)[A-Z]{3}$/.test(symbol)) return "metals";
    if (/^frx[A-Z]{6}$/.test(symbol)) return "forex";
    return null;
  }
  function isScheduledOpen(kind, now) {
    if (MARKETS[kind].alwaysOpen) return true;
    const day = now.getUTCDay();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (day === 6) return false;
    if (day === 5 && minutes >= 21 * 60) return false;
    if (day === 0 && minutes < 22 * 60) return false;
    return true;
  }
  function marketStatus(kind, lastCandleEpoch, nowMs, granularity) {
    if (!Number.isFinite(lastCandleEpoch) || !Number.isFinite(nowMs) || !(granularity > 0)) {
      throw new RangeError("Argumentos inv\xE1lidos");
    }
    const ageSeconds = nowMs / 1e3 - lastCandleEpoch;
    if (ageSeconds <= 2 * granularity + 60) return "open";
    return isScheduledOpen(kind, new Date(nowMs)) ? "unknown" : "closed";
  }

  // src/core/crypto-symbols.ts
  function isCryptoUsd(symbol) {
    return /^cry[A-Z0-9]+USD$/.test(symbol);
  }
  function filterCryptoUsd(items) {
    const all = items.filter((it) => isCryptoUsd(it.symbol));
    const open = all.filter((it) => it.open && !it.suspended);
    const chosen = open.length > 0 ? open : all;
    return [...chosen].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  // src/core/market-data.ts
  function flag(v) {
    return v === 1 || v === true || v === "1";
  }
  function parseObject(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return "JSON inv\xE1lido";
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return "Mensagem n\xE3o \xE9 um objeto";
    return data;
  }
  function errorOf(obj) {
    if (obj.error && typeof obj.error === "object") {
      const e = obj.error;
      return { kind: "error", code: String(e.code ?? "unknown"), message: String(e.message ?? "") };
    }
    return null;
  }
  function parseActiveSymbols(raw) {
    const obj = parseObject(raw);
    if (typeof obj === "string") return { kind: "invalid", reason: obj };
    const err = errorOf(obj);
    if (err) return err;
    if (obj.msg_type !== "active_symbols") return { kind: "other" };
    if (!Array.isArray(obj.active_symbols)) return { kind: "invalid", reason: "active_symbols em falta" };
    const items = [];
    let skipped = 0;
    for (const entry of obj.active_symbols) {
      if (typeof entry !== "object" || entry === null) {
        skipped += 1;
        continue;
      }
      const e = entry;
      const symbol = typeof e.underlying_symbol === "string" ? e.underlying_symbol : typeof e.symbol === "string" ? e.symbol : null;
      if (symbol === null || typeof e.market !== "string") {
        skipped += 1;
        continue;
      }
      const displayName = typeof e.underlying_symbol_name === "string" ? e.underlying_symbol_name : typeof e.display_name === "string" ? e.display_name : symbol;
      items.push({
        symbol,
        displayName,
        market: e.market,
        submarket: typeof e.submarket === "string" ? e.submarket : "",
        open: flag(e.exchange_is_open),
        suspended: flag(e.is_trading_suspended)
      });
    }
    return { kind: "symbols", items, skipped };
  }
  function summarizeMarkets(items) {
    const map = /* @__PURE__ */ new Map();
    for (const it of items) {
      const s = map.get(it.market) ?? { market: it.market, total: 0, open: 0 };
      s.total += 1;
      if (it.open && !it.suspended) s.open += 1;
      map.set(it.market, s);
    }
    return [...map.values()].sort((a, b) => a.market.localeCompare(b.market));
  }
  function num(v) {
    const x = typeof v === "string" ? Number(v) : v;
    return typeof x === "number" && Number.isFinite(x) ? x : null;
  }
  function parseCandlesMessage(raw) {
    const obj = parseObject(raw);
    if (typeof obj === "string") return { kind: "invalid", reason: obj };
    const err = errorOf(obj);
    if (err) return err;
    if (obj.msg_type !== "candles") return { kind: "other" };
    if (!Array.isArray(obj.candles)) return { kind: "invalid", reason: "candles em falta" };
    const candles = [];
    for (const c of obj.candles) {
      if (typeof c !== "object" || c === null) return { kind: "invalid", reason: "vela inv\xE1lida" };
      const r = c;
      const epoch = num(r.epoch);
      const open = num(r.open);
      const high = num(r.high);
      const low = num(r.low);
      const close = num(r.close);
      if (epoch === null || open === null || high === null || low === null || close === null) {
        return { kind: "invalid", reason: "vela com campos em falta ou inv\xE1lidos" };
      }
      if (!Number.isInteger(epoch) || high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
        return { kind: "invalid", reason: "vela incoerente (m\xE1ximo/m\xEDnimo)" };
      }
      candles.push({ epoch, open, high, low, close });
    }
    const pip = num(obj.pip_size);
    return { kind: "candles", candles, pipSize: pip !== null && Number.isInteger(pip) ? pip : null };
  }

  // src/core/candle-pages.ts
  function mergeCandlePages(pages) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const page of pages) {
      for (const c of page) {
        if (![c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite)) {
          throw new RangeError("Vela inv\xE1lida numa p\xE1gina");
        }
        if (seen.has(c.epoch)) continue;
        seen.add(c.epoch);
        out.push(c);
      }
    }
    return out.sort((a, b) => a.epoch - b.epoch);
  }
  function nextCandleEnd(candles) {
    if (candles.length === 0) return null;
    let oldest = candles[0].epoch;
    for (const c of candles) if (c.epoch < oldest) oldest = c.epoch;
    return oldest - 1;
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
      bollingerBreakout({ period: 20, k: 2 })
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

  // src/core/feasible.ts
  function assertOpts(o) {
    if (!(o.slAtr > 0) || !Number.isFinite(o.slAtr)) throw new RangeError(`slAtr inv\xE1lido: ${o.slAtr}`);
    if (!(o.maxStopFraction > 0) || !Number.isFinite(o.maxStopFraction)) {
      throw new RangeError(`maxStopFraction inv\xE1lido: ${o.maxStopFraction}`);
    }
  }
  function maxStopFromMultiplier(minMultiplier) {
    if (!(minMultiplier > 0) || !Number.isFinite(minMultiplier)) throw new RangeError(`multiplicador inv\xE1lido: ${minMultiplier}`);
    return 1 / minMultiplier;
  }
  function feasible(strategy, opts) {
    assertOpts(opts);
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

  // src/core/stats.ts
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
    if (n < PRELIMINARY_MIN_OBS) return "INSUFFICIENT";
    if (adjustedP >= ALPHA) return "NO_EVIDENCE";
    if (n < EVIDENCE_MIN_OBS) return "PRELIMINARY";
    return "EVIDENCE";
  }

  // src/core/candle-backtest.ts
  function assertOpts2(o) {
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
    assertOpts2(opts);
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

  // src/core/gate.ts
  var GATE_ALPHA = 0.01;

  // src/core/candle-gate.ts
  function closed(label, reason, over = {}) {
    return { allowed: false, label, reason, strategy: null, oosTrades: 0, meanR: 0, pValue: null, ...over };
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
    if (oos.trades < PRELIMINARY_MIN_OBS || oos.pValue === null) {
      return closed("INSUFFICIENT", `s\xF3 ${oos.trades} opera\xE7\xF5es fora da amostra (m\xEDnimo ${PRELIMINARY_MIN_OBS})`, { oosTrades: oos.trades });
    }
    const base = { oosTrades: oos.trades, meanR: oos.meanR, pValue: oos.pValue };
    if (oos.pValue >= alpha || oos.meanR <= 0) {
      return closed("NO_EVIDENCE", `sem evid\xEAncia: m\xE9dia ${sgn(oos.meanR)}R por opera\xE7\xE3o em ${oos.trades} opera\xE7\xF5es (p = ${oos.pValue.toFixed(3)})`, base);
    }
    const label = classify(oos.trades, oos.pValue);
    const permitted = minLabel === "EVIDENCE" ? label === "EVIDENCE" : label === "EVIDENCE" || label === "PRELIMINARY";
    if (!permitted) return closed(label, `evid\xEAncia ${label} insuficiente para este modo (pede ${minLabel})`, base);
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
  function formatCandleGate(g) {
    return g.allowed ? `PORTA ABERTA - ${g.reason}` : `NO TRADE - ${g.reason}`;
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

  // src/core/paper.ts
  var MIN_STAKE = 0.5;
  var MAX_SESSION_MS = 3 * 60 * 60 * 1e3;

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
    if (cfg.maxDurationMs > MAX_SESSION_MS) throw new RangeError("Dura\xE7\xE3o m\xE1xima \xE9 3 horas");
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
        opened: this.#opened,
        closed: this.#rs.length,
        hasOpenPosition: this.#position !== null,
        totalPnl: this.#pnl,
        maxDrawdown: this.#maxDrawdown,
        metrics: summarizeR(this.#rs)
      };
    }
  };
  var REASONS = {
    manual: "parada manualmente",
    max_loss: "perda m\xE1xima atingida",
    max_trades: "n\xFAmero m\xE1ximo de opera\xE7\xF5es atingido",
    max_duration: "dura\xE7\xE3o m\xE1xima atingida",
    max_consecutive_losses: "perdas seguidas m\xE1ximas atingidas",
    max_drawdown: "queda m\xE1xima atingida"
  };
  var EXIT_TEXT = { sl: "stop", tp: "alvo", time: "tempo" };
  var clock = (ms) => new Date(ms).toISOString().slice(11, 19);
  var price = (x) => String(Number(x.toPrecision(8)));
  var signed = (x, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  function formatCandleEvent(e) {
    switch (e.type) {
      case "started":
        return `${clock(e.at)}  PLAY  sess\xE3o iniciada`;
      case "paused":
        return `${clock(e.at)}  PAUSE  novas entradas bloqueadas`;
      case "stopped":
        return `${clock(e.at)}  STOP  ${REASONS[e.reason]}`;
      case "trade_opened":
        return `${clock(e.at)}  ABRE   ${e.direction === 1 ? "COMPRA" : "VENDA"} a ${price(e.entry)} | stop ${price(e.stopLoss)} | alvo ${price(e.takeProfit)}`;
      case "trade_closed":
        return `${clock(e.at)}  FECHA  ${e.direction === 1 ? "COMPRA" : "VENDA"} sa\xEDda ${price(e.exit)} (${EXIT_TEXT[e.reason]}) -> ${signed(e.r)}R | ${signed(e.pnl)} | total ${signed(e.totalPnl)}`;
    }
  }
  function formatCandleSummary(s) {
    const m = s.metrics;
    const lines = [
      "=== RESUMO (paper trading em velas, dados reais, sem dinheiro) ===",
      `Estado: ${s.status}${s.stopReason ? ` (${REASONS[s.stopReason]})` : ""}`,
      `Opera\xE7\xF5es: ${s.closed} fechadas de ${s.opened} abertas | risco fixo por opera\xE7\xE3o ${s.stake}`
    ];
    if (s.hasOpenPosition) lines.push("H\xE1 uma posi\xE7\xE3o simulada ainda aberta (n\xE3o contada no resultado).");
    if (s.closed === 0) {
      lines.push("Sem opera\xE7\xF5es: o bot ficou em NO TRADE (a porta de evid\xEAncia n\xE3o abriu ou n\xE3o houve sinal).");
    } else {
      lines.push(`Wins: ${m.wins} | Perdas: ${m.trades - m.wins} | taxa ${(m.winRate * 100).toFixed(1)}% | m\xE9dia ${signed(m.meanR, 3)}R por opera\xE7\xE3o`);
      lines.push(`Resultado simulado: ${signed(s.totalPnl)} | pior queda: ${s.maxDrawdown.toFixed(2)} | maior sequ\xEAncia de perdas: ${m.longestLosingStreak}`);
    }
    lines.push("Aviso: poucas opera\xE7\xF5es n\xE3o provam nada. Resultado simulado n\xE3o garante resultado futuro.");
    return lines.join("\n");
  }
  return __toCommonJS(nl_core_entry_exports);
})();
