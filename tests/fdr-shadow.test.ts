// Benjamini-Hochberg + modo sombra (porta nova vs antiga) — puro. Dados SINTÉTICOS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { benjaminiHochberg } from "../src/core/fdr.ts";
import { legacyVerdict, shadowRelation, fdrByPreset, summarizeShadow, FDR_MIN_OOS } from "../src/core/gate-shadow.ts";
import type { ShadowSummaryIn, LegacyVerdict } from "../src/core/gate-shadow.ts";
import { computeGateEntry, gateSetup, GATE_PRESET_IDS } from "../src/core/gate-service.ts";
import { evaluateCandleGate } from "../src/core/candle-gate.ts";
import type { Candle } from "../src/core/market-data.ts";

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

test("BH: exemplo clássico à mão", () => {
  const r = benjaminiHochberg([0.01, 0.04, 0.03, 0.005], 0.05);
  assert.deepEqual(r.adjP, [0.02, 0.04, 0.04, 0.02]);
  assert.deepEqual(r.reject, [true, true, true, true]);
  assert.equal(r.m, 4);
  const r2 = benjaminiHochberg([0.01, 0.04, 0.03, 0.005], 0.03);
  assert.deepEqual(r2.reject, [true, false, false, true]);
});

test("BH == definição passo-a-passo (step-up) em 200 conjuntos aleatórios; nulls ignorados", () => {
  const rnd = mulberry32(11);
  for (let t = 0; t < 200; t++) {
    const m = 1 + Math.floor(rnd() * 40);
    const p = Array.from({ length: m }, () => (rnd() < 0.3 ? rnd() * 0.02 : rnd()));
    const q = [0.05, 0.1, 0.2][t % 3]!;
    const sorted = [...p].sort((a, b) => a - b);
    let kmax = 0;
    sorted.forEach((v, i) => { if (v <= ((i + 1) / m) * q) kmax = i + 1; });
    const thr = kmax ? sorted[kmax - 1]! : -1;
    const ref = p.map((v) => v <= thr);
    const r = benjaminiHochberg(p, q);
    assert.deepEqual(r.reject, ref, `t=${t}`);
    // adjP monótono na ordem dos p e <= 1
    const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < order.length; i++) assert.ok((r.adjP[order[i]![1]]!) >= (r.adjP[order[i - 1]![1]]!) - 1e-12);
    assert.ok(r.adjP.every((x) => x !== null && x <= 1));
    // mais estrito que p<=q? não: BH rejeita >= Bonferroni e <= nada acima de p<=q·m/1 ; garante Bonferroni ⊆ BH
    p.forEach((v, i) => { if (v * m <= q) assert.ok(r.reject[i], "Bonferroni ⊆ BH"); });
  }
  const withNull = benjaminiHochberg([0.001, null, 0.9, undefined, NaN], 0.1);
  assert.equal(withNull.m, 2);
  assert.deepEqual(withNull.adjP, [0.002, null, 0.9, null, null]);
  assert.deepEqual(withNull.reject, [true, false, false, false, false]);
  assert.deepEqual(benjaminiHochberg([], 0.1), { adjP: [], reject: [], m: 0 });
  assert.throws(() => benjaminiHochberg([0.1], 0), RangeError);
  assert.throws(() => benjaminiHochberg([0.1], 1), RangeError);
  assert.throws(() => benjaminiHochberg([1.2], 0.1), RangeError);
});

test("BH controla falsas descobertas: sob hipótese nula global, P(alguma rejeição) <= q (simulação)", () => {
  const rnd = mulberry32(5);
  let any = 0;
  const trials = 3000;
  for (let t = 0; t < trials; t++) {
    const p = Array.from({ length: 40 }, () => rnd());
    if (benjaminiHochberg(p, 0.1).reject.some(Boolean)) any += 1;
  }
  assert.ok(any / trials <= 0.1 + 0.02, `FWER sob nula global ${any / trials}`);
  // sem correcção, com 40 testes a p<0.05, quase sempre haveria "descobertas":
  let naive = 0;
  const r2 = mulberry32(5);
  for (let t = 0; t < trials; t++) if (Array.from({ length: 40 }, () => r2()).some((x) => x < 0.05)) naive += 1;
  assert.ok(naive / trials > 0.8);
});

const L = (allowed: boolean, label = "NO_EVIDENCE", nOOS = 100): LegacyVerdict => ({ allowed, label, nOOS, meanR: 0, p: null, candles: 2700 });
const S = (symbol: string, v: Record<string, { allowed: boolean; nOOS: number; oosP: number | null; legacy?: LegacyVerdict; streak?: number }>): ShadowSummaryIn => ({
  symbol,
  verdicts: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { label: x.allowed ? "AGILE" : "NO_EVIDENCE", p: x.oosP, streak: x.streak ?? 0, ...x }])),
});

test("shadowRelation cobre os 4 casos", () => {
  assert.equal(shadowRelation(true, true), "both_open");
  assert.equal(shadowRelation(true, false), "new_only");
  assert.equal(shadowRelation(false, true), "old_only");
  assert.equal(shadowRelation(false, false), "both_closed");
});

test("fdrByPreset: família só com nOOS >= mínimo e p disponível; o resto fica de fora (adjP null)", () => {
  const sums = [
    S("A", { blitz_zero: { allowed: true, nOOS: 200, oosP: 0.001 } }),
    S("B", { blitz_zero: { allowed: true, nOOS: 200, oosP: 0.04 } }),
    S("C", { blitz_zero: { allowed: false, nOOS: FDR_MIN_OOS - 1, oosP: 0.0001 } }), // poucos OOS
    S("D", { blitz_zero: { allowed: false, nOOS: 500, oosP: null } }), // sem p
    S("E", { blitz_zero: { allowed: false, nOOS: 400, oosP: 0.9 } }),
  ];
  const f = fdrByPreset(sums, ["blitz_zero"], 0.1)["blitz_zero"]!;
  assert.equal(f.A!.m, 3);
  assert.equal(f.A!.pass, true);
  assert.equal(f.B!.pass, true); // 0.04*3/2 = 0.06 <= 0.1
  assert.equal(f.E!.pass, false);
  assert.equal(f.C!.adjP, null);
  assert.equal(f.D!.adjP, null);
  assert.equal(f.C!.pass, false);
});

test("FDR é MAIS estrito: p<0,05 isolado entre muitos testes não sobrevive", () => {
  const sums: ShadowSummaryIn[] = [S("X0", { lucro_rapido: { allowed: true, nOOS: 150, oosP: 0.03 } })];
  for (let i = 1; i < 30; i++) sums.push(S(`X${i}`, { lucro_rapido: { allowed: false, nOOS: 150, oosP: 0.3 + i * 0.02 } }));
  const f = fdrByPreset(sums, ["lucro_rapido"], 0.1)["lucro_rapido"]!;
  assert.equal(f.X0!.m, 30);
  assert.ok(f.X0!.adjP! > 0.5);
  assert.equal(f.X0!.pass, false);
  const st = summarizeShadow(sums.map((s) => ({ ...s, verdicts: { lucro_rapido: { ...s.verdicts.lucro_rapido!, legacy: L(false) } } })), ["lucro_rapido"]);
  assert.equal(st.lucro_rapido!.newOpen, 1);
  assert.equal(st.lucro_rapido!.newOpenFdrPass, 0);
  assert.equal(st.lucro_rapido!.open[0]!.fdrPass, false);
});

test("summarizeShadow: contagens e discordâncias", () => {
  const sums = [
    S("A", { blitz_zero: { allowed: true, nOOS: 100, oosP: 0.001, legacy: L(true), streak: 2 } }),
    S("B", { blitz_zero: { allowed: true, nOOS: 100, oosP: 0.02, legacy: L(false, "INSUFFICIENT", 4) } }),
    S("C", { blitz_zero: { allowed: false, nOOS: 100, oosP: 0.5, legacy: L(true, "AGILE", 12) } }),
    S("D", { blitz_zero: { allowed: false, nOOS: 100, oosP: 0.7, legacy: L(false) } }),
    S("E", { blitz_zero: { allowed: false, nOOS: 100, oosP: 0.7 } }), // sem legacy → não conta
  ];
  const st = summarizeShadow(sums, ["blitz_zero"])["blitz_zero"]!;
  assert.deepEqual([st.tested, st.bothOpen, st.newOnly, st.oldOnly, st.bothClosed], [4, 1, 1, 1, 1]);
  assert.deepEqual(st.disagreements.map((d) => [d.symbol, d.relation]), [["B", "new_only"], ["C", "old_only"]]);
  assert.equal(st.newOpen, 2);
  assert.ok(st.newOpenFdrPass <= st.newOpen);
});

function walk(seed: number, n: number, phi: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  let prev = 0;
  const g = () => { let u = 0; let v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  for (let i = 0; i < n; i++) {
    const ret = phi * prev + g() * 0.002;
    prev = ret;
    const open = price;
    const close = open * (1 + ret);
    out.push({ epoch: 1_700_000_100 + i * 300, open, close, high: Math.max(open, close) * (1 + Math.abs(g()) * 0.0007), low: Math.min(open, close) * (1 - Math.abs(g()) * 0.0007) });
    price = close;
  }
  return out;
}

test("legacyVerdict: <1500 velas → INSUFFICIENT; igual ao evaluateCandleGate directo", () => {
  const s = gateSetup("blitz_zero");
  const cfg = { slAtr: s.params.slAtr, tpR: s.params.tpR, maxBars: s.params.maxBars, costFraction: s.params.costFraction, minLabel: s.minLabel };
  assert.equal(legacyVerdict(walk(1, 1000, 0), s.strategies, cfg).label, "INSUFFICIENT");
  const c = walk(2, 2700, 0.3);
  const v = legacyVerdict(c, s.strategies, cfg);
  const direct = evaluateCandleGate(c, s.strategies, { ...cfg, trainSize: 1000, testSize: 500 });
  assert.deepEqual([v.allowed, v.label, v.nOOS, v.meanR, v.p], [direct.allowed, direct.label, direct.oosTrades, direct.meanR, direct.pValue]);
  assert.equal(v.candles, 2700);
});

test("registo do serviço traz o veredicto sombra (legacy), oosP/oosMeanR — sem alterar allowed/streak do veredicto novo", () => {
  const candles = walk(3, 9000, 0);
  const e = computeGateEntry(null, "TESTUSDT", candles, 1);
  for (const id of GATE_PRESET_IDS) {
    const v = e.verdicts[id]!;
    assert.ok(v.legacy && v.legacy.candles === 2700, `legacy ${id}`);
    assert.equal(typeof v.oosMeanR, "number");
    assert.ok(v.oosP === null || (v.oosP >= 0 && v.oosP <= 1));
    assert.equal(v.allowed, false);
  }
});
