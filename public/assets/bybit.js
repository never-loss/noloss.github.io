/* NEVER LOSS — Bybit page: live WS chart + dual gate (Loss zero / Lucro rápido). */
(function () {
  "use strict";

  var BYBIT_SYMBOLS_URL = "/api/bybit-symbols";
  var BYBIT_KLINES_URL = "/api/bybit-klines";
  var BYBIT_STATUS_URL = "/api/bybit-status";
  var BYBIT_ORDER_URL = "/api/bybit-order";
  var BYBIT_BALANCE_URL = "/api/bybit-balance";
  var BYBIT_LEVERAGE_URL = "/api/bybit-leverage";
  var BYBIT_WS_URL = "wss://stream.bybit.com/v5/public/linear";
  var TRADING_MODE_KEY = "nl_crypto_trading_mode";
  var CLOUD_ARM_CLIENT_KEY = "nl_cloud_arm_client";
  var CLOUD_ARM_JOB_KEY = "nl_cloud_arm_job";
  var BYBIT_ARM_JOBS_URL = "/api/bybit-arm-jobs";
  var POLL_CHART_MS = 2000;
  var GATE_REEVAL_MS = 30000;
  var LIVE_PROX_MS = 1200;
  var LIVE_PROX_CANDLES = 96;
  var CHART_HISTORY = 96;
  var GATE_HISTORY = 3500;
  var RADAR_BATCH = 3;
  var RADAR_GAP_MS = 400;
  var RADAR_KLINES = 120;
  var RADAR_IDLE_MS = 80;

  var NL = window.NL;
  if (!NL) {
    document.body.innerHTML = "<p style='padding:24px;color:#f87171'>Falha a carregar nl-core.js</p>";
    return;
  }

  var token = sessionStorage.getItem("nl_access_token");
  var el = function (id) { return document.getElementById(id); };

  var state = {
    tradingMode: sessionStorage.getItem(TRADING_MODE_KEY) === "REAL" ? "REAL" : "PAPER",
    bybitKeysConfigured: false,
    bybitRealAvailable: false,
    bybitSymbols: [],
    bybitSymbolsAll: [],
    bybitBalance: null,
    bybitBalanceError: null,
    bybitLeverageInfo: null,
    bybitLeverage: 1,
    symbol: "BTCUSDT",
    granularity: 300,
    stake: 1,
    minutes: 60,
    minMultiplier: 100,
    strategySet: "",
    chartCandles: [],
    gateCandles: [],
    liveGates: { lucro_rapido: null, loss_zero: null },
    liveProx: { lucro_rapido: null, loss_zero: null },
    armState: "disarmed",
    feedMode: "idle",
    ws: null,
    wsTopic: null,
    pollTimer: null,
    gateTimer: null,
    renderPending: false,
    chart: null,
    candleSeries: null,
    chartRo: null,
    loadGen: 0,
    feedGen: 0,
    session: null,
    sessionSymbol: null, // pinned at ARMAR — REAL/PAPER trades this, never stale BTC default
    controller: null,
    running: false,
    lastEpoch: 0,
    realOpenQty: null,
    realOpenSide: null,
    historyLines: [],
    prePlayGate: null,
    prePlayOk: false,
    sessionPollTimer: null,
    revalidateEvery: 12,
    liveProxTimer: null,
    liveProxQueued: false,
    liveProxRunning: false,
    lastLiveProxAt: 0,
    gateHeavyRunning: false,
    cloudJob: null,
    cloudPollTimer: null,
    wsProxTick: 0,
    radar: {
      gen: 0,
      paused: false,
      cursor: 0,
      scanned: 0,
      total: 0,
      rows: {},
      preset: "lucro_rapido",
      filter: "",
      timer: null,
      strategiesCache: {},
    },
  };

  function pushHistory(text, cls) {
    state.historyLines.unshift({ t: Date.now(), text: String(text), cls: cls || "" });
    if (state.historyLines.length > 200) state.historyLines.length = 200;
    renderHistory();
  }

  function renderHistory() {
    var box = el("history");
    if (!box) return;
    box.innerHTML = state.historyLines.slice(0, 80).map(function (h) {
      return '<div class="hist-line ' + (h.cls || "") + '">' + escapeHtml(h.text) + "</div>";
    }).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function signed(x) {
    return (x >= 0 ? "+" : "") + Number(x).toFixed(2);
  }

  function formatUsdt(v) {
    if (v == null || v === "") return "—";
    var n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) + " USDT";
  }

  function isRealTradingMode() {
    return state.tradingMode === "REAL" && state.bybitKeysConfigured && state.bybitRealAvailable;
  }

  /** Symbol that chart/WS/gate/session/REAL must agree on. Armed sessions pin sessionSymbol. */
  function tradeSymbol() {
    if (state.running && state.sessionSymbol) return state.sessionSymbol;
    return state.symbol;
  }

  function syncSymbolSelectToState() {
    var sel = el("bybitSymbolSelect");
    if (!sel || !state.symbol) return;
    if (![].some.call(sel.options, function (o) { return o.value === state.symbol; })) {
      // Ensure option exists: temporarily unfilter, re-render sticky, restore filter list.
      filterSymbols("");
    }
    if (sel.value !== state.symbol) sel.value = state.symbol;
  }

  function assertSelectMatchesTradeSymbol() {
    // Chart/WS/gates own state.symbol. Select is a mirror — never let UI show ETH
    // while armed/session still on BTC (or vice-versa).
    if (state.running && state.sessionSymbol) {
      state.symbol = state.sessionSymbol;
    }
    syncSymbolSelectToState();
    var sel = el("bybitSymbolSelect");
    if (sel && sel.value && sel.value !== state.symbol) {
      sel.value = state.symbol;
    }
    return state.symbol;
  }

  function intervalLabel() {
    return typeof NL.granularityToBybitInterval === "function"
      ? NL.granularityToBybitInterval(state.granularity)
      : "5";
  }

  function closedOnly(candles, granularity) {
    var nowSec = Date.now() / 1000;
    return (candles || []).filter(function (c) { return c.epoch + granularity <= nowSec; });
  }

  function showLoginGate() {
    var gate = el("loginGate");
    var app = el("bybitApp");
    if (gate) gate.hidden = false;
    if (app) app.hidden = true;
    var auth = el("authPill");
    if (auth) { auth.className = "pill warn"; auth.textContent = "Sem sessão Deriv"; }
  }

  function showApp() {
    var gate = el("loginGate");
    var app = el("bybitApp");
    if (gate) gate.hidden = true;
    if (app) app.hidden = false;
    var auth = el("authPill");
    if (auth) { auth.className = "pill ok"; auth.textContent = "Deriv OK"; }
  }

  function chartHostSize(host) {
    var w = host && host.clientWidth ? host.clientWidth : 0;
    var h = host && host.clientHeight ? host.clientHeight : 0;
    return { w: w > 40 ? w : 640, h: h > 80 ? h : 280 };
  }

  function applyChartSize() {
    var host = el("bybitChart");
    if (!state.chart || !host) return;
    var sz = chartHostSize(host);
    try { state.chart.applyOptions({ width: sz.w, height: sz.h }); } catch (_e) {}
  }

  function paintChartFromState(fit) {
    var list = state.chartCandles || [];
    var empty = el("chartEmpty");
    if (!list.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    if (state.candleSeries) {
      try {
        applySeriesPriceFormat(list);
        state.candleSeries.setData(list.map(toLcBar));
        if (fit && state.chart) {
          try { state.chart.timeScale().fitContent(); } catch (_e2) {}
        }
      } catch (_e) {
        // Series/chart desynced — recreate once and reload immediately.
        destroyChart();
        ensureChart(true);
        if (state.candleSeries) {
          try {
            applySeriesPriceFormat(list);
            state.candleSeries.setData(list.map(toLcBar));
          } catch (_e3) {}
        }
      }
      return;
    }
    drawCanvasChart(list);
  }

  function destroyChart() {
    if (state.chartRo) {
      try { state.chartRo.disconnect(); } catch (_e) {}
      state.chartRo = null;
    }
    if (state.chart) {
      try { state.chart.remove(); } catch (_e2) {}
    }
    state.chart = null;
    state.candleSeries = null;
    var host = el("bybitChart");
    if (host) host.innerHTML = "";
  }

  /** Keep chart mounted. Only create if missing. force=true recreates then caller must paint. */
  function ensureChart(force) {
    var host = el("bybitChart");
    if (!host) return;
    if (state.chart && state.candleSeries && !force) {
      applyChartSize();
      return;
    }
    if (force || state.chart) destroyChart();
    if (typeof window.LightweightCharts === "undefined") {
      var canvasFb = el("chartCanvas");
      if (canvasFb) canvasFb.hidden = false;
      pushHistory("lightweight-charts indisponível — canvas.", "stop");
      return;
    }
    var canvas = el("chartCanvas");
    if (canvas) canvas.hidden = true;
    var sz = chartHostSize(host);
    var chart = window.LightweightCharts.createChart(host, {
      layout: { background: { type: "solid", color: "#0b1220" }, textColor: "#94a3b8", fontSize: 11 },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.08)" },
        horzLines: { color: "rgba(148,163,184,0.08)" },
      },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.2)", scaleMargins: { top: 0.08, bottom: 0.12 } },
      timeScale: {
        borderColor: "rgba(148,163,184,0.2)",
        timeVisible: true,
        secondsVisible: state.granularity <= 60,
      },
      crosshair: {
        mode: window.LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: "rgba(148,163,184,0.35)", labelBackgroundColor: "#1e293b" },
        horzLine: { color: "rgba(148,163,184,0.35)", labelBackgroundColor: "#1e293b" },
      },
      localization: { locale: "pt-PT" },
      width: sz.w,
      height: sz.h,
    });
    var series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef4444",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    state.chart = chart;
    state.candleSeries = series;
    if (typeof ResizeObserver !== "undefined") {
      state.chartRo = new ResizeObserver(function () {
        if (!state.chart || !host) return;
        var w = host.clientWidth;
        var h = host.clientHeight;
        // Ignore transient 0-size layouts (strategy card toggles / mobile reflow) — blank-chart killer.
        if (!(w > 40) || !(h > 40)) return;
        try { state.chart.applyOptions({ width: w, height: h || 280 }); } catch (_e) {}
      });
      state.chartRo.observe(host);
    }
  }

  function initChart() { ensureChart(false); }

  function toLcBar(c) {
    return { time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close };
  }

  /** Adapt tick size so alts (SOL/PEPE/…) aren’t invisible after BTC scale. */
  function applySeriesPriceFormat(candles) {
    if (!state.candleSeries || !candles || !candles.length) return;
    var px = Number(candles[candles.length - 1].close);
    if (!(px > 0) || !Number.isFinite(px)) return;
    var precision, minMove;
    if (px >= 1000) { precision = 2; minMove = 0.1; }
    else if (px >= 100) { precision = 2; minMove = 0.01; }
    else if (px >= 1) { precision = 4; minMove = 0.0001; }
    else if (px >= 0.01) { precision = 6; minMove = 0.000001; }
    else { precision = 8; minMove = 0.00000001; }
    try {
      state.candleSeries.applyOptions({
        priceFormat: { type: "price", precision: precision, minMove: minMove },
      });
    } catch (_e) {}
  }

  function scheduleRender() {
    if (state.renderPending) return;
    state.renderPending = true;
    requestAnimationFrame(function () {
      state.renderPending = false;
      renderChart();
    });
  }

  function renderChart() {
    var list = state.chartCandles || [];
    var empty = el("chartEmpty");
    var status = el("chartStatus");
    if (!list.length) {
      if (empty) empty.hidden = false;
      if (status) { status.className = "pill warn"; status.textContent = "A carregar…"; }
      updateLivePrice(null);
      return;
    }
    if (empty) empty.hidden = true;
    var last = list[list.length - 1];
    updateLivePrice(last, list.length > 1 ? list[list.length - 2] : null);
    if (status) {
      var mode = state.feedMode === "ws" ? "WS ao vivo" : state.feedMode === "poll" ? "Poll" : "…";
      status.className = "pill " + (state.feedMode === "ws" ? "live-ok" : state.feedMode === "poll" ? "live-poll" : "warn");
      status.textContent = list.length + " velas · " + (state.symbol || "") + " · " + mode;
    }
    ensureChart(false);
    paintChartFromState(false);
  }

  function updateLastBar(candle) {
    if (!candle) return;
    if (!state.candleSeries) ensureChart(false);
    if (state.candleSeries) {
      try { state.candleSeries.update(toLcBar(candle)); }
      catch (_e) {
        // Recover blank/desynced series without dropping the feed.
        try {
          ensureChart(true);
          paintChartFromState(false);
          if (state.candleSeries) state.candleSeries.update(toLcBar(candle));
        } catch (_e2) { scheduleRender(); }
      }
    } else {
      scheduleRender();
    }
    updateLivePrice(candle, state.chartCandles.length > 1 ? state.chartCandles[state.chartCandles.length - 2] : null);
    var status = el("chartStatus");
    if (status && state.feedMode === "ws") {
      status.className = "pill live-ok";
      status.textContent = state.chartCandles.length + " velas · " + state.symbol + " · WS ao vivo";
    }
  }

  function updateLivePrice(last, prev) {
    var priceEl = el("livePrice");
    var chEl = el("liveChange");
    if (!priceEl) return;
    if (!last) {
      priceEl.textContent = "—";
      priceEl.className = "live-price";
      if (chEl) { chEl.textContent = "—"; chEl.className = "live-change"; }
      return;
    }
    var px = Number(last.close);
    priceEl.textContent = px.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
    var up = prev ? px >= Number(prev.close) : last.close >= last.open;
    priceEl.className = "live-price " + (up ? "up" : "down");
    if (chEl) {
      var base = prev ? Number(prev.close) : Number(last.open);
      var diff = px - base;
      var pct = base ? (diff / base) * 100 : 0;
      chEl.textContent = (diff >= 0 ? "+" : "") + diff.toLocaleString("pt-PT", { maximumFractionDigits: 4 }) +
        " (" + (pct >= 0 ? "+" : "") + pct.toFixed(3) + "%)";
      chEl.className = "live-change " + (diff >= 0 ? "up" : "down");
    }
  }

  function drawCanvasChart(list) {
    var canvas = el("chartCanvas");
    if (!canvas || canvas.hidden) return;
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 640;
    var cssH = 240;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, cssW, cssH);
    var min = Infinity, max = -Infinity, i;
    for (i = 0; i < list.length; i++) {
      min = Math.min(min, list[i].low);
      max = Math.max(max, list[i].high);
    }
    if (!(max > min)) max = min + 1;
    var pad = (max - min) * 0.08;
    min -= pad; max += pad;
    var left = 8, right = 48, top = 10, bottom = 18;
    var w = cssW - left - right;
    var h = cssH - top - bottom;
    var n = list.length;
    var slot = w / n;
    var yOf = function (v) { return top + ((max - v) / (max - min)) * h; };
    ctx.strokeStyle = "rgba(148,163,184,0.12)";
    ctx.fillStyle = "#64748b";
    ctx.font = "10px sans-serif";
    for (var g = 0; g < 4; g++) {
      var y = top + (h * g) / 3;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + w, y); ctx.stroke();
      var pv = max - ((max - min) * g) / 3;
      ctx.fillText(pv.toFixed(pv > 100 ? 2 : 4), left + w + 4, y + 3);
    }
    for (var j = 0; j < n; j++) {
      var c = list[j];
      var x = left + j * slot + slot * 0.5;
      var upC = c.close >= c.open;
      ctx.strokeStyle = upC ? "#22c55e" : "#ef4444";
      ctx.fillStyle = upC ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)";
      ctx.beginPath(); ctx.moveTo(x, yOf(c.high)); ctx.lineTo(x, yOf(c.low)); ctx.stroke();
      var bodyTop = yOf(Math.max(c.open, c.close));
      var bodyBot = yOf(Math.min(c.open, c.close));
      var bw = Math.max(2, slot * 0.55);
      ctx.fillRect(x - bw / 2, bodyTop, bw, Math.max(1, bodyBot - bodyTop));
    }
  }

  function setFeedMode(mode) {
    state.feedMode = mode;
    var pill = el("feedPill");
    var hint = el("liveFeedHint");
    if (pill) {
      if (mode === "ws") { pill.className = "pill live-ok"; pill.textContent = "WS ao vivo"; }
      else if (mode === "poll") { pill.className = "pill live-poll"; pill.textContent = "Poll"; }
      else if (mode === "err") { pill.className = "pill live-err"; pill.textContent = "Feed erro"; }
      else { pill.className = "pill warn"; pill.textContent = "Feed…"; }
    }
    if (hint) {
      hint.textContent = mode === "ws" ? "WebSocket Bybit público (linear)"
        : mode === "poll" ? "Fallback poll /api/bybit-klines" : "A ligar feed…";
    }
  }

  function stopFeed() {
    // Invalidate in-flight WS/poll handlers before closing.
    state.feedGen += 1;
    if (state.ws) {
      if (state.wsTopic && state.ws.readyState === 1) {
        try { state.ws.send(JSON.stringify({ op: "unsubscribe", args: [state.wsTopic] })); } catch (_u) {}
      }
      try { state.ws.close(); } catch (_e) {}
      state.ws = null;
    }
    state.wsTopic = null;
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function mergeCandle(list, candle) {
    if (!list.length) return [candle];
    var last = list[list.length - 1];
    if (candle.epoch === last.epoch) { list[list.length - 1] = candle; return list; }
    if (candle.epoch > last.epoch) {
      list.push(candle);
      if (list.length > CHART_HISTORY) list.splice(0, list.length - CHART_HISTORY);
      return list;
    }
    return list;
  }

  function applyLiveKline(raw) {
    var startMs = Number(raw.start);
    if (!Number.isFinite(startMs)) return;
    var candle = {
      epoch: Math.floor(startMs / 1000),
      open: Number(raw.open), high: Number(raw.high), low: Number(raw.low), close: Number(raw.close),
    };
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) return;
    state.chartCandles = mergeCandle(state.chartCandles, candle);
    try { updateLastBar(candle); } catch (_u) { try { scheduleRender(); } catch (_r) {} }
    var confirmed = raw.confirm === true || raw.confirm === "true";
    // Light chart path: proximity only on closed candle or every 8th tick — no heavy work per WS tick.
    state.wsProxTick = (state.wsProxTick || 0) + 1;
    if (confirmed || state.wsProxTick % 8 === 0) {
      try { scheduleLiveProximity(); } catch (_p) {}
    }
    if (confirmed) {
      var closed = { epoch: candle.epoch, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
      if (!state.gateCandles.length || closed.epoch > state.gateCandles[state.gateCandles.length - 1].epoch) {
        state.gateCandles.push(closed);
        if (state.gateCandles.length > GATE_HISTORY) state.gateCandles = state.gateCandles.slice(-GATE_HISTORY);
        scheduleGateReeval();
        if (state.running && state.session) pushClosedCandleToSession(closed);
      } else if (closed.epoch === state.gateCandles[state.gateCandles.length - 1].epoch) {
        state.gateCandles[state.gateCandles.length - 1] = closed;
      }
    }
  }

  function startWsFeed() {
    stopFeed();
    var feedId = ++state.feedGen;
    setFeedMode("idle");
    var interval = intervalLabel();
    var sym = state.symbol;
    if (!interval || !sym) { setFeedMode("err"); return; }
    var topic = "kline." + interval + "." + sym;
    var ws;
    try { ws = new WebSocket(BYBIT_WS_URL); }
    catch (e) {
      pushHistory("WS Bybit falhou: " + (e.message || String(e)) + " — poll.", "stop");
      if (feedId === state.feedGen) startPollFeed();
      return;
    }
    state.ws = ws;
    state.wsTopic = topic;
    var opened = false;
    var failTimer = setTimeout(function () {
      if (!opened && feedId === state.feedGen) {
        pushHistory("WS timeout — a usar poll.", "stop");
        try { ws.close(); } catch (_e) {}
        startPollFeed();
      }
    }, 6000);
    ws.onopen = function () {
      if (feedId !== state.feedGen) { try { ws.close(); } catch (_e) {} return; }
      opened = true;
      clearTimeout(failTimer);
      try { ws.send(JSON.stringify({ op: "subscribe", args: [topic] })); } catch (_e2) {}
      setFeedMode("ws");
      var hint = el("liveFeedHint");
      if (hint) hint.textContent = "Subscrito " + topic;
    };
    ws.onmessage = function (ev) {
      if (feedId !== state.feedGen || state.ws !== ws) return;
      if (state.symbol !== sym) return;
      var msg;
      try { msg = JSON.parse(ev.data); } catch (_e) { return; }
      if (!msg) return;
      if (msg.topic === topic && Array.isArray(msg.data)) {
        for (var i = 0; i < msg.data.length; i++) applyLiveKline(msg.data[i]);
      }
    };
    ws.onerror = function () {
      clearTimeout(failTimer);
      if (feedId === state.feedGen && state.feedMode !== "poll") {
        pushHistory("WS erro — fallback poll.", "stop");
        startPollFeed();
      }
    };
    ws.onclose = function () {
      clearTimeout(failTimer);
      if (feedId === state.feedGen && state.ws === ws && state.feedMode === "ws") startPollFeed();
    };
  }

  function startPollFeed() {
    if (state.ws) { try { state.ws.close(); } catch (_e) {} state.ws = null; }
    setFeedMode("poll");
    if (state.pollTimer) clearInterval(state.pollTimer);
    var tick = async function () {
      try {
        var raw = await fetchKlinesRaw(state.symbol, state.granularity, CHART_HISTORY);
        if (!raw.length) return;
        var next = raw.slice(-CHART_HISTORY);
        var prevLast = state.chartCandles.length ? state.chartCandles[state.chartCandles.length - 1] : null;
        var nextLast = next[next.length - 1];
        state.chartCandles = next;
        if (prevLast && nextLast && prevLast.epoch === nextLast.epoch && state.candleSeries) {
          updateLastBar(nextLast);
        } else {
          scheduleRender();
          updateLastBar(nextLast);
        }
      } catch (e) {
        setFeedMode("err");
        var status = el("chartStatus");
        if (status) { status.className = "pill live-err"; status.textContent = "Erro: " + (e.message || String(e)); }
      }
    };
    tick();
    state.pollTimer = setInterval(tick, POLL_CHART_MS);
  }

  async function fetchKlinesRaw(symbol, granularity, count) {
    var interval = typeof NL.granularityToBybitInterval === "function"
      ? NL.granularityToBybitInterval(granularity) : null;
    if (!interval) throw new Error("intervalo inválido");
    var url = BYBIT_KLINES_URL + "?symbol=" + encodeURIComponent(symbol) +
      "&interval=" + encodeURIComponent(interval) +
      "&limit=" + Math.min(1000, Math.max(2, count || 10));
    var res = await fetch(url);
    var text = await res.text();
    var msg = NL.parseBybitKlines(text);
    if (msg.kind !== "candles") {
      var why = msg.kind === "error" ? msg.code + " - " + msg.message : msg.reason || msg.kind;
      throw new Error("Bybit klines: " + why);
    }
    return msg.candles.slice().sort(function (a, b) { return a.epoch - b.epoch; });
  }

  async function fetchLatestBybitCandles(symbol, granularity, count) {
    return closedOnly(await fetchKlinesRaw(symbol, granularity, count), granularity);
  }

  async function fetchBybitHistory(symbol, granularity, target) {
    if (typeof NL.fetchBybitCandleHistory === "function") {
      var proxyFetch = async function (url) {
        var u = String(url);
        if (u.indexOf("/v5/market/kline") >= 0) {
          var q = u.split("?")[1] || "";
          return fetch(BYBIT_KLINES_URL + (q ? "?" + q : ""));
        }
        return fetch(u);
      };
      return NL.fetchBybitCandleHistory(symbol, granularity, target, proxyFetch);
    }
    var pages = [];
    var endTime = "";
    var guard = 0;
    var interval = NL.granularityToBybitInterval(granularity);
    while (guard++ < 30) {
      var url = BYBIT_KLINES_URL + "?symbol=" + encodeURIComponent(symbol) +
        "&interval=" + encodeURIComponent(interval) + "&limit=1000";
      if (endTime) url += "&end=" + endTime;
      var res = await fetch(url);
      var text = await res.text();
      var msg = NL.parseBybitKlines(text);
      if (msg.kind !== "candles" || !msg.candles.length) break;
      pages.push(msg.candles);
      var oldest = msg.candles.reduce(function (m, c) { return Math.min(m, c.epoch); }, Infinity);
      endTime = String(oldest * 1000 - 1);
      var merged = NL.mergeCandlePages(pages);
      if (merged.length >= target || msg.candles.length < 1000) break;
    }
    return closedOnly(NL.mergeCandlePages(pages), granularity).slice(-target);
  }

  async function loadChartAndGates() {
    var gen = ++state.loadGen;
    var sym = state.symbol;
    var gran = state.granularity;
    var status = el("chartStatus");
    if (status) { status.className = "pill warn"; status.textContent = "A carregar " + sym + "…"; }
    setStratLoading();
    // Drop previous symbol candles immediately so BTC doesn’t linger while ETH loads.
    state.chartCandles = [];
    state.gateCandles = [];
    updateLivePrice(null);
    ensureChart(false);
    if (state.candleSeries) {
      try { state.candleSeries.setData([]); } catch (_clr) {}
    }
    try {
      // Fast path: chart + WS first (CHART_HISTORY), then heavy gate history.
      var raw = await fetchKlinesRaw(sym, gran, CHART_HISTORY);
      if (gen !== state.loadGen || state.symbol !== sym || state.granularity !== gran) return;
      var recent = raw.length ? raw.slice(-CHART_HISTORY) : [];
      state.chartCandles = recent;
      ensureChart(false);
      paintChartFromState(true);
      scheduleRender();
      startWsFeed();
      startGateTimer();
      scheduleLiveProximity();

      var hist = recent.slice();
      try {
        hist = await fetchBybitHistory(sym, gran, GATE_HISTORY);
      } catch (_h) {
        // Chart already live — gate history soft-fails; proximity still works on chartCandles.
        hist = recent.slice();
      }
      if (gen !== state.loadGen || state.symbol !== sym || state.granularity !== gran) return;
      state.gateCandles = hist.slice();
      // Heavy gate deferred so chart/WS never stutter on symbol switch
      scheduleGateReeval();
    } catch (e) {
      if (gen !== state.loadGen) return;
      setFeedMode("err");
      if (status) { status.className = "pill live-err"; status.textContent = "Gráfico: " + (e.message || String(e)); }
      var empty = el("chartEmpty");
      if (empty) { empty.hidden = false; empty.textContent = "Sem velas — " + (e.message || String(e)); }
      setStratError(e.message || String(e));
    }
  }

  function startGateTimer() {
    if (state.gateTimer) clearInterval(state.gateTimer);
    state.gateTimer = setInterval(function () { scheduleGateReeval(); }, GATE_REEVAL_MS);
  }

  var gateEvalPending = false;
  var gateEvalQueued = false;
  function scheduleGateReeval() {
    gateEvalQueued = true;
    if (gateEvalPending || state.gateHeavyRunning) return;
    gateEvalPending = true;
    // Defer heavy gate off the WS/UI tick
    var run = function () {
      Promise.resolve().then(async function () {
        state.gateHeavyRunning = true;
        try {
          while (gateEvalQueued) {
            gateEvalQueued = false;
            await reevaluateBothGates();
            await yieldToUi();
          }
        } finally {
          state.gateHeavyRunning = false;
          gateEvalPending = false;
          if (gateEvalQueued) scheduleGateReeval();
        }
      });
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 0);
  }

  function yieldToUi(ms) {
    return new Promise(function (resolve) {
      var t = typeof ms === "number" ? ms : RADAR_IDLE_MS;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(function () { setTimeout(resolve, t); });
      } else setTimeout(resolve, t);
    });
  }

  function scheduleLiveProximity() {
    state.liveProxQueued = true;
    if (state.liveProxRunning) return;
    var due = LIVE_PROX_MS - (Date.now() - state.lastLiveProxAt);
    if (due < 0) due = 0;
    if (state.liveProxTimer) return;
    state.liveProxTimer = setTimeout(function () {
      state.liveProxTimer = null;
      runLiveProximityTick();
    }, Math.max(due, 16));
  }

  function liveCandleSeries() {
    var cap = LIVE_PROX_CANDLES;
    var base = (state.gateCandles && state.gateCandles.length)
      ? state.gateCandles.slice(-cap)
      : [];
    var chart = state.chartCandles || [];
    if (!chart.length) return base;
    var last = chart[chart.length - 1];
    if (!base.length) return chart.slice(-Math.min(cap, chart.length));
    var tip = base[base.length - 1];
    if (last.epoch > tip.epoch) base.push(last);
    else if (last.epoch === tip.epoch) base[base.length - 1] = last;
    // Cap for live prox CPU — full history only for heavy gate
    if (base.length > cap) base = base.slice(-cap);
    return base;
  }

  function strategiesRaw(presetId) {
    if (state.radar.strategiesCache[presetId]) return state.radar.strategiesCache[presetId];
    var raw;
    if (typeof NL.strategiesForPreset === "function") raw = NL.strategiesForPreset(presetId);
    else if (presetId === "lucro_rapido") raw = NL.lucroRapidoStrategySet();
    else if (presetId === "loss_zero") raw = NL.lossZeroStrategySet();
    else raw = NL.strategyLibrary();
    state.radar.strategiesCache[presetId] = raw;
    return raw;
  }

  async function runLiveProximityTick() {
    if (state.liveProxRunning) return;
    if (!state.liveProxQueued) return;
    state.liveProxQueued = false;
    state.liveProxRunning = true;
    state.lastLiveProxAt = Date.now();
    try {
      var candles = liveCandleSeries();
      if (candles.length < 40 || typeof NL.evaluateLiveEntry !== "function") {
        syncArmUi();
        return;
      }
      var ids = ["lucro_rapido", "loss_zero"];
      if (state.strategySet && ids.indexOf(state.strategySet) < 0) ids.push(state.strategySet);
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        try {
          var live = NL.evaluateLiveEntry(candles, strategiesRaw(id), { hold: 3 });
          state.liveProx[id] = live;
          if (id === "lucro_rapido" || id === "loss_zero") renderStratCard(id, state.liveGates[id], null);
        } catch (_e) {}
        if (i === 0) await yieldToUi(0);
      }
      syncPlayReadyFromSelection();
      syncArmUi();
    } finally {
      state.liveProxRunning = false;
      if (state.liveProxQueued) scheduleLiveProximity();
    }
  }

  function setStratLoading() {
    ["LucroRapido", "LossZero"].forEach(function (k) {
      var badge = el("badge" + k);
      var status = el("status" + k);
      var reason = el("reason" + k);
      if (badge) badge.textContent = "…";
      if (status) status.textContent = "A analisar…";
      if (reason) reason.textContent = "A carregar histórico real…";
    });
  }

  function setStratError(msg) {
    ["lucro_rapido", "loss_zero"].forEach(function (id) { renderStratCard(id, null, msg); });
  }

  function proximityScore(result, allowed) {
    if (!result) return 0;
    if (allowed) return 100;
    var oos = typeof result.oosTrades === "number" ? result.oosTrades : 0;
    var meanR = typeof result.meanR === "number" ? result.meanR : 0;
    var p = result.pValue != null && Number.isFinite(result.pValue) ? result.pValue : 1;
    var score = 0;
    score += Math.min(40, Math.round((oos / 30) * 40));
    if (meanR > 0) score += Math.min(30, Math.round((Math.min(meanR, 0.5) / 0.5) * 30));
    if (p < 0.5) score += Math.min(25, Math.round((1 - p) * 25));
    return Math.min(85, Math.max(5, score));
  }

  function gateOptsForPreset(presetId, costFraction, trainSize, testSize) {
    var preset = typeof NL.strategyPreset === "function" ? NL.strategyPreset(presetId) : null;
    var g = (preset && preset.preferredGate) || {};
    return {
      slAtr: g.slAtr || 1.5, tpR: g.tpR || 2, maxBars: g.maxBars || 24,
      costFraction: costFraction, trainSize: trainSize, testSize: testSize,
      minLabel: g.minLabel || "PRELIMINARY",
    };
  }

  function strategiesFor(presetId) {
    var raw;
    if (typeof NL.strategiesForPreset === "function") raw = NL.strategiesForPreset(presetId);
    else if (presetId === "lucro_rapido") raw = NL.lucroRapidoStrategySet();
    else if (presetId === "loss_zero") raw = NL.lossZeroStrategySet();
    else raw = NL.strategyLibrary();
    var preset = typeof NL.strategyPreset === "function" ? NL.strategyPreset(presetId) : null;
    var slAtr = (preset && preset.preferredGate && preset.preferredGate.slAtr) || 1.5;
    return raw.map(function (s) {
      return NL.feasible(s, { slAtr: slAtr, maxStopFraction: 1 / state.minMultiplier });
    });
  }

  function evaluatePreset(presetId, candles) {
    var kind = NL.marketOf(state.symbol);
    var costFraction = kind && NL.MARKETS[kind] ? NL.MARKETS[kind].assumedCostFraction : 0.001;
    var n = candles.length;
    if (n < 1500) {
      return {
        allowed: false, reason: "histórico insuficiente (" + n + " velas)",
        label: "INSUFFICIENT", oosTrades: 0, meanR: 0, pValue: null, strategy: null,
      };
    }
    var trainSize = Math.min(1000, Math.floor(n * 0.4));
    var testSize = Math.min(500, Math.floor(n * 0.2));
    var strategies = strategiesFor(presetId);
    var gate = gateOptsForPreset(presetId, costFraction, trainSize, testSize);
    return NL.evaluateCandleGate(candles, strategies, gate);
  }

  async function reevaluateBothGates() {
    var candles = state.gateCandles;
    if (!candles || candles.length < 100) {
      setStratError("à espera de mais velas reais…");
      return;
    }
    try {
      var tip = await fetchLatestBybitCandles(state.symbol, state.granularity, 5);
      for (var i = 0; i < tip.length; i++) {
        var c = tip[i];
        if (!state.gateCandles.length || c.epoch > state.gateCandles[state.gateCandles.length - 1].epoch) {
          state.gateCandles.push(c);
        } else if (c.epoch === state.gateCandles[state.gateCandles.length - 1].epoch) {
          state.gateCandles[state.gateCandles.length - 1] = c;
        }
      }
      if (state.gateCandles.length > GATE_HISTORY) state.gateCandles = state.gateCandles.slice(-GATE_HISTORY);
      candles = state.gateCandles;
    } catch (_e) {}

    var ids = ["lucro_rapido", "loss_zero"];
    if (state.strategySet && ids.indexOf(state.strategySet) < 0) ids.push(state.strategySet);
    for (var j = 0; j < ids.length; j++) {
      var id = ids[j];
      try {
        var result = evaluatePreset(id, candles);
        state.liveGates[id] = result;
        if (id === "lucro_rapido" || id === "loss_zero") renderStratCard(id, result, null);
      } catch (e) {
        state.liveGates[id] = null;
        if (id === "lucro_rapido" || id === "loss_zero") renderStratCard(id, null, e.message || String(e));
      }
      if (j < ids.length - 1) await yieldToUi(30);
    }
    scheduleLiveProximity();
    syncPlayReadyFromSelection();
    syncArmUi();
    updateButtons();
  }

  function renderStratCard(presetId, result, errMsg) {
    var isLucro = presetId === "lucro_rapido";
    var key = isLucro ? "LucroRapido" : "LossZero";
    var label = isLucro ? "Lucro rápido" : "Loss zero";
    var card = el("card" + key);
    var dot = el("dot" + key);
    var badge = el("badge" + key);
    var status = el("status" + key);
    var reason = el("reason" + key);
    var proxEl = el("prox" + key);
    var fill = el("fill" + key);
    var bar = el("bar" + key);
    if (!card) return;
    var allowed = !!(result && result.allowed);
    var live = state.liveProx[presetId];
    var gateSc = proximityScore(result, allowed);
    var combined = (typeof NL.combineGateAndLive === "function" && live)
      ? NL.combineGateAndLive(allowed, gateSc, live)
      : { score: live ? Math.max(gateSc, live.proximityPct) : gateSc, label: "", ready: false };
    var score = combined.score;
    card.classList.toggle("open", allowed && live && live.atTarget);
    card.classList.toggle("closed", !(allowed && live && live.atTarget));
    card.classList.toggle("active-pick", state.strategySet === presetId);
    if (fill) {
      fill.style.width = score + "%";
      fill.classList.toggle("ok", allowed && live && live.atTarget);
      fill.classList.toggle("warn", score >= 40 && !(allowed && live && live.atTarget));
      fill.classList.toggle("bad", score < 40);
    }
    if (bar) bar.setAttribute("aria-valuenow", String(score));
    if (dot) {
      var col = allowed && live && live.atTarget ? "green" : allowed || score >= 55 ? "amber" : "red";
      dot.className = "sem-dot " + col;
    }
    if (proxEl) {
      proxEl.textContent = live
        ? ("Prox " + live.proximityPct + "% · " + (live.bias === "long" ? "compra" : live.bias === "short" ? "venda" : "neutro") +
          (live.atTarget ? " · ALVO" : "") + " · " + live.agreeingLong + "↑/" + live.agreeingShort + "↓ de " + live.total)
        : "Prox — (à espera de velas ao vivo)";
    }
    if (errMsg) {
      if (badge) badge.textContent = "erro";
      if (status) status.textContent = "NO TRADE";
      if (reason) reason.textContent = errMsg;
      return;
    }
    if (!result && !live) {
      if (badge) badge.textContent = "…";
      if (status) status.textContent = "NO TRADE";
      if (reason) reason.textContent = "A aguardar evidência…";
      return;
    }
    if (allowed && live && live.atTarget) {
      if (badge) badge.textContent = "ALVO";
      if (status) status.textContent = label + ": PORTA + ALVO";
    } else if (allowed) {
      if (badge) badge.textContent = "PORTA";
      if (status) status.textContent = label + ": porta aberta · à espera do sinal";
    } else {
      if (badge) badge.textContent = "NO TRADE";
      if (status) status.textContent = label + ": NO TRADE";
    }
    if (reason) {
      var gateTxt = result
        ? (typeof NL.formatCandleGate === "function" ? NL.formatCandleGate(result) : result.reason)
        : "porta pendente";
      var liveTxt = live ? live.detail : "";
      reason.textContent = gateTxt + (liveTxt ? " · " + liveTxt : "");
    }
  }

  function syncPlayReadyFromSelection() {
    var box = el("playReadyBox");
    var title = el("playReadyTitle");
    var reason = el("playReadyReason");
    var fill = el("playReadyFill");
    var bar = el("playReadyBar");
    var pct = el("playReadyPct");
    var dot = el("playReadyDot");
    var preset = state.strategySet;
    var labelMap = {
      lucro_rapido: "Lucro rápido",
      loss_zero: "Loss zero",
      tendencia_diaria: "Tendência diária",
      biblioteca: "Biblioteca",
    };
    var label = preset && labelMap[preset] ? labelMap[preset] : null;
    var result = preset && state.liveGates[preset] ? state.liveGates[preset] : null;
    var c1 = el("cardLucroRapido");
    var c2 = el("cardLossZero");
    if (c1) c1.classList.toggle("active-pick", preset === "lucro_rapido");
    if (c2) c2.classList.toggle("active-pick", preset === "loss_zero");

    if (!label) {
      if (box) { box.classList.add("closed"); box.classList.remove("open"); }
      if (title) title.textContent = "Escolhe uma estratégia";
      if (reason) reason.textContent = "Indicadores ao vivo com velas Bybit. Verde só com porta real — sem auto-PLAY.";
      if (fill) fill.style.width = "0%";
      if (pct) pct.textContent = "0%";
      if (dot) dot.className = "sem-dot amber";
      state.prePlayOk = false;
      state.prePlayGate = null;
      return;
    }

    var allowed = !!(result && result.allowed);
    state.prePlayOk = allowed;
    state.prePlayGate = result;
    var score = proximityScore(result, allowed);
    if (box) { box.classList.toggle("open", allowed); box.classList.toggle("closed", !allowed); }
    if (title) title.textContent = allowed ? label + ": PODE PLAY" : label + ": NO TRADE";
    if (reason) {
      if (!result) reason.textContent = "A aguardar avaliação da porta…";
      else if (allowed) reason.textContent = "Porta aberta (evidência real). Confirma PLAY manualmente — sem auto-PLAY.";
      else reason.textContent = typeof NL.formatCandleGate === "function"
        ? NL.formatCandleGate(result) : "NO TRADE — " + (result.reason || "sem evidência");
    }
    if (fill) {
      fill.style.width = score + "%";
      fill.classList.toggle("ok", allowed);
      fill.classList.toggle("warn", !allowed && score >= 40);
      fill.classList.toggle("bad", !allowed && score < 40);
    }
    if (bar) bar.setAttribute("aria-valuenow", String(score));
    if (pct) pct.textContent = score + "%";
    if (dot) dot.className = "sem-dot " + (allowed ? "green" : score >= 40 ? "amber" : "red");
    setGateUI(result, allowed);
    setPrePlayUI(result);
  }

  function setGateUI(result, isOpen) {
    var box = el("gateBox");
    if (!box) return;
    var allowed = !!(result && result.allowed && isOpen !== false);
    box.classList.toggle("open", allowed);
    box.classList.toggle("closed", !allowed);
    var gs = el("gateState");
    var gr = el("gateReason");
    if (gs) gs.textContent = allowed ? "PORTA ABERTA" : "NO TRADE";
    if (gr) {
      gr.textContent = result
        ? (typeof NL.formatCandleGate === "function" ? NL.formatCandleGate(result) : result.reason)
        : "A aguardar…";
    }
    var set = function (id, v) { var n = el(id); if (n) n.textContent = v; };
    set("gateLabel", result && result.label ? result.label : "—");
    set("gateOos", result && typeof result.oosTrades === "number" ? String(result.oosTrades) : "—");
    set("gateMeanR", result && typeof result.meanR === "number"
      ? (result.meanR >= 0 ? "+" : "") + result.meanR.toFixed(3) + "R" : "—");
    set("gateP", result && result.pValue != null && Number.isFinite(result.pValue) ? result.pValue.toFixed(4) : "—");
    set("gateStrat", result && result.strategy && result.strategy.name ? result.strategy.name : "—");
    var fill = el("proximityFill");
    var bar = el("proximityBar");
    var label = el("proximityLabel");
    var dot = el("proximityDot");
    var score = proximityScore(result, allowed);
    if (fill) {
      fill.style.width = score + "%";
      fill.classList.toggle("ok", allowed);
      fill.classList.toggle("warn", !allowed && score >= 40);
      fill.classList.toggle("bad", !allowed && score < 40);
    }
    if (bar) bar.setAttribute("aria-valuenow", String(score));
    if (label) {
      label.textContent = allowed
        ? "Porta aberta (evidência real) — confirmação PLAY ainda necessária"
        : result ? "NO TRADE · " + (result.reason || result.label || "") : "A aguardar análise / dados…";
    }
    if (dot) dot.className = "sem-dot " + (allowed ? "green" : score >= 40 ? "amber" : "red");
  }

  function setPrePlayUI(result) {
    var status = el("prePlayStatus");
    var metrics = el("prePlayMetrics");
    if (!status) return;
    status.classList.remove("open", "closed", "muted");
    if (!result) {
      status.classList.add("muted");
      status.textContent = "Escolhe Lucro rápido ou Loss zero — indicadores atualizam ao vivo.";
      if (metrics) metrics.hidden = true;
      return;
    }
    status.classList.add(result.allowed ? "open" : "closed");
    status.textContent = typeof NL.formatCandleGate === "function"
      ? NL.formatCandleGate(result)
      : (result.allowed ? "PORTA ABERTA — " + result.reason : "NO TRADE — " + result.reason);
    if (metrics) {
      metrics.hidden = false;
      el("prePlayResult").textContent = result.allowed ? "PORTA ABERTA" : "NO TRADE";
      el("prePlayLabel").textContent = result.label || "—";
      el("prePlayOos").textContent = String(result.oosTrades != null ? result.oosTrades : "—");
      el("prePlayMeanR").textContent = result.meanR != null
        ? (result.meanR >= 0 ? "+" : "") + Number(result.meanR).toFixed(3) + "R" : "—";
      el("prePlayP").textContent = result.pValue != null ? Number(result.pValue).toFixed(4) : "—";
      el("prePlayStrat").textContent = result.strategy && result.strategy.name ? result.strategy.name : "—";
    }
  }

  async function loadBybitTradingStatus() {
    try {
      var res = await fetch(BYBIT_STATUS_URL);
      var payload = await res.json().catch(function () { return null; });
      state.bybitKeysConfigured = !!(payload && payload.keysConfigured);
      state.bybitRealAvailable = !!(payload && payload.realAvailable);
      if (!(state.bybitKeysConfigured && state.bybitRealAvailable) && state.tradingMode === "REAL") {
        state.tradingMode = "PAPER";
        sessionStorage.setItem(TRADING_MODE_KEY, "PAPER");
      }
    } catch (_e) {
      state.bybitKeysConfigured = false;
      state.bybitRealAvailable = false;
      if (state.tradingMode === "REAL") {
        state.tradingMode = "PAPER";
        sessionStorage.setItem(TRADING_MODE_KEY, "PAPER");
      }
    }
    updateTradingModeUI();
  }

  async function loadBybitSymbols() {
    var res = await fetch(BYBIT_SYMBOLS_URL);
    var payload = await res.json().catch(function () { return null; });
    if (!res.ok) {
      var why = (payload && (payload.error_description || payload.error)) || ("HTTP " + res.status);
      throw new Error("Bybit símbolos: " + why);
    }
    if (!payload || !Array.isArray(payload.items)) throw new Error("Bybit símbolos: resposta inválida");
    state.bybitSymbolsAll = payload.items;
    if (typeof NL.sortBybitUsdtPreferred === "function") {
      state.bybitSymbolsAll = NL.sortBybitUsdtPreferred(state.bybitSymbolsAll);
    }
    state.bybitSymbols = state.bybitSymbolsAll.slice();
  }

  function renderBybitSymbolSelect() {
    var sel = el("bybitSymbolSelect");
    if (!sel) return;
    var items = state.bybitSymbols.slice();
    var prev = state.symbol;
    // Sticky: keep the live chart symbol visible even when the search filter excludes it.
    // Never mutate state.symbol here — that orphaned BTC chart while select showed ETH.
    if (prev && !items.some(function (it) { return it.symbol === prev; })) {
      var sticky = null;
      for (var s = 0; s < state.bybitSymbolsAll.length; s++) {
        if (state.bybitSymbolsAll[s].symbol === prev) { sticky = state.bybitSymbolsAll[s]; break; }
      }
      if (sticky) items = [sticky].concat(items);
    }
    sel.innerHTML = "";
    if (!items.length) {
      var o = document.createElement("option");
      o.value = ""; o.textContent = "Sem pares…";
      sel.appendChild(o);
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var opt = document.createElement("option");
      opt.value = it.symbol;
      opt.textContent = it.displayName || it.symbol;
      sel.appendChild(opt);
    }
    if (prev && items.some(function (it) { return it.symbol === prev; })) sel.value = prev;
    else sel.value = items[0].symbol;
  }

  function filterSymbols(q) {
    var query = String(q || "").trim().toUpperCase();
    if (!query) state.bybitSymbols = state.bybitSymbolsAll.slice();
    else {
      state.bybitSymbols = state.bybitSymbolsAll.filter(function (it) {
        return it.symbol.indexOf(query) >= 0 ||
          String(it.displayName || "").toUpperCase().indexOf(query) >= 0;
      });
    }
    renderBybitSymbolSelect();
  }

  function renderBybitBalance() {
    var usdtEl = el("bybitBalUsdt");
    var meta = el("bybitBalMeta");
    var err = el("bybitBalErr");
    var grid = el("bybitBalGrid");
    if (!usdtEl) return;
    if (state.bybitBalanceError) {
      usdtEl.textContent = "—";
      if (meta) meta.textContent = "Bybit: ainda em ligação";
      if (err) { err.hidden = false; err.textContent = state.bybitBalanceError; }
      var note = el("bybitLinkingNote");
      if (note) { note.hidden = false; note.textContent = "Bybit: ainda em ligação…"; }
      if (grid) grid.hidden = true;
      return;
    }
    var bal = state.bybitBalance;
    if (!bal) {
      usdtEl.textContent = "—";
      if (meta) meta.textContent = "A carregar saldo Bybit…";
      if (err) err.hidden = true;
      if (grid) grid.hidden = true;
      return;
    }
    if (err) err.hidden = true;
    var noteOk = el("bybitLinkingNote");
    if (noteOk) noteOk.hidden = true;
    usdtEl.textContent = formatUsdt(bal.usdtWalletBalance != null ? bal.usdtWalletBalance : bal.totalWalletBalance);
    if (meta) {
      meta.textContent = (bal.label || "REAL · Bybit UNIFIED") + " · equity " +
        formatUsdt(bal.usdtEquity != null ? bal.usdtEquity : bal.totalEquity);
    }
    if (grid) {
      grid.hidden = false;
      var set = function (id, val) { var n = el(id); if (n) n.textContent = val; };
      set("bybitBalEquity", formatUsdt(bal.totalEquity));
      set("bybitBalAvail", formatUsdt(bal.totalAvailableBalance));
      set("bybitBalUpl", formatUsdt(bal.totalPerpUPL));
      set("bybitBalType", bal.accountType || "UNIFIED");
    }
  }

  async function loadBybitBalance() {
    state.bybitBalanceError = null;
    renderBybitBalance();
    try {
      var res = await fetch(BYBIT_BALANCE_URL + "?coin=USDT");
      var payload = await res.json().catch(function () { return null; });
      if (!res.ok || !payload || payload.ok !== true) {
        var why = (payload && (payload.error_description || payload.error || payload.message)) || ("HTTP " + res.status);
        state.bybitBalance = null;
        state.bybitBalanceError = String(why);
        renderBybitBalance();
        return false;
      }
      state.bybitBalance = payload;
      state.bybitBalanceError = null;
      if (payload.keysConfigured) state.bybitKeysConfigured = true;
      renderBybitBalance();
      updateTradingModeUI();
      return true;
    } catch (e) {
      state.bybitBalance = null;
      state.bybitBalanceError = e.message || String(e);
      renderBybitBalance();
      return false;
    }
  }

  function renderBybitLeverageHint() {
    var hint = el("bybitLeverageHint");
    var input = el("bybitLeverage");
    var info = state.bybitLeverageInfo;
    if (!hint) return;
    if (!info) {
      hint.textContent = "Alavancagem: a carregar intervalo do par… Stake fixa (sem martingale).";
      return;
    }
    hint.textContent = info.symbol + ": alavancagem " + info.minLeverage + "×–" + info.maxLeverage +
      "× (passo " + info.leverageStep + "). Predefinição " + info.defaultLeverage +
      "×. Stake fixa em USDT — sem martingale.";
    if (input) {
      input.min = String(info.minLeverage);
      input.max = String(info.maxLeverage);
      input.step = String(info.leverageStep);
      var cur = Number(input.value);
      var clamped = typeof NL.clampBybitLeverage === "function"
        ? NL.clampBybitLeverage(cur || info.defaultLeverage, info) : info.defaultLeverage;
      input.value = String(clamped);
      state.bybitLeverage = clamped;
    }
  }

  async function loadBybitLeverage(symbol) {
    var sym = String(symbol || state.symbol || "").trim().toUpperCase();
    if (!sym) return false;
    try {
      var res = await fetch(BYBIT_LEVERAGE_URL + "?symbol=" + encodeURIComponent(sym));
      var payload = await res.json().catch(function () { return null; });
      if (!res.ok || !payload || payload.ok !== true) {
        state.bybitLeverageInfo = null;
        renderBybitLeverageHint();
        return false;
      }
      state.bybitLeverageInfo = payload;
      state.bybitLeverage = payload.defaultLeverage;
      renderBybitLeverageHint();
      return true;
    } catch (_e) {
      state.bybitLeverageInfo = null;
      renderBybitLeverageHint();
      return false;
    }
  }

  function updateTradingModeUI() {
    var paperEl = el("bybitModePaper");
    var realEl = el("bybitModeReal");
    var pill = el("modePill");
    var banner = el("modeBanner");
    var sub = el("sessionHeroSub");
    var actionHint = el("bybitActionHint");
    var realOn = isRealTradingMode();
    if (paperEl) {
      paperEl.classList.toggle("active", state.tradingMode !== "REAL");
      paperEl.setAttribute("aria-pressed", state.tradingMode !== "REAL" ? "true" : "false");
    }
    if (realEl) {
      var canReal = state.bybitKeysConfigured && state.bybitRealAvailable;
      realEl.disabled = !canReal;
      realEl.title = canReal
        ? "REAL: ordens Bybit Linear via servidor (porta + stake fixa + máx 3 h)"
        : "REAL bloqueado: faltam chaves no servidor";
      realEl.classList.toggle("active", state.tradingMode === "REAL" && canReal);
      realEl.setAttribute("aria-pressed", state.tradingMode === "REAL" && canReal ? "true" : "false");
    }
    if (pill) {
      pill.textContent = realOn ? "REAL · Bybit" : "PAPER · Bybit";
      pill.classList.toggle("warn", !realOn);
      pill.classList.toggle("real-live", realOn);
    }
    if (banner) {
      banner.textContent = realOn ? "REAL" : "PAPER";
      banner.className = "mode-banner " + (realOn ? "real" : "paper");
    }
    if (sub) {
      sub.textContent = realOn
        ? "Bybit REAL — ordens futures USDT com dinheiro."
        : "Bybit PAPER — simulado. Saldo acima = carteira real (só leitura).";
    }
    if (actionHint) {
      actionHint.textContent = realOn
        ? "REAL: PLAY envia ordens Bybit (porta + stake fixa + máx 3 h). Indicadores = evidência real."
        : "Indicadores ao vivo. PLAY = PAPER por omissão. REAL só com toggle + confirmação.";
    }
  }

  function setTradingMode(next) {
    var mode = String(next || "").toUpperCase() === "REAL" ? "REAL" : "PAPER";
    if (mode === "REAL" && !(state.bybitKeysConfigured && state.bybitRealAvailable)) {
      pushHistory("REAL indisponível: faltam chaves no servidor.", "stop");
      return false;
    }
    if (state.running) {
      pushHistory("Para a sessão antes de mudar PAPER/REAL.", "stop");
      return false;
    }
    if (mode === "REAL") {
      var ok = confirm("Ativar modo REAL?\n\nOrdens reais na Bybit.\nOK = REAL · Cancelar = PAPER");
      if (!ok) return false;
    }
    state.tradingMode = mode;
    sessionStorage.setItem(TRADING_MODE_KEY, mode);
    updateTradingModeUI();
    pushHistory("Modo = " + mode, mode === "REAL" ? "open" : "");
    return true;
  }

  function updateButtons() {
    var hasStrategy = !!(el("bybitStrategy") && el("bybitStrategy").value);
    var running = state.session && state.session.status === "RUNNING";
    var paused = state.session && state.session.status === "PAUSED";
    var gateOk = !!(state.prePlayOk && state.prePlayGate && state.prePlayGate.allowed);
    var live = state.strategySet ? state.liveProx[state.strategySet] : null;
    var atTarget = !!(live && live.atTarget);
    var btnA = el("btnBybitAnalyze");
    var btnP = el("btnBybitPlay");
    var btnPause = el("btnBybitPause");
    var btnStop = el("btnBybitStop");
    if (btnA) btnA.disabled = !hasStrategy || !!running;
    if (btnP) {
      btnP.disabled = !hasStrategy || (!!running && !paused);
      btnP.textContent = running ? "ARMADO neste ecrã" : paused ? "RETOMAR" : "ARMAR neste ecrã";
      btnP.title = !hasStrategy
        ? "Escolhe Lucro rápido ou Loss zero"
        : running
          ? "Sessão armada — entrada só com porta + sinal"
          : "ARMAR: vigia o alvo (porta + sinal). Sem entrada cega.";
      btnP.classList.toggle("gate-blocked", false);
    }
    if (btnPause) btnPause.disabled = !running;
    if (btnStop) btnStop.disabled = !(running || paused || state.session);
    var btnCloud = el("btnCloudArm");
    var btnCloudStop = el("btnCloudStop");
    var cloudRunning = !!(state.cloudJob && state.cloudJob.status === "RUNNING");
    if (btnCloud) btnCloud.disabled = !state.strategySet || cloudRunning || !state.symbol;
    if (btnCloudStop) btnCloudStop.disabled = !cloudRunning;
    var next = el("nextStepText");
    if (next) {
      if (running && state.session && state.session.hasOpenPosition) next.textContent = "ENTROU — posição aberta · PAUSE/STOP";
      else if (running) next.textContent = "ARMADO — à espera do alvo (porta + sinal) · futuros USDT";
      else if (paused) next.textContent = "Em pausa — RETOMAR ou STOP";
      else if (!hasStrategy) next.textContent = "1 Escolhe Lucro rápido ou Loss zero";
      else if (!gateOk) next.textContent = "2 Porta fechada (NO TRADE) — podes ARMAR; entrada só quando abrir + sinal";
      else if (!atTarget) next.textContent = "3 Porta aberta — ARMAR e espera o sinal no gráfico";
      else next.textContent = "4 Porta + alvo — ARMAR para entrar na próxima vela (manual)";
    }
    syncArmUi();
  }

  function setStats(summary) {
    var set = function (id, v) { var n = el(id); if (n) n.textContent = v; };
    set("statStatus", summary ? summary.status : "—");
    set("statPnl", summary ? signed(summary.totalPnl) + (isRealTradingMode() ? " (REAL)" : " (sim)") : "—");
    set("statTrades", summary ? String(summary.closed) + " / " + summary.opened : "—");
    set("statDd", summary ? summary.maxDrawdown.toFixed(2) : "—");
  }

  function readForm() {
    var strat = el("bybitStrategy");
    var stake = el("bybitStake");
    var lev = el("bybitLeverage");
    var mins = el("minutes");
    var iv = el("bybitInterval");
    // Symbol only via switchSymbol / boot — never orphan chart from select filter.
    if (strat) state.strategySet = strat.value || "";
    if (stake) state.stake = Number(stake.value) || 1;
    if (mins) state.minutes = Math.min(180, Math.max(1, Number(mins.value) || 60));
    if (iv) state.granularity = Number(iv.value) || 300;
    if (lev) {
      var info = state.bybitLeverageInfo;
      var v = Number(lev.value);
      if (info && typeof NL.clampBybitLeverage === "function") v = NL.clampBybitLeverage(v, info);
      state.bybitLeverage = v;
      lev.value = String(v);
    }
  }

  async function switchSymbol(sym, opts) {
    if (state.running) {
      pushHistory("Para a sessão antes de mudar o par. Sessão armada em " +
        (state.sessionSymbol || state.symbol) + ".", "stop");
      syncSymbolSelectToState();
      return;
    }
    var next = String(sym || "").trim().toUpperCase();
    if (!next) return;
    var force = opts && opts.force;
    if (next === state.symbol && !force) return;
    state.symbol = next;
    state.sessionSymbol = null; // never keep a prior arm pin across idle switches
    var sel = el("bybitSymbolSelect");
    if (sel) {
      if (![].some.call(sel.options, function (o) { return o.value === next; })) {
        filterSymbols("");
      }
      sel.value = next;
    }
    syncSymbolSelectToState();
    state.prePlayOk = false;
    state.prePlayGate = null;
    state.liveProx = { lucro_rapido: null, loss_zero: null };
    state.liveGates = { lucro_rapido: null, loss_zero: null };
    // Cancel in-flight heavy gate for previous symbol; radar continues in background
    gateEvalQueued = false;
    stopFeed();
    // Keep chart mounted — never destroy on symbol change; only resubscribe WS + reload klines.
    ensureChart(false);
    try { await loadBybitLeverage(state.symbol); } catch (_lev) {}
    await loadChartAndGates();
    renderRadarList();
    scheduleLiveProximity();
    syncArmUi();
    updateButtons();
  }

  async function switchInterval(gran) {
    if (state.running) {
      pushHistory("Para a sessão antes de mudar a vela.", "stop");
      var iv = el("bybitInterval");
      if (iv) iv.value = String(state.granularity);
      return;
    }
    var g = Number(gran) || 300;
    if (g === state.granularity) return;
    state.granularity = g;
    stopFeed();
    // Do NOT destroy/recreate chart — only update timescale + reload klines + resubscribe WS.
    ensureChart(false);
    if (state.chart) {
      try {
        state.chart.applyOptions({
          timeScale: { timeVisible: true, secondsVisible: state.granularity <= 60 },
        });
      } catch (_e) {}
    }
    await loadChartAndGates();
  }

  function onStrategyChange(preset) {
    if (state.running) {
      pushHistory("Para a sessão (STOP) antes de mudar a estratégia.", "stop");
      var sel = el("bybitStrategy");
      if (sel) sel.value = state.strategySet || "";
      return;
    }
    state.strategySet = preset || "";
    // Strategy-only: chart stays mounted, WS untouched, no kline reload.
    syncPlayReadyFromSelection();
    scheduleLiveProximity();
    // Soft gate for newly selected preset if missing (never blocks UI / chart).
    if (state.strategySet && !state.liveGates[state.strategySet] && state.gateCandles.length >= 100) {
      scheduleGateReeval();
    }
    syncArmUi();
    updateButtons();
  }

  function qtyFromFixedStake(stake, price) {
    var s = Number(stake);
    var px = Number(price);
    if (!Number.isFinite(s) || s < NL.MIN_STAKE) throw new Error("Stake mínima é " + NL.MIN_STAKE);
    if (!Number.isFinite(px) || px <= 0) throw new Error("Preço inválido para qty");
    var qty = s / px;
    var raw = qty.toFixed(8).replace(/\.?0+$/, "");
    if (!raw || Number(raw) <= 0) throw new Error("quantity resultante ≤ 0");
    return raw;
  }

  async function placeBybitOrder(side, quantity, opts) {
    opts = opts || {};
    var reduceOnly = opts.reduceOnly === true;
    if (!isRealTradingMode()) throw new Error("Ordens reais só em modo REAL");
    if (!reduceOnly && (!state.controller || !state.controller.isOpen)) {
      throw new Error("Porta de evidência fechada — NO TRADE");
    }
    var started = state.session && state.session.startedAtMs;
    var elapsed = typeof started === "number" ? Date.now() - started : 0;
    var sym = tradeSymbol();
    if (!sym || !/^[A-Z0-9]{2,20}USDT$/.test(sym)) {
      throw new Error("Símbolo de ordem inválido: " + (sym || "(vazio)"));
    }
    var body = {
      mode: "REAL", symbol: sym, side: side, quantity: quantity,
      stake: state.stake, evidenceAllowed: true, sessionElapsedMs: elapsed,
    };
    if (reduceOnly) body.reduceOnly = true;
    var res = await fetch(BYBIT_ORDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    var text = await res.text();
    var payload = null;
    try { payload = JSON.parse(text); } catch (_e) {}
    if (!res.ok) {
      var why = (payload && (payload.error_description || payload.msg || payload.error || payload.retMsg)) || ("HTTP " + res.status);
      throw new Error("Ordem Bybit: " + why);
    }
    return payload || text;
  }

  async function mirrorRealBybitEvent(e) {
    if (!isRealTradingMode()) return;
    if (e.type === "trade_opened") {
      var side = e.direction === 1 ? "BUY" : "SELL";
      var qty = qtyFromFixedStake(state.stake, e.entry);
      state.realOpenQty = qty;
      state.realOpenSide = side;
      try {
        var resp = await placeBybitOrder(side, qty);
        var oid = resp && ((resp.result && resp.result.orderId) || resp.orderId);
        pushHistory("REAL Bybit MARKET " + side + " " + tradeSymbol() + " qty=" + qty + (oid ? " orderId=" + oid : ""), "open");
      } catch (err) {
        pushHistory("REAL Bybit FALHA open: " + (err.message || String(err)), "stop");
      }
      return;
    }
    if (e.type === "trade_closed" && state.realOpenQty && state.realOpenSide) {
      var closeSide = state.realOpenSide === "BUY" ? "SELL" : "BUY";
      var q = state.realOpenQty;
      try {
        var resp2 = await placeBybitOrder(closeSide, q, { reduceOnly: true });
        var oid2 = resp2 && ((resp2.result && resp2.result.orderId) || resp2.orderId);
        pushHistory("REAL Bybit FECHA " + closeSide + " " + tradeSymbol() + " qty=" + q + " (reduceOnly)" + (oid2 ? " orderId=" + oid2 : ""),
          e.r >= 0 ? "close-win" : "close-loss");
      } catch (err2) {
        pushHistory("REAL Bybit FALHA close: " + (err2.message || String(err2)), "stop");
      }
      state.realOpenQty = null;
      state.realOpenSide = null;
    }
  }

  async function runAnalyze() {
    readForm();
    if (!state.strategySet) {
      pushHistory("Escolhe uma estratégia (Lucro rápido / Loss zero / …).", "stop");
      updateButtons();
      return null;
    }
    var btnA = el("btnBybitAnalyze");
    if (btnA) btnA.disabled = true;
    pushHistory("A reavaliar porta · " + state.strategySet + " · " + state.symbol + "…", "");
    try {
      if (!state.gateCandles.length || state.gateCandles.length < 1500) {
        state.gateCandles = await fetchBybitHistory(state.symbol, state.granularity, GATE_HISTORY);
      }
      await reevaluateBothGates();
      var result = state.liveGates[state.strategySet];
      pushHistory("Análise · " + state.strategySet + " · " +
        (result && result.allowed ? "PORTA ABERTA" : "NO TRADE") + " · " +
        (result ? result.reason : "sem resultado"),
        result && result.allowed ? "open" : "stop");
      return result;
    } catch (e) {
      pushHistory("Falha análise: " + (e.message || String(e)), "stop");
      return null;
    } finally {
      updateButtons();
    }
  }

  async function startSession() {
    readForm();
    // Select UI and trade symbol must agree — never arm BTC while UI shows ETH.
    assertSelectMatchesTradeSymbol();
    syncSymbolSelectToState();
    if (!state.symbol || !/^[A-Z0-9]{2,20}USDT$/.test(state.symbol)) {
      pushHistory("Escolhe um perpetual USDT válido antes de ARMAR.", "stop");
      return;
    }
    if (!state.strategySet) {
      pushHistory("Escolhe uma estratégia antes de ARMAR.", "stop");
      updateButtons();
      return;
    }
    if (state.stake < NL.MIN_STAKE) {
      pushHistory("Stake mínima é " + NL.MIN_STAKE, "stop");
      return;
    }
    if (state.session && state.session.status === "PAUSED") {
      var evs = state.session.start(Date.now());
      for (var i0 = 0; i0 < evs.length; i0++) pushHistory(NL.formatCandleEvent(evs[i0]), "open");
      setStats(state.session.summary());
      updateButtons();
      return;
    }
    if (state.running) return;

    // Ensure selected preset has a fresh gate (wiring: strategy → evaluateCandleGate → arm).
    if (!state.liveGates[state.strategySet] || state.gateCandles.length < 1500) {
      await reevaluateBothGates();
    } else if (!state.liveGates.lucro_rapido || !state.liveGates.loss_zero) {
      await reevaluateBothGates();
    }
    var pre = state.liveGates[state.strategySet];
    if (!pre && state.gateCandles.length >= 100) {
      try { pre = evaluatePreset(state.strategySet, state.gateCandles); state.liveGates[state.strategySet] = pre; }
      catch (_eg) { pre = null; }
    }
    state.prePlayGate = pre;
    state.prePlayOk = !!(pre && pre.allowed);
    if (!pre || !pre.allowed) {
      pushHistory("ARMAR com porta fechada — " + (pre ? pre.reason : "sem evidência") +
        " · sessão vigia; entrada só se a porta abrir E houver sinal (sem entrada cega).", "stop");
    } else {
      pushHistory("Porta aberta — ARMAR · à espera do sinal da estratégia no futuro USDT.", "open");
    }

    if (state.tradingMode === "REAL" && !(state.bybitKeysConfigured && state.bybitRealAvailable)) {
      pushHistory("REAL pediu-se mas chaves em falta — a forçar PAPER.", "stop");
      state.tradingMode = "PAPER";
      sessionStorage.setItem(TRADING_MODE_KEY, "PAPER");
      updateTradingModeUI();
    }

    state.realOpenQty = null;
    state.realOpenSide = null;
    // Freeze the pair for this session — REAL orders + candle poll use this, not a later select drift / BTC default.
    state.sessionSymbol = state.symbol;
    syncSymbolSelectToState();
    var btnP = el("btnBybitPlay");
    if (btnP) btnP.disabled = true;
    state.armState = "armed";
    pushHistory((isRealTradingMode() ? "REAL · Bybit futuros" : "PAPER · Bybit futuros") +
      " · ARMADO · " + state.sessionSymbol + " · " + state.strategySet, "open");

    try {
      var armSym = state.sessionSymbol;
      var history = state.gateCandles;
      if (!history.length || history.length < 1500) {
        history = await fetchBybitHistory(armSym, state.granularity, GATE_HISTORY);
        if (state.symbol !== armSym || state.sessionSymbol !== armSym) {
          pushHistory("Par mudou durante o armamento — abortado.", "stop");
          state.sessionSymbol = null;
          state.armState = "disarmed";
          state.running = false;
          updateButtons();
          return;
        }
        state.gateCandles = history;
      }
      var kind = NL.marketOf(armSym);
      var costFraction = kind && NL.MARKETS[kind] ? NL.MARKETS[kind].assumedCostFraction : 0.001;
      var n = history.length;
      var trainSize = Math.min(1000, Math.floor(n * 0.4));
      var testSize = Math.min(500, Math.floor(n * 0.2));
      var strategies = strategiesFor(state.strategySet);
      var gate = gateOptsForPreset(state.strategySet, costFraction, trainSize, testSize);
      var last = history[history.length - 1];

      state.controller = new NL.CandleGateController({
        strategies: strategies, gate: gate, revalidateEvery: state.revalidateEvery,
        maxBuffer: 3500, initial: history,
      });
      setGateUI(state.controller.result, state.controller.isOpen);

      state.session = new NL.CandlePaperSession({
        strategy: state.controller.asStrategy(),
        stake: state.stake, slAtr: gate.slAtr, tpR: gate.tpR, maxBars: gate.maxBars,
        costFraction: costFraction, maxLoss: state.stake * 10, maxTrades: 50,
        maxDurationMs: Math.min(state.minutes, 180) * 60 * 1000,
        maxConsecutiveLosses: 6, cooldownCandles: 0,
      });
      state.lastEpoch = last.epoch;
      state.running = true;
      var startEvs = state.session.start(last.epoch * 1000);
      for (var i1 = 0; i1 < startEvs.length; i1++) pushHistory(NL.formatCandleEvent(startEvs[i1]), "open");
      pushHistory("ARMADO " + armSym + " (futuro USDT) | stake fixa " + state.stake + " | lev " +
        state.bybitLeverage + "× | " + NL.formatCandleGate(state.controller.result) +
        " | entrada só com porta+sinal" +
        (isRealTradingMode() ? " | REAL" : " | PAPER — sem ordens reais"), "");
      setStats(state.session.summary());
      scheduleSessionPoll();
    } catch (e) {
      pushHistory("Erro ao iniciar: " + (e.message || String(e)), "stop");
      state.running = false;
    }
    updateButtons();
  }

  function pauseSession() {
    if (!state.session || state.session.status !== "RUNNING") return;
    var evs = state.session.pause(Date.now());
    for (var i = 0; i < evs.length; i++) pushHistory(NL.formatCandleEvent(evs[i]), "stop");
    setStats(state.session.summary());
    updateButtons();
  }

  function stopSession() {
    if (state.sessionPollTimer) { clearTimeout(state.sessionPollTimer); state.sessionPollTimer = null; }
    if (state.session && state.session.status !== "STOPPED") {
      var evs = state.session.stop(Date.now());
      for (var i = 0; i < evs.length; i++) pushHistory(NL.formatCandleEvent(evs[i]), "stop");
      if (typeof NL.formatCandleSummary === "function") {
        pushHistory(NL.formatCandleSummary(state.session.summary()).split("\n")[0], "stop");
      }
    }
    state.running = false;
    state.armState = "disarmed";
    state.sessionSymbol = null;
    syncSymbolSelectToState();
    setStats(state.session ? state.session.summary() : null);
    syncArmUi();
    updateButtons();
  }

  function scheduleSessionPoll() {
    if (state.sessionPollTimer) clearTimeout(state.sessionPollTimer);
    state.sessionPollTimer = setTimeout(sessionPollOnce, 15000);
  }

  async function sessionPollOnce() {
    if (!state.running || !state.session) return;
    if (state.session.status === "STOPPED" && !state.session.hasOpenPosition) {
      state.running = false; state.sessionSymbol = null; updateButtons(); return;
    }
    try {
      var candles = await fetchLatestBybitCandles(tradeSymbol(), state.granularity, 10);
      var fresh = candles.filter(function (c) { return c.epoch > state.lastEpoch; })
        .sort(function (a, b) { return a.epoch - b.epoch; });
      for (var i = 0; i < fresh.length; i++) {
        var c = fresh[i];
        state.lastEpoch = c.epoch;
        var changed = state.controller.push(c);
        if (changed) setGateUI(state.controller.result, state.controller.isOpen);
        var events = state.session.onCandle(c);
        for (var j = 0; j < events.length; j++) {
          var ev = events[j];
          var cls = "";
          if (ev.type === "trade_opened") { cls = "open"; state.armState = "entered"; }
          else if (ev.type === "trade_closed") cls = ev.r >= 0 ? "close-win" : "close-loss";
          else if (ev.type === "stopped" || ev.type === "paused") cls = "stop";
          pushHistory(NL.formatCandleEvent(ev), cls);
          if (isRealTradingMode() && (ev.type === "trade_opened" || ev.type === "trade_closed")) {
            await mirrorRealBybitEvent(ev);
          }
        }
        setGateUI(state.controller.result, state.controller.isOpen);
        setStats(state.session.summary());
      }
    } catch (e) {
      pushHistory("Aviso poll sessão: " + (e.message || String(e)), "stop");
    }
    if (state.session.status === "STOPPED" && !state.session.hasOpenPosition) {
      state.running = false; state.sessionSymbol = null; updateButtons(); return;
    }
    scheduleSessionPoll();
    updateButtons();
  }


  function syncArmUi() {
    var box = el("armBox");
    var title = el("armTitle");
    var reason = el("armReason");
    var fill = el("armFill");
    var bar = el("armBar");
    var pct = el("armPct");
    var dot = el("armDot");
    var pill = el("armPill");
    var preset = state.strategySet;
    var gate = preset ? state.liveGates[preset] : null;
    var live = preset ? state.liveProx[preset] : null;
    var running = !!(state.session && state.session.status === "RUNNING");
    var hasPos = !!(state.session && state.session.hasOpenPosition);
    var gateOk = !!(gate && gate.allowed);
    var atTarget = !!(live && live.atTarget);
    var gateSc = proximityScore(gate, gateOk);
    var combined = (typeof NL.combineGateAndLive === "function" && live)
      ? NL.combineGateAndLive(gateOk, gateSc, live)
      : { score: live ? live.proximityPct : gateSc, label: "—", ready: false };
    var score = combined.score;
    var mode = "disarmed";
    var titleTxt = "DESARMADO · co-piloto";
    var reasonTxt = "ARMAR para o co-piloto vigiar o alvo da estratégia no perpetual USDT. Entrada só com porta aberta + sinal. Sem martingale.";
    if (hasPos) {
      mode = "entered";
      titleTxt = "ENTROU";
      reasonTxt = "Posição aberta (sinal + porta). Stake fixa.";
      state.armState = "entered";
    } else if (running) {
      mode = "armed";
      var stratLabel = preset === "lucro_rapido" ? "Lucro rápido" : preset === "loss_zero" ? "Loss zero" : preset === "tendencia_diaria" ? "Tendência diária" : preset === "biblioteca" ? "Biblioteca" : (preset || "");
      var armPair = tradeSymbol() || state.symbol || "";
      titleTxt = "ARMADO · " + armPair + " · " + stratLabel + " — à espera do alvo";
      syncSymbolSelectToState();
      if (!gateOk) reasonTxt = "NO TRADE (porta) — " + (gate ? gate.reason : "sem evidência") + (live ? " · " + live.detail : "");
      else if (!atTarget) reasonTxt = "Porta aberta · co-piloto à espera do sinal · " + (live ? live.detail : "");
      else reasonTxt = "Porta aberta + alvo · entrada na abertura da próxima vela (PAPER/REAL)";
      state.armState = "armed";
    } else if (gateOk && atTarget) {
      mode = "disarmed";
      titleTxt = "PRONTO A ARMAR · porta aberta + alvo";
      reasonTxt = (live ? live.detail + " · " : "") + (gate ? gate.reason : "");
    } else if (!gateOk) {
      mode = "disarmed notrade";
      titleTxt = "DESARMADO · NO TRADE";
      reasonTxt = gate
        ? (typeof NL.formatCandleGate === "function" ? NL.formatCandleGate(gate) : gate.reason)
        : "Escolhe estratégia — indicadores ao vivo no gráfico.";
    }
    if (box) {
      box.className = "arm-box " + mode;
    }
    if (title) title.textContent = titleTxt;
    if (reason) reason.textContent = reasonTxt;
    if (fill) {
      fill.style.width = score + "%";
      fill.classList.toggle("ok", mode === "entered" || (gateOk && atTarget));
      fill.classList.toggle("warn", score >= 40 && mode !== "entered");
      fill.classList.toggle("bad", score < 40);
    }
    if (bar) bar.setAttribute("aria-valuenow", String(score));
    if (pct) pct.textContent = score + "%";
    if (dot) {
      dot.className = "sem-dot " + (mode === "entered" ? "green" : mode.indexOf("armed") >= 0 ? "amber" : score >= 55 ? "amber" : "red");
    }
    if (pill) {
      if (mode === "entered") { pill.className = "pill arm-in"; pill.textContent = "ENTROU"; }
      else if (running) { pill.className = "pill arm-on"; pill.textContent = "ARMADO"; }
      else { pill.className = "pill warn"; pill.textContent = "DESARMADO"; }
    }
  }

  async function pushClosedCandleToSession(c) {
    if (!state.running || !state.session || !state.controller) return;
    // Refuse candles if armed pair drifted from live feed symbol.
    if (state.sessionSymbol && state.symbol && state.sessionSymbol !== state.symbol) {
      pushHistory("Par da sessão (" + state.sessionSymbol + ") ≠ UI (" + state.symbol + ") — a repor select.", "stop");
      state.symbol = state.sessionSymbol;
      syncSymbolSelectToState();
    }
    if (!(c.epoch > state.lastEpoch)) return;
    state.lastEpoch = c.epoch;
    try {
      var changed = state.controller.push(c);
      if (changed) setGateUI(state.controller.result, state.controller.isOpen);
      var events = state.session.onCandle(c);
      for (var j = 0; j < events.length; j++) {
        var ev = events[j];
        var cls = "";
        if (ev.type === "trade_opened") { cls = "open"; state.armState = "entered"; }
        else if (ev.type === "trade_closed") cls = ev.r >= 0 ? "close-win" : "close-loss";
        else if (ev.type === "stopped" || ev.type === "paused") cls = "stop";
        pushHistory(NL.formatCandleEvent(ev), cls);
        if (isRealTradingMode() && (ev.type === "trade_opened" || ev.type === "trade_closed")) {
          await mirrorRealBybitEvent(ev);
        }
      }
      setGateUI(state.controller.result, state.controller.isOpen);
      setStats(state.session.summary());
      syncArmUi();
      updateButtons();
      if (state.session.status === "STOPPED" && !state.session.hasOpenPosition) {
        state.running = false;
        state.armState = "disarmed";
        state.sessionSymbol = null;
        updateButtons();
      }
    } catch (e) {
      pushHistory("Aviso vela sessão: " + (e.message || String(e)), "stop");
    }
  }

  /* —— Radar: batched, cancelable, nunca bloqueia o gráfico —— */
  function radarStrategies(presetId) {
    return strategiesRaw(presetId || state.radar.preset || "lucro_rapido");
  }

  function renderRadarList() {
    var box = el("radarList");
    var meta = el("radarMeta");
    var st = el("radarStatus");
    if (!box) return;
    var filter = String(state.radar.filter || "").trim().toUpperCase();
    var rows = Object.keys(state.radar.rows).map(function (sym) { return state.radar.rows[sym]; });
    rows.sort(function (a, b) { return (b.proximityPct || 0) - (a.proximityPct || 0); });
    if (filter) {
      rows = rows.filter(function (r) {
        return r.symbol.indexOf(filter) >= 0 || String(r.displayName || "").toUpperCase().indexOf(filter) >= 0;
      });
    }
    var top = rows.slice(0, 80);
    if (!top.length) {
      box.innerHTML = '<div class="radar-empty">Ainda sem scores — scan em curso (só futuros Linear USDT).</div>';
    } else {
      box.innerHTML = top.map(function (r) {
        var pctN = Math.round(r.proximityPct || 0);
        var near = !r.atTarget && pctN >= 55;
        var hot = r.atTarget || pctN >= 70 ? "hot" : near ? "warm near-target" : pctN >= 45 ? "warm" : "";
        var active = r.symbol === state.symbol ? " active" : "";
        var bias = r.bias === "long" ? "long" : r.bias === "short" ? "short" : "";
        var biasLabel = r.atTarget ? "ALVO" : near ? "quase" : (r.bias || "—");
        var nearTag = near ? '<span class="tag-near">quase no alvo</span>' : "";
        return '<div class="radar-row ' + hot + active + '" role="listitem" data-symbol="' + escapeHtml(r.symbol) + '">' +
          '<span class="sym">' + escapeHtml(r.symbol.replace(/USDT$/, "")) + '<small style="opacity:.55">USDT</small>' + nearTag + "</span>" +
          '<span class="bias ' + bias + '">' + biasLabel + "</span>" +
          '<span class="pct">' + pctN + "%</span></div>";
      }).join("");
      box.querySelectorAll(".radar-row").forEach(function (row) {
        row.addEventListener("click", function () {
          var sym = row.getAttribute("data-symbol");
          if (!sym) return;
          // Same path as select: unsubscribe old WS, load klines, paint, live prox.
          switchSymbol(sym);
        });
      });
    }
    var cov = state.radar.scanned + "/" + state.radar.total;
    if (meta) {
      meta.textContent = "Scan " + cov + " perpetuals · preset " +
        (state.radar.preset === "loss_zero" ? "Loss zero" : "Lucro rápido") +
        (state.radar.paused ? " · PAUSADO" : " · em fundo") +
        " · ranks só com dados reais";
    }
    if (st) {
      st.className = "pill " + (state.radar.paused ? "warn" : state.radar.scanned > 0 ? "live-ok" : "warn");
      st.textContent = state.radar.paused ? "Pausado" : ("Scan " + cov);
    }
  }

  function cancelRadar() {
    state.radar.gen += 1;
    if (state.radar.timer) { clearTimeout(state.radar.timer); state.radar.timer = null; }
  }

  function startRadarScan() {
    cancelRadar();
    var gen = state.radar.gen;
    state.radar.total = state.bybitSymbolsAll.length;
    state.radar.scanned = Object.keys(state.radar.rows).length;
    state.radar.cursor = state.radar.cursor % Math.max(1, state.radar.total);
    renderRadarList();

    async function tick() {
      if (gen !== state.radar.gen) return;
      if (state.radar.paused) {
        state.radar.timer = setTimeout(tick, 800);
        return;
      }
      var all = state.bybitSymbolsAll;
      if (!all.length) {
        state.radar.timer = setTimeout(tick, 2000);
        return;
      }
      var batch = [];
      for (var n = 0; n < RADAR_BATCH && n < all.length; n++) {
        var idx = (state.radar.cursor + n) % all.length;
        batch.push(all[idx]);
      }
      state.radar.cursor = (state.radar.cursor + batch.length) % all.length;
      var preset = state.radar.preset || "lucro_rapido";
      var strats = radarStrategies(preset);
      for (var i = 0; i < batch.length; i++) {
        if (gen !== state.radar.gen) return;
        var it = batch[i];
        try {
          var candles = await fetchKlinesRaw(it.symbol, state.granularity, RADAR_KLINES);
          if (gen !== state.radar.gen) return;
          var closed = closedOnly(candles, state.granularity);
          var live = typeof NL.evaluateLiveEntry === "function"
            ? NL.evaluateLiveEntry(closed.slice(-RADAR_KLINES), strats, { hold: 3 })
            : { proximityPct: 0, bias: "neutral", atTarget: false };
          state.radar.rows[it.symbol] = {
            symbol: it.symbol,
            displayName: it.displayName,
            proximityPct: live.proximityPct || 0,
            bias: live.bias || "neutral",
            atTarget: !!live.atTarget,
            detail: live.detail || "",
            preset: preset,
            at: Date.now(),
          };
        } catch (_e) {
          // soft-fail one symbol
        }
        await yieldToUi(RADAR_IDLE_MS);
      }
      // recount scanned
      var keys = Object.keys(state.radar.rows).filter(function (k) { return k !== "_seen"; });
      state.radar.scanned = keys.length;
      renderRadarList();
      if (gen !== state.radar.gen) return;
      state.radar.timer = setTimeout(tick, RADAR_GAP_MS);
    }
    state.radar.timer = setTimeout(tick, 300);
  }


  function cloudClientId() {
    try {
      var id = localStorage.getItem(CLOUD_ARM_CLIENT_KEY);
      if (id && /^[a-zA-Z0-9_-]{8,64}$/.test(id)) return id;
      id = "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(CLOUD_ARM_CLIENT_KEY, id);
      return id;
    } catch (_e) {
      return "c_anon_" + String(Date.now());
    }
  }

  function rememberCloudJobId(id) {
    try {
      if (id) localStorage.setItem(CLOUD_ARM_JOB_KEY, id);
      else localStorage.removeItem(CLOUD_ARM_JOB_KEY);
    } catch (_e) {}
  }

  function rememberedCloudJobId() {
    try { return localStorage.getItem(CLOUD_ARM_JOB_KEY) || ""; } catch (_e) { return ""; }
  }

  function formatRemain(ms) {
    if (!(ms > 0)) return "0m";
    var m = Math.ceil(ms / 60000);
    if (m >= 60) return Math.floor(m / 60) + "h " + (m % 60) + "m";
    return m + "m";
  }

  function renderCloudArmBox(job, store) {
    var box = el("cloudArmBox");
    var title = el("cloudArmTitle");
    var pill = el("cloudArmPill");
    var reason = el("cloudArmReason");
    var meta = el("cloudArmMeta");
    if (!box) return;
    state.cloudJob = job || null;
    if (!job) {
      box.hidden = true;
      updateButtons();
      return;
    }
    box.hidden = false;
    var st = job.status || "—";
    if (title) title.textContent = "Nuvem · " + job.symbol + " · " + (job.strategyPreset || "");
    if (pill) {
      pill.textContent = st + " · PAPER";
      pill.className = "pill " + (st === "RUNNING" ? "live-ok" : st === "CANCELLED" ? "warn" : "live-poll");
    }
    var sum = job.summary || {};
    var gate = job.gate;
    var lines = [];
    if (st === "RUNNING") {
      lines.push("Armado na nuvem — podes sair. Resta " + formatRemain(job.remainingMs || (job.endsAt - Date.now())) + ".");
    } else if (st === "CANCELLED") {
      lines.push("Cancelado na nuvem.");
    } else {
      lines.push("Terminou" + (job.stopReason ? " (" + job.stopReason + ")" : "") + ".");
    }
    if (gate) {
      lines.push(gate.allowed ? ("Porta: aberta — " + (gate.reason || "")) : ("Porta: NO TRADE — " + (gate.reason || "")));
    }
    if (reason) reason.textContent = lines.join(" ");
    if (meta) {
      meta.textContent = "Ops " + (sum.closed || 0) + "/" + (sum.opened || 0) +
        " · PnL " + signed(sum.totalPnl || 0) +
        " · Queda " + Number(sum.maxDrawdown || 0).toFixed(2) +
        (sum.hasOpenPosition ? " · posição aberta" : "") +
        (store && store.backend ? " · store " + store.backend : "");
    }
    updateButtons();
  }

  async function refreshCloudArmStatus() {
    var id = (state.cloudJob && state.cloudJob.id) || rememberedCloudJobId();
    if (!id) {
      // list latest for this client
      try {
        var resL = await fetch(BYBIT_ARM_JOBS_URL + "?clientId=" + encodeURIComponent(cloudClientId()));
        var dataL = await resL.json();
        if (dataL && dataL.jobs && dataL.jobs.length) {
          var latest = dataL.jobs[0];
          rememberCloudJobId(latest.id);
          renderCloudArmBox(latest, dataL.store);
          if (latest.status === "RUNNING") scheduleCloudPoll();
        }
      } catch (_e) {}
      return;
    }
    try {
      var res = await fetch(BYBIT_ARM_JOBS_URL + "?id=" + encodeURIComponent(id) +
        "&clientId=" + encodeURIComponent(cloudClientId()));
      var data = await res.json();
      if (!res.ok || !data.job) {
        if (res.status === 404) rememberCloudJobId("");
        return;
      }
      renderCloudArmBox(data.job, data.store);
      if (data.store && data.store.warning && data.job.status === "RUNNING") {
        pushHistory("Nuvem store: " + data.store.warning, "stop");
      }
      if (data.job.status === "RUNNING") scheduleCloudPoll();
      else if (state.cloudPollTimer) { clearTimeout(state.cloudPollTimer); state.cloudPollTimer = null; }
    } catch (e) {
      pushHistory("Nuvem status: " + (e.message || String(e)), "stop");
    }
  }

  function scheduleCloudPoll() {
    if (state.cloudPollTimer) clearTimeout(state.cloudPollTimer);
    state.cloudPollTimer = setTimeout(function () {
      state.cloudPollTimer = null;
      refreshCloudArmStatus();
    }, 60000);
  }

  async function startCloudArm() {
    readForm();
    assertSelectMatchesTradeSymbol();
    if (!state.symbol || !/^[A-Z0-9]{2,20}USDT$/.test(state.symbol)) {
      pushHistory("Escolhe um perpetual USDT antes de armar na nuvem.", "stop");
      return;
    }
    if (!state.strategySet) {
      pushHistory("Escolhe uma estratégia antes de armar na nuvem.", "stop");
      return;
    }
    if (state.stake < NL.MIN_STAKE) {
      pushHistory("Stake mínima é " + NL.MIN_STAKE, "stop");
      return;
    }
    var mins = Math.min(180, Math.max(1, Number(state.minutes) || 60));
    var btn = el("btnCloudArm");
    if (btn) btn.disabled = true;
    pushHistory("A armar na nuvem (PAPER) · " + state.symbol + " · " + state.strategySet + " · " + mins + " min…", "");
    try {
      var res = await fetch(BYBIT_ARM_JOBS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: state.symbol,
          strategyPreset: state.strategySet,
          stake: state.stake,
          leverage: state.bybitLeverage || 1,
          granularity: state.granularity,
          durationMinutes: mins,
          clientId: cloudClientId(),
          mode: "PAPER",
        }),
      });
      var data = await res.json();
      if (!res.ok || !data.job) throw new Error(data.error || ("HTTP " + res.status));
      rememberCloudJobId(data.job.id);
      renderCloudArmBox(data.job, data.store);
      pushHistory("Nuvem PAPER armada · " + data.job.symbol + " até " +
        new Date(data.job.endsAt).toLocaleTimeString("pt-PT") +
        " — podes sair da página.", "open");
      if (data.store && !data.store.durable) {
        pushHistory("Aviso: store em memória no servidor — configura Upstash Redis para jobs duráveis entre instâncias.", "stop");
      }
      scheduleCloudPoll();
    } catch (e) {
      pushHistory("Falha a armar na nuvem: " + (e.message || String(e)), "stop");
    }
    updateButtons();
  }

  async function stopCloudArm() {
    var id = (state.cloudJob && state.cloudJob.id) || rememberedCloudJobId();
    if (!id) return;
    try {
      var res = await fetch(BYBIT_ARM_JOBS_URL + "?id=" + encodeURIComponent(id) +
        "&clientId=" + encodeURIComponent(cloudClientId()), { method: "DELETE" });
      var data = await res.json();
      if (!res.ok || !data.job) throw new Error(data.error || ("HTTP " + res.status));
      renderCloudArmBox(data.job, data.store);
      pushHistory("Nuvem: STOP pedido.", "stop");
      if (state.cloudPollTimer) { clearTimeout(state.cloudPollTimer); state.cloudPollTimer = null; }
    } catch (e) {
      pushHistory("Falha STOP nuvem: " + (e.message || String(e)), "stop");
    }
    updateButtons();
  }


  function bind() {
    var btnBal = el("btnBybitRefreshBal");
    if (btnBal) btnBal.addEventListener("click", function () { loadBybitBalance(); });
    var search = el("bybitSymbolSearch");
    if (search) {
      search.addEventListener("input", function () { filterSymbols(search.value); });
      search.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        var pick = el("bybitSymbolSelect");
        if (pick && pick.value) switchSymbol(pick.value);
      });
    }
    var bybitSym = el("bybitSymbolSelect");
    if (bybitSym) {
      bybitSym.addEventListener("change", function () { switchSymbol(bybitSym.value); });
    }
    var iv = el("bybitInterval");
    if (iv) iv.addEventListener("change", function () { switchInterval(iv.value); });
    var bybitStrat = el("bybitStrategy");
    if (bybitStrat) {
      bybitStrat.addEventListener("change", function () {
        onStrategyChange(bybitStrat.value || "");
      });
    }
    ["cardLucroRapido", "cardLossZero"].forEach(function (id) {
      var card = el(id);
      if (!card) return;
      card.style.cursor = "pointer";
      card.addEventListener("click", function () {
        var preset = card.getAttribute("data-preset");
        var sel = el("bybitStrategy");
        if (sel && preset) {
          sel.value = preset;
          onStrategyChange(preset);
        }
      });
    });
    var bybitStake = el("bybitStake");
    if (bybitStake) bybitStake.addEventListener("change", function () { state.stake = Number(bybitStake.value) || 1; });
    var bybitLev = el("bybitLeverage");
    if (bybitLev) bybitLev.addEventListener("change", function () { readForm(); });
    var btnA = el("btnBybitAnalyze");
    if (btnA) btnA.addEventListener("click", function () { runAnalyze(); });
    var btnP = el("btnBybitPlay");
    if (btnP) btnP.addEventListener("click", function () { startSession(); });
    var btnCloud = el("btnCloudArm");
    if (btnCloud) btnCloud.addEventListener("click", function () { startCloudArm(); });
    var btnCloudStop = el("btnCloudStop");
    if (btnCloudStop) btnCloudStop.addEventListener("click", function () { stopCloudArm(); });
    var btnPause = el("btnBybitPause");
    if (btnPause) btnPause.addEventListener("click", function () { pauseSession(); });
    var btnStop = el("btnBybitStop");
    if (btnStop) btnStop.addEventListener("click", function () { stopSession(); });
    var modePaper = el("bybitModePaper");
    var modeReal = el("bybitModeReal");
    if (modePaper) modePaper.addEventListener("click", function () { setTradingMode("PAPER"); });
    if (modeReal) modeReal.addEventListener("click", function () { setTradingMode("REAL"); });
    var btnClear = el("btnClearLog");
    if (btnClear) btnClear.addEventListener("click", function () { state.historyLines = []; renderHistory(); });
    var radarSearch = el("radarSearch");
    if (radarSearch) radarSearch.addEventListener("input", function () {
      state.radar.filter = radarSearch.value || "";
      renderRadarList();
    });
    var radarPreset = el("radarPreset");
    if (radarPreset) radarPreset.addEventListener("change", function () {
      state.radar.preset = radarPreset.value || "lucro_rapido";
      state.radar.rows = {};
      state.radar.scanned = 0;
      startRadarScan();
    });
    var btnRadarPause = el("btnRadarPause");
    if (btnRadarPause) btnRadarPause.addEventListener("click", function () {
      state.radar.paused = !state.radar.paused;
      btnRadarPause.textContent = state.radar.paused ? "Retomar" : "Pausar";
      renderRadarList();
    });
    var btnGateToggle = el("btnGateToggle");
    if (btnGateToggle) {
      btnGateToggle.addEventListener("click", function () {
        var m = el("gateMetrics");
        if (!m) return;
        var open = m.hasAttribute("hidden");
        if (open) m.removeAttribute("hidden"); else m.setAttribute("hidden", "");
        btnGateToggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
    }
  }

  async function boot() {
    if (!token) { showLoginGate(); return; }
    showApp();
    bind();
    ensureChart(false);
    setStats(null);
    setGateUI(null, false);
    updateTradingModeUI();
    updateButtons();
    pushHistory("Bybit page · sessão Deriv OK · a carregar…", "");
    await loadBybitTradingStatus();
    try {
      await loadBybitSymbols();
      renderBybitSymbolSelect();
      var bootSel = el("bybitSymbolSelect");
      if (bootSel && bootSel.value) state.symbol = bootSel.value;
      pushHistory("Futuros Linear USDT: " + state.bybitSymbolsAll.length + " perpetuals (sem spot/inverse)", "open");
      state.radar.total = state.bybitSymbolsAll.length;
      startRadarScan();
    } catch (e) {
      pushHistory("Símbolos: " + (e.message || String(e)), "stop");
      var note = el("bybitLinkingNote");
      if (note) { note.hidden = false; note.textContent = "Bybit: ainda em ligação…"; }
    }
    await loadBybitBalance();
    await loadBybitLeverage(state.symbol);
    await loadChartAndGates();
    scheduleLiveProximity();
    syncArmUi();
    updateButtons();
    try { await refreshCloudArmStatus(); } catch (_c) {}
  }

  boot();
})();
