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
  for (const id of ["lucro_rapido", "loss_zero", "tendencia_diaria", "biblioteca"] as const) {
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
        minLabel: id === "loss_zero" ? "EVIDENCE" : "PRELIMINARY",
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
  // switch while running forces select back to armed pair
  const sw = bybitJs.slice(
    bybitJs.indexOf("async function switchSymbol"),
    bybitJs.indexOf("async function switchInterval"),
  );
  assert.match(sw, /syncSymbolSelectToState/);
  assert.match(sw, /Sessão armada/);
});
