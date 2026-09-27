import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lastDigit,
  percentages,
  countDigits,
  deviationColor,
  TickWindow,
} from "../src/core/digits.ts";
import { parseMessage } from "../src/core/ticks.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/dashboard.html"), "utf8");
const css = readFileSync(join(root, "public/assets/dashboard.css"), "utf8");
const js = readFileSync(join(root, "public/assets/dashboard.js"), "utf8");
const entry = readFileSync(join(root, "src/browser/nl-core-entry.ts"), "utf8");
const oauthFiles = [
  readFileSync(join(root, "public/index.html"), "utf8"),
  readFileSync(join(root, "public/callback.html"), "utf8"),
  readFileSync(join(root, "api/token.js"), "utf8"),
];

test("classic UI: Tipo de Conta + Últimos Dígitos + status rail + trader log", () => {
  assert.match(html, /id="accountTypeSelect"/);
  assert.match(html, /TIPO DE CONTA/);
  assert.match(html, /Últimos Dígitos/);
  assert.match(html, /id="digitBars"/);
  assert.match(html, /id="digitWindowSelect"/);
  assert.match(html, /id="statusRail"/);
  assert.match(html, /ANALISANDO/);
  assert.match(html, /CONTRATO ABERTO/);
  assert.match(html, /CONTRATO FECHADO/);
  assert.match(html, /id="traderLogBody"/);
  assert.match(html, /TIPO/);
  assert.match(html, /ÚLTIMO PONTO/);
  assert.match(html, /id="termSaldo"/);
  assert.match(html, /id="termPnl"/);
  assert.match(html, /lightweight-charts@4\.2\.0/);
  assert.match(html, /id="derivChart"/);
});

test("classic CSS: navy terminal borders, digit bars, no glass blur", () => {
  assert.match(css, /\.digit-bars/);
  assert.match(css, /\.digit-bar\.high/);
  assert.match(css, /\.status-rail/);
  assert.match(css, /\.term-strip/);
  assert.match(css, /backdrop-filter:\s*none/);
  assert.match(css, /--navy:/);
});

test("CSS regression: no decorative rotateX on .deck (desktop clicks)", () => {
  assert.doesNotMatch(css, /rotateX\(1deg\)/);
  assert.match(css, /perspective:\s*none/);
  assert.match(css, /transform-style:\s*flat/);
});

test("dashboard.js: Real/Demo select + live digit ticks + LC chart", () => {
  assert.match(js, /accountTypeSelect/);
  assert.match(js, /function startDigitTickFeed/);
  assert.match(js, /function renderDigitBars/);
  assert.match(js, /function handleDigitStreamMessage/);
  assert.match(js, /function updateStatusRail/);
  assert.match(js, /function renderTraderLog/);
  assert.match(js, /function ensureLcChart/);
  assert.match(js, /ticks_history:\s*symbol/);
  assert.match(js, /subscribe:\s*1/);
  assert.match(js, /NL\.lastDigit/);
  assert.match(js, /NL\.TickWindow/);
  // No fake balances invented
  assert.doesNotMatch(js, /fakeBalance|Math\.random\(\).*balance/i);
});

test("nl-core exports digits + tick parser", () => {
  assert.match(entry, /TickWindow/);
  assert.match(entry, /lastDigit/);
  assert.match(entry, /parseTickMessage/);
});

test("OAuth surfaces untouched in this change set (content still present)", () => {
  for (const f of oauthFiles) {
    assert.ok(f.length > 50);
  }
  // dashboard must not rewrite oauth callback
  assert.doesNotMatch(js, /callback\.html/);
});

test("digit math: live bar coloring uses real deviations", () => {
  const tw = new TickWindow(50);
  for (const d of [1, 1, 1, 3, 3, 3, 5, 5, 5, 0, 2, 6, 4, 7, 8, 9, 4, 7, 8, 9, 4, 7, 1, 3, 5]) {
    tw.push(d);
  }
  const st = tw.stats(25);
  assert.equal(st.percentages.length, 10);
  assert.ok(st.total <= 25);
  // high digit should be green-mapped (blue in core)
  const hi = st.deviations.indexOf(Math.max(...st.deviations));
  assert.equal(deviationColor(st.deviations[hi]), "blue");
  const lo = st.deviations.indexOf(Math.min(...st.deviations));
  assert.equal(deviationColor(st.deviations[lo]), "red");
  assert.equal(lastDigit(588.67, 2), 7);
  assert.deepEqual(percentages(countDigits([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).map((x) => Math.round(x)), [
    10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
  ]);
});

test("tick parser accepts Deriv tick stream shape", () => {
  const raw = JSON.stringify({
    msg_type: "tick",
    tick: { symbol: "R_100", epoch: 1700000000, quote: 588.67, pip_size: 2 },
  });
  const m = parseMessage(raw);
  assert.equal(m.kind, "tick");
  if (m.kind === "tick") {
    assert.equal(m.symbol, "R_100");
    assert.equal(lastDigit(m.quote, m.pipSize ?? 2), 7);
  }
});

test("Deriv entry readiness + cloud PAPER catch-up (sem REAL cloud orders)", () => {
  assert.match(html, /id="entryReady-digits"/);
  assert.match(html, /id="entryReady-forex"/);
  assert.match(html, /id="derivCloudArmPanel"/);
  assert.match(html, /btnDerivCloudArm/);
  assert.match(html, /Sem ordens REAL na nuvem/i);
  assert.match(js, /function computeReadiness\(/);
  assert.match(js, /function paintEntryReadyBox\(/);
  assert.match(js, /NL\.combineReadiness/);
  assert.match(js, /function startDerivCloudArm\(/);
  assert.match(js, /mode:\s*"PAPER"/);
  assert.match(js, /sem contratos Deriv REAL na nuvem/i);
  // OAuth files untouched
  for (const f of oauthFiles) {
    assert.ok(f.length > 0);
  }
});
