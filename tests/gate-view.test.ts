// src/core/gate-view.ts — conversão do veredicto em cache + etiquetas honestas (PT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAgePt, isCacheUsable, cachedVerdictToResult, gateProvenanceLabel } from "../src/core/gate-view.ts";
import type { CachedGateView } from "../src/core/gate-view.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bybitJs = readFileSync(join(root, "public/assets/bybit.js"), "utf8");
const bybitHtml = readFileSync(join(root, "public/bybit.html"), "utf8");
const nlCore = readFileSync(join(root, "public/assets/nl-core.js"), "utf8");

function gate(over: Partial<CachedGateView> = {}): CachedGateView {
  return {
    symbol: "BTCUSDT", updatedAt: 1, ageMs: 3 * 60_000, stale: false, historyDays: 90,
    presets: {
      lucro_rapido: { allowed: false, label: "NO_EVIDENCE", reason: "sem evidência: média -0.9R", strategy: null, nOOS: 610, meanR: -0.94, p: 1, folds: 48, foldsPositive: 0, foldsWithTrades: 48, asOf: 1791600000, depthDays: 83.3, streak: 0, needOos: 100 },
      blitz_zero: { allowed: true, label: "AGILE", reason: "evidência AGILE: média +0.200R", strategy: "ema-cruza 9/21", nOOS: 40, meanR: 0.2, p: 0.004, folds: 48, asOf: 1791600000, depthDays: 83.3, streak: 1, needOos: 10 },
    },
    ...over,
  };
}

test("formatAgePt", () => {
  assert.equal(formatAgePt(5_000), "agora");
  assert.equal(formatAgePt(3 * 60_000), "há 3 min");
  assert.equal(formatAgePt(5 * 3600_000), "há 5 h");
  assert.equal(formatAgePt(3 * 86400_000), "há 3 d");
  assert.equal(formatAgePt(-1), "—");
  assert.equal(formatAgePt(NaN), "—");
});

test("isCacheUsable: preset presente e não velho (6 h)", () => {
  assert.equal(isCacheUsable(gate(), "lucro_rapido"), true);
  assert.equal(isCacheUsable(gate(), "loss_zero"), false); // preset em falta
  assert.equal(isCacheUsable(gate({ ageMs: 7 * 3600_000 }), "lucro_rapido"), false);
  assert.equal(isCacheUsable(gate({ ageMs: 7 * 3600_000 }), "lucro_rapido", 24 * 3600_000), true);
  assert.equal(isCacheUsable(null, "lucro_rapido"), false);
  assert.equal(isCacheUsable({ ...gate(), presets: {} }, "lucro_rapido"), false);
});

test("cachedVerdictToResult: mesmo formato da porta local + marca 'a confirmar' enquanto streak < 2", () => {
  const closed = cachedVerdictToResult(gate(), "lucro_rapido")!;
  assert.equal(closed.allowed, false);
  assert.equal(closed.oosTrades, 610);
  assert.equal(closed.pValue, 1);
  assert.equal(closed.strategy, null);
  assert.equal(closed.source, "cache");
  assert.equal(closed.confirming, false);
  const open1 = cachedVerdictToResult(gate(), "blitz_zero")!;
  assert.equal(open1.allowed, true);
  assert.equal(open1.confirming, true);
  assert.match(open1.reason, /a confirmar \(validação 1\/2\)/);
  assert.deepEqual(open1.strategy, { name: "ema-cruza 9/21" });
  const g2 = gate();
  g2.presets.blitz_zero!.streak = 2;
  const open2 = cachedVerdictToResult(g2, "blitz_zero")!;
  assert.equal(open2.confirming, false);
  assert.doesNotMatch(open2.reason, /confirmar/);
  assert.equal(cachedVerdictToResult(gate(), "inexistente"), null);
});

test("etiquetas honestas: profundidade, n OOS e idade; local diz que não há cache", () => {
  const r = cachedVerdictToResult(gate(), "lucro_rapido")!;
  assert.equal(gateProvenanceLabel(r), "histórico: 90d · OOS 83d (48 blocos) · n OOS 610 · atualizado há 3 min · cache do servidor");
  const stale = cachedVerdictToResult(gate({ ageMs: 40 * 60_000, stale: true }), "lucro_rapido")!;
  assert.match(gateProvenanceLabel(stale), /há 40 min · desatualizado/);
  assert.equal(gateProvenanceLabel({ source: "local", candlesUsed: 3500, gran: 300, oosTrades: 85 }), "cálculo local: 3500 velas (≈12d) · n OOS 85 · sem cache");
  assert.equal(gateProvenanceLabel(null), "");
  assert.equal(gateProvenanceLabel({}), "");
  assert.match(gateProvenanceLabel({ source: "cache", historyDays: null, depthDays: undefined }), /histórico: \?d/);
});

test("UI (fonte): cache primeiro e só depois histórico local; fallback local; sem tocar na Deriv", () => {
  const load = bybitJs.slice(bybitJs.indexOf("async function loadChartAndGates"), bybitJs.indexOf("function startGateTimer"));
  assert.ok(load.indexOf("fetchGateCache") > 0);
  assert.ok(load.indexOf("fetchGateCache") < load.indexOf("fetchBybitHistory"), "tenta a cache antes do histórico pesado");
  assert.ok(load.indexOf("paintChartFromState(true)") < load.indexOf("fetchGateCache"), "gráfico pinta antes");
  assert.match(load, /state\.gateSource = "local"/);
  assert.match(bybitJs, /mode=gate&interval=5&symbols=all/);
  assert.match(bybitJs, /function getBulkGateResult\(/);
  assert.match(bybitJs, /if \(!gate\) gate = getBulkGateResult\(sym, preset\)/);
  // Analisar usa a cache e cai no cálculo local
  const an = bybitJs.slice(bybitJs.indexOf("async function runAnalyze"), bybitJs.indexOf("async function startSession"));
  assert.match(an, /refreshGateFromCache\(true\)/);
  assert.match(an, /state\.gateSource = "local"/);
  assert.match(an, /fetchBybitHistory/);
  // ARMAR (sessão local) passa a cálculo local, coerente com o controlador
  const ss = bybitJs.slice(bybitJs.indexOf("async function startSession"), bybitJs.indexOf("function pauseSession"));
  assert.match(ss, /state\.gateSource === "cache"/);
  assert.match(ss, /state\.gateSource = "local"/);
  // Tendência diária/Biblioteca não estão na cache: cálculo local
  assert.match(bybitJs, /function cacheCoversStrategy\(/);
  // etiqueta honesta no painel
  assert.match(bybitHtml, /id="gateProv"/);
  assert.match(bybitJs, /NL\.gateProvenanceLabel/);
  assert.match(bybitJs, /GATE_HISTORY = 3500/); // histórico local mantém-se como recurso
  // PAPER por omissão e Deriv intocada
  assert.match(bybitJs, /sessionStorage\.getItem\(TRADING_MODE_KEY\) === "REAL" \? "REAL" : "PAPER"/);
});

test("bundle do browser exporta as funções de vista da porta", () => {
  for (const n of ["formatAgePt", "isCacheUsable", "cachedVerdictToResult", "gateProvenanceLabel"]) assert.match(nlCore, new RegExp(n));
});
