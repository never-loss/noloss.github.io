import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CandleGateController } from "../src/core/candle-gate.ts";
import { strategiesForPreset } from "../src/core/strategies.ts";
import { feasible } from "../src/core/feasible.ts";
import { evaluateLiveEntry } from "../src/core/strategy-live.ts";
import type { Candle } from "../src/core/market-data.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bybitJs = readFileSync(join(root, "public/assets/bybit.js"), "utf8");
const bybitHtml = readFileSync(join(root, "public/bybit.html"), "utf8");
const bybitCss = readFileSync(join(root, "public/assets/bybit.css"), "utf8");
const dashboardCss = readFileSync(join(root, "public/assets/dashboard.css"), "utf8");

test("chart: ensureChart mounts once; strategy change never destroys", () => {
  assert.match(bybitJs, /function ensureChart\(/);
  assert.match(bybitJs, /function onStrategyChange\(/);
  assert.match(bybitJs, /Strategy-only: chart stays mounted/);
  const switchInterval = bybitJs.slice(
    bybitJs.indexOf("async function switchInterval"),
    bybitJs.indexOf("function qtyFromFixedStake"),
  );
  assert.doesNotMatch(switchInterval, /destroyChart\(\)/);
  assert.doesNotMatch(switchInterval, /ensureChart\(true\)/);
  assert.match(switchInterval, /ensureChart\(false\)/);
  assert.match(switchInterval, /loadChartAndGates/);
});

test("chart: loadGen race guard + paint after klines", () => {
  assert.match(bybitJs, /loadGen/);
  assert.match(bybitJs, /gen !== state\.loadGen/);
  assert.match(bybitJs, /paintChartFromState\(true\)/);
});

test("WS only resubscribes on symbol/interval; strategy path clean", () => {
  assert.match(bybitJs, /feedGen/);
  const onStrat = bybitJs.slice(
    bybitJs.indexOf("function onStrategyChange"),
    bybitJs.indexOf("function qtyFromFixedStake"),
  );
  assert.doesNotMatch(onStrat, /startWsFeed/);
  assert.doesNotMatch(onStrat, /stopFeed/);
  assert.doesNotMatch(onStrat, /loadChartAndGates/);
});

test("UI: compact action row + elite co-piloto craft", () => {
  assert.match(bybitHtml, /btn-row-actions/);
  assert.match(bybitHtml, /Co-piloto/);
  assert.match(bybitCss, /btn-row-actions/);
  assert.match(bybitCss, /chart-empty\[hidden\]/);
  assert.match(bybitCss, /near-target/);
});

test("CSS regression: deck has no rotateX — desktop click hit-testing", () => {
  // Decorative 3D tilt (perspective + rotateX) broke desktop button clicks;
  // mobile forced transform:none. Flat layout is required for all worlds.
  assert.doesNotMatch(dashboardCss, /rotateX\(1deg\)/);
  assert.match(dashboardCss, /\.deck\s*\{[\s\S]*?transform:\s*none/);
  assert.match(dashboardCss, /perspective:\s*none/);
  assert.match(dashboardCss, /transform-style:\s*flat/);
  assert.match(bybitCss, /chart-empty\[hidden\]/);
  assert.match(bybitCss, /pointer-events:\s*none/);
  assert.match(bybitCss, /\.bybit-chart-wrap[\s\S]*?overflow:\s*hidden/);
});

test("wiring: arm path uses controller.asStrategy + selected preset", () => {
  assert.match(bybitJs, /new NL\.CandleGateController/);
  assert.match(bybitJs, /controller\.asStrategy\(\)/);
  assert.match(bybitJs, /strategiesFor\(state\.strategySet\)/);
  assert.match(bybitJs, /NL\.CandlePaperSession/);
  assert.match(bybitJs, /pushClosedCandleToSession/);
});

function synth(n: number): Candle[] {
  const out: Candle[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const open = px;
    const close = px + Math.sin(i / 9) * 0.8;
    out.push({
      epoch: 1_700_000_000 + i * 300,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
    });
    px = close;
  }
  return out;
}

test("wiring proof: each preset → strategies → gate controller → asStrategy", () => {
  const candles = synth(1800);
  for (const id of ["lucro_rapido", "loss_zero", "blitz_zero", "tendencia_diaria", "biblioteca"] as const) {
    const raw = strategiesForPreset(id);
    assert.ok(raw.length > 0, id);
    const strategies = raw.map((s) => feasible(s, { slAtr: 1.5, maxStopFraction: 0.01 }));
    const controller = new CandleGateController({
      strategies,
      gate: {
        slAtr: 1.5,
        tpR: 2,
        maxBars: 24,
        costFraction: 0.001,
        trainSize: 700,
        testSize: 350,
        minLabel: id === "loss_zero" ? "EVIDENCE" : id === "blitz_zero" ? "AGILE" : "PRELIMINARY",
      },
      revalidateEvery: 12,
      maxBuffer: 3500,
      initial: candles,
      confirmations: 1,
    });
    const gated = controller.asStrategy();
    const sigs = gated.signals(candles.slice(-200));
    assert.equal(sigs.length, 200);
    const live = evaluateLiveEntry(candles.slice(-160), raw, { hold: 3 });
    assert.ok(live.proximityPct >= 0 && live.proximityPct <= 100);
  }
});

test("PAPER default + no martingale in bybit page", () => {
  assert.match(bybitJs, /PAPER/);
  assert.doesNotMatch(bybitJs, /doubleStake|stake\s*\*\s*2|martingale\s*=\s*true/i);
  assert.match(bybitJs, /sem martingale/i);
  assert.match(bybitHtml, /sem martingale/i);
});

test("multi-symbol: select/filter never orphans chart on BTC", () => {
  assert.match(bybitJs, /Sticky: keep the live chart symbol/);
  assert.match(bybitJs, /Never mutate state\.symbol here/);
  assert.match(bybitJs, /async function switchSymbol\(sym, opts\)/);
  assert.match(bybitJs, /Drop previous symbol candles immediately/);
  assert.match(bybitJs, /Fast path: chart \+ WS first/);
  assert.match(bybitJs, /applySeriesPriceFormat/);
  assert.match(bybitJs, /op: "unsubscribe"/);
  // renderBybitSymbolSelect must NOT assign state.symbol = sel.value
  const renderFn = bybitJs.slice(
    bybitJs.indexOf("function renderBybitSymbolSelect"),
    bybitJs.indexOf("function filterSymbols"),
  );
  assert.doesNotMatch(renderFn, /state\.symbol\s*=\s*sel\.value/);
  // switchSymbol owns symbol + reloads chart/WS
  const switchFn = bybitJs.slice(
    bybitJs.indexOf("async function switchSymbol"),
    bybitJs.indexOf("async function switchInterval"),
  );
  assert.match(switchFn, /loadChartAndGates/);
  assert.match(switchFn, /stopFeed/);
  assert.match(switchFn, /loadBybitLeverage/);
  // radar click uses same switchSymbol path
  assert.match(bybitJs, /Same path as select: unsubscribe old WS/);
  // readForm must not steal symbol from filtered select
  const readFn = bybitJs.slice(
    bybitJs.indexOf("function readForm"),
    bybitJs.indexOf("async function switchSymbol"),
  );
  assert.doesNotMatch(readFn, /state\.symbol\s*=\s*sym\.value/);
});

test("multi-symbol: loadChartAndGates paints before GATE_HISTORY", () => {
  const loadFn = bybitJs.slice(
    bybitJs.indexOf("async function loadChartAndGates"),
    bybitJs.indexOf("function startGateTimer"),
  );
  const paintIdx = loadFn.indexOf("paintChartFromState(true)");
  const gateHistIdx = loadFn.indexOf("fetchBybitHistory");
  const wsIdx = loadFn.indexOf("startWsFeed()");
  assert.ok(paintIdx > 0 && wsIdx > 0 && gateHistIdx > 0);
  assert.ok(paintIdx < gateHistIdx, "chart paint before heavy history");
  assert.ok(wsIdx < gateHistIdx, "WS before heavy history");
  assert.match(loadFn, /fetchKlinesRaw\(sym, gran, CHART_HISTORY\)/);
});

test("trade path: sessionSymbol pinned; REAL order uses tradeSymbol()", () => {
  assert.match(bybitJs, /sessionSymbol/);
  assert.match(bybitJs, /function tradeSymbol\(/);
  assert.match(bybitJs, /state\.sessionSymbol = state\.symbol/);
  assert.match(bybitJs, /Freeze the pair for this session/);
  const place = bybitJs.slice(
    bybitJs.indexOf("async function placeBybitOrder"),
    bybitJs.indexOf("async function mirrorRealBybitEvent"),
  );
  assert.match(place, /tradeSymbol\(\)/);
  assert.doesNotMatch(place, /symbol:\s*state\.symbol/);
  assert.match(place, /symbol:\s*sym/);
  // startSession asserts select mirrors state before arm
  const start = bybitJs.slice(
    bybitJs.indexOf("async function startSession"),
    bybitJs.indexOf("function pauseSession"),
  );
  assert.match(start, /assertSelectMatchesTradeSymbol/);
  assert.match(start, /sessionSymbol/);
  assert.match(start, /fetchBybitHistory\(armSym/);
  // switch while running: stopSession (clear pin) then load the new pair
  const sw = bybitJs.slice(
    bybitJs.indexOf("async function switchSymbol"),
    bybitJs.indexOf("async function switchInterval"),
  );
  assert.match(sw, /syncSymbolSelectToState/);
  assert.match(sw, /stopSession\(\)/);
  assert.match(sw, /parada para mudar/);
  // arm failure must not leave a stale pin while idle
  const startCatch = start.slice(start.lastIndexOf("catch"));
  assert.match(startCatch, /sessionSymbol = null/);
  assert.match(startCatch, /armState = "disarmed"/);
});

test("chart light: CHART_HISTORY 96 + clear series on symbol load", () => {
  assert.match(bybitJs, /CHART_HISTORY = 96/);
  assert.match(bybitJs, /wsProxTick/);
  assert.match(bybitJs, /setData\(\[\]\)/);
});

test("multi-symbol: switchSymbol reloads chart for arbitrary Linear USDT (not only BTC)", () => {
  const switchFn = bybitJs.slice(
    bybitJs.indexOf("async function switchSymbol"),
    bybitJs.indexOf("async function switchInterval"),
  );
  // Owns state.symbol, clears pin, clears series, reloads klines+WS+labels
  assert.match(switchFn, /state\.symbol = next/);
  assert.match(switchFn, /state\.sessionSymbol = null/);
  assert.match(switchFn, /state\.chartCandles = \[\]/);
  assert.match(switchFn, /state\.chartSymbol = null/);
  assert.match(switchFn, /candleSeries\.setData\(\[\]\)/);
  assert.match(switchFn, /loadChartAndGates/);
  assert.match(switchFn, /stopFeed/);
  assert.match(switchFn, /A carregar " \+ next/);
  assert.match(switchFn, /\^\[A-Z0-9\]\{2,20\}USDT\$/);
  // No hardcoded majors in the switch path — works for ETH/SOL/XRP/BNB/…
  assert.doesNotMatch(switchFn, /BNBUSDT|BTCUSDT|ETHUSDT/);
  // Radar click shares the same function
  assert.match(bybitJs, /switchSymbol\(sym\)/);
  assert.match(bybitJs, /bybitSym\.addEventListener\("change".*switchSymbol/s);
});

test("multi-symbol: series clear + chartSymbol ownership + poll/WS stale guards", () => {
  assert.match(bybitJs, /chartSymbol: null/);
  assert.match(bybitJs, /state\.chartSymbol = sym/);
  // Empty paint clears series (no lingering BNB under overlay)
  const paint = bybitJs.slice(
    bybitJs.indexOf("function paintChartFromState"),
    bybitJs.indexOf("function destroyChart"),
  );
  assert.match(paint, /setData\(\[\]\)/);
  // Poll ticks capture feedGen + symbol and ignore stale responses
  const poll = bybitJs.slice(
    bybitJs.indexOf("function startPollFeed"),
    bybitJs.indexOf("async function fetchKlinesRaw"),
  );
  assert.match(poll, /var feedId = state\.feedGen/);
  assert.match(poll, /var sym = state\.symbol/);
  assert.match(poll, /feedId !== state\.feedGen/);
  assert.match(poll, /state\.symbol !== sym/);
  assert.match(poll, /fetchKlinesRaw\(sym, gran/);
  // WS topic always kline.{interval}.{state.symbol}
  const ws = bybitJs.slice(
    bybitJs.indexOf("function startWsFeed"),
    bybitJs.indexOf("function startPollFeed"),
  );
  assert.match(ws, /var topic = "kline\." \+ interval \+ "\." \+ sym/);
  assert.match(ws, /var sym = state\.symbol/);
  assert.match(ws, /state\.symbol !== sym/);
  assert.match(ws, /op: "subscribe"/);
  // Live kline refuses paint when chartSymbol drifted
  assert.match(bybitJs, /chartSymbol && state\.chartSymbol !== state\.symbol/);
  // Chart path must not hardcode BNB as default paint target
  const loadFn = bybitJs.slice(
    bybitJs.indexOf("async function loadChartAndGates"),
    bybitJs.indexOf("function startGateTimer"),
  );
  assert.doesNotMatch(loadFn, /BNBUSDT/);
  assert.match(loadFn, /state\.chartSymbol = sym/);
  assert.match(loadFn, /state\.chartSymbol = null/);
});

test("readiness: bybit usa combineReadinessUI — nunca Math.max(gate, live) a 100%", () => {
  assert.match(bybitJs, /function combineReadinessUI\(/);
  assert.match(bybitJs, /NL\.combineReadiness/);
  assert.match(bybitJs, /NL\.gateProgressPct/);
  assert.doesNotMatch(bybitJs, /Math\.max\(gateSc,\s*live\.proximityPct\)/);
  assert.doesNotMatch(bybitJs, /score:\s*live \? live\.proximityPct/);
  assert.match(bybitHtml, /prontidão/i);
});

test("readiness: radar+arm unificados — mesmo score para símbolo seleccionado", () => {
  assert.match(bybitJs, /function readinessForRadarSymbol\(/);
  assert.match(bybitJs, /function patchSelectedRadarRow\(/);
  assert.match(bybitJs, /function activeRadarPreset\(/);
  assert.match(bybitJs, /function syncRadarPresetFromStrategy\(/);
  // syncArmUi patches radar row so selected % === arm %
  const syncArm = bybitJs.slice(
    bybitJs.indexOf("function syncArmUi"),
    bybitJs.indexOf("async function pushClosedCandleToSession"),
  );
  assert.match(syncArm, /patchSelectedRadarRow/);
  assert.match(syncArm, /combineReadinessUI\(gate, live, preset/);
  // Scan uses shared helper — not a parallel fake formula
  assert.match(bybitJs, /readinessForRadarSymbol\(it\.symbol, live, preset\)/);
  assert.doesNotMatch(bybitJs, /combineReadinessUI\(null,\s*live,\s*preset,\s*false\)/);
  // Selected symbol with gate skips light overwrite
  assert.match(bybitJs, /it\.symbol === state\.symbol && state\.liveGates\[preset\]/);
});

test("readiness: radar casado com estratégia — sem misturar presets", () => {
  const onStrat = bybitJs.slice(
    bybitJs.indexOf("function onStrategyChange"),
    bybitJs.indexOf("function qtyFromFixedStake"),
  );
  assert.match(onStrat, /syncRadarPresetFromStrategy/);
  assert.match(bybitJs, /r\.preset === preset/);
  assert.match(bybitJs, /presetLabelPt/);
  // Radar preset dropdown houses strategy (lucro/loss)
  assert.match(bybitJs, /onStrategyChange\(p\)/);
  assert.match(bybitJs, /tag-near">sinal/);
  // Gate cache per symbol+preset+granularity
  assert.match(bybitJs, /RADAR_GATE_CACHE_TTL_MS/);
  assert.match(bybitJs, /putRadarGateCache/);
  assert.match(bybitJs, /getRadarGateCached/);
});

test("Agressivo (blitz_zero) wired: selects, cards, porta 10 + máx 10 ops, AGILE", () => {
  assert.match(bybitHtml, /value="blitz_zero"/);
  assert.match(bybitHtml, /Agressivo/);
  assert.doesNotMatch(bybitHtml, /Blitz zero/);
  assert.match(bybitHtml, /id="cardBlitzZero"/);
  assert.match(bybitHtml, /data-preset="blitz_zero"/);
  assert.match(bybitHtml, /porta 10/);
  assert.match(bybitHtml, /máx\. 10 ops/);
  assert.match(bybitHtml, /porta 100/);
  assert.match(bybitHtml, /porta 1000/);
  assert.match(bybitJs, /blitz_zero/);
  assert.match(bybitJs, /blitzZeroStrategySet|NL\.blitzZeroStrategySet/);
  assert.match(bybitJs, /cardBlitzZero/);
  assert.match(bybitJs, /maxTradesForPreset/);
  assert.match(bybitJs, /String\(summary\.opened\) \+ " \/ " \+ maxTrades/);
  assert.match(bybitJs, /"Ops " \+ \(sum\.opened \|\| 0\) \+ "\/" \+ maxTrades/);
  assert.match(bybitJs, /presetId === "blitz_zero" \? 10 : 50/);
  assert.match(bybitJs, /["']lucro_rapido["'],\s*["']loss_zero["'],\s*["']blitz_zero["']/);
  assert.match(bybitJs, /return "AGILE"|=== "AGILE"/);
  assert.match(bybitJs, /portaOosNeed/);
  assert.match(bybitJs, /Agressivo/);
});
