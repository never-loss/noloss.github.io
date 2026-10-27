// src/core/gate-service.ts — registo da porta por símbolo (puro). Velas SINTÉTICAS.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_PRESET_IDS, GATE_TAIL_KEEP, GATE_GRAN, GATE_KEEP_FOLDS, computeGateEntry, summarizeEntry, nextStreak, verdictIsOpen,
  tailToCandles, candlesToTail, gateSetup, configInfo, isFresh, GATE_FRESH_MS,
} from "../src/core/gate-service.ts";
import { ledgerTailNeeded } from "../src/core/gate-ledger.ts";
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
function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function walk(seed: number, n: number, phi: number, startEpoch = 1_700_000_100): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const ret = phi * prev + gauss(r) * 0.002;
    prev = ret;
    const open = price;
    const close = open * (1 + ret);
    out.push({
      epoch: startEpoch + i * 300, open, close,
      high: Math.max(open, close) * (1 + Math.abs(gauss(r)) * 0.0007),
      low: Math.min(open, close) * (1 - Math.abs(gauss(r)) * 0.0007),
    });
    price = close;
  }
  return out;
}

test("tamanho da cauda guardada cobre aquecimento + treino + 2 blocos (≈2600)", () => {
  const s = gateSetup("lucro_rapido");
  assert.equal(ledgerTailNeeded(s.params, 2), 2600);
  assert.ok(GATE_TAIL_KEEP >= 2600);
});

test("os presets em cache têm configuração coerente com a porta do painel (mult. 100, custo 0,1 %, treino 1000)", () => {
  const info = configInfo(GATE_PRESET_IDS.map((id) => gateSetup(id)));
  assert.equal(info.minMultiplier, 100);
  assert.equal(info.costFraction, 0.001);
  assert.equal(info.trainSize, 1000);
  assert.equal(info.gran, GATE_GRAN);
  assert.deepEqual(Object.keys(info.hashes).sort(), [...GATE_PRESET_IDS].sort());
  assert.equal(new Set(Object.values(info.hashes)).size, GATE_PRESET_IDS.length);
  assert.equal(gateSetup("giro_diario").minLabel, "PRELIMINARY");
  assert.equal(gateSetup("loss_zero").minLabel, "EVIDENCE");
  assert.equal(gateSetup("lucro_rapido").minLabel, "PRELIMINARY");
  assert.equal(gateSetup("blitz_zero").minLabel, "AGILE");
});

test("nextStreak: histerese (só conta com >=12 velas de intervalo) e fecha a 0 de imediato", () => {
  const g = 300;
  let s = nextStreak(null, true, 1000, g);
  assert.deepEqual(s, { streak: 1, streakAt: 1000 });
  s = nextStreak(s, true, 1000 + 5 * g, g); // só 5 velas depois: não conta
  assert.deepEqual(s, { streak: 1, streakAt: 1000 });
  s = nextStreak(s, true, 1000 + 12 * g, g);
  assert.deepEqual(s, { streak: 2, streakAt: 1000 + 12 * g });
  s = nextStreak(s, true, 1000 + 30 * g, g);
  assert.equal(s.streak, 3);
  assert.deepEqual(nextStreak(s, false, 1000 + 31 * g, g), { streak: 0, streakAt: null });
  assert.deepEqual(nextStreak({ streak: 0, streakAt: null }, true, 5, g), { streak: 1, streakAt: 5 });
});

test("verdictIsOpen: precisa de allowed E streak >= 2", () => {
  const v = { allowed: true, streak: 1 } as never;
  assert.equal(verdictIsOpen(v), false);
  assert.equal(verdictIsOpen({ allowed: true, streak: 2 } as never), true);
  assert.equal(verdictIsOpen({ allowed: false, streak: 5 } as never), false);
});

test("arranque a frio: veredicto por preset com todos os campos, cauda limitada e sem promessas", () => {
  const candles = walk(1, 9000, 0);
  const e = computeGateEntry(null, "TESTUSDT", candles, 1_800_000_000_000);
  assert.equal(e.tail.length, GATE_TAIL_KEEP);
  assert.equal(e.lastEpoch, candles[candles.length - 1]!.epoch);
  assert.equal(e.historyFrom, candles[0]!.epoch);
  for (const id of GATE_PRESET_IDS) {
    const v = e.verdicts[id]!;
    assert.ok(v.folds >= 10, `${id} folds ${v.folds}`);
    assert.equal(typeof v.nOOS, "number");
    assert.ok(v.depthDays > 10);
    assert.equal(v.allowed, false, "passeio aleatório sem edge não abre");
    assert.equal(v.streak, 0);
    assert.ok(v.asOf !== null);
    assert.ok(e.ledgers[id]!.folds.length <= GATE_KEEP_FOLDS);
  }
  const sum = summarizeEntry(e) as Record<string, unknown>;
  assert.equal("ledgers" in sum, false);
  assert.equal("tail" in sum, false);
  assert.ok(JSON.stringify(sum).length < 6000, "resumo pequeno");
});

test("incremental (cauda + velas novas) == recálculo completo; streak preservado/avança", () => {
  const all = walk(2, 12000, 0.35);
  const t0 = 1_800_000_000_000;
  const cut = 11000;
  const first = computeGateEntry(null, "TESTUSDT", all.slice(0, cut), t0);
  // simula o servidor: cauda guardada (JSON) + velas novas
  const prev = JSON.parse(JSON.stringify(first));
  const merged = [...tailToCandles(prev.tail), ...all.slice(cut, cut + 30)];
  const warm = computeGateEntry(prev, "TESTUSDT", merged, t0 + 1);
  const full = computeGateEntry(null, "TESTUSDT", all.slice(0, cut + 30), t0 + 1);
  for (const id of GATE_PRESET_IDS) {
    assert.deepStrictEqual(warm.ledgers[id]!.folds, full.ledgers[id]!.folds, `ledger ${id}`);
    const a = { ...warm.verdicts[id]!, streak: 0, streakAt: null };
    const b = { ...full.verdicts[id]!, streak: 0, streakAt: null };
    assert.deepStrictEqual(a, b, `veredicto ${id}`);
  }
  assert.equal(warm.historyFrom, first.historyFrom);
  assert.equal(warm.lastEpoch, all[cut + 29]!.epoch);
});

test("hashes diferentes no registo anterior → livro reconstruído (não reaproveita lixo)", () => {
  const candles = walk(3, 8000, 0);
  const e = computeGateEntry(null, "TESTUSDT", candles, 1);
  const bad = JSON.parse(JSON.stringify(e));
  for (const id of GATE_PRESET_IDS) {
    bad.ledgers[id].paramsHash = "000000";
    for (const f of bad.ledgers[id].folds) f.sumR = 1e6;
  }
  const re = computeGateEntry(bad, "TESTUSDT", candles, 2);
  for (const id of GATE_PRESET_IDS) assert.deepStrictEqual(re.ledgers[id]!.folds, e.ledgers[id]!.folds);
  // outro símbolo nunca herda livros
  const other = computeGateEntry(e, "OTHERUSDT", candles, 3);
  assert.equal(other.symbol, "OTHERUSDT");
});

test("símbolo novo (poucas velas): veredicto INSUFFICIENT honesto, sem excepção", () => {
  const e = computeGateEntry(null, "NEWUSDT", walk(4, 800, 0), 1);
  for (const id of GATE_PRESET_IDS) {
    assert.equal(e.verdicts[id]!.allowed, false);
    assert.equal(e.verdicts[id]!.label, "INSUFFICIENT");
    assert.equal(e.verdicts[id]!.folds, 0);
  }
  assert.throws(() => computeGateEntry(null, "X", [], 1), RangeError);
});

test("momentum plantado: porta pode abrir; streak começa em 1 e só abre (open) com 2", () => {
  let found = false;
  for (const seed of [2, 12, 22, 32, 42]) {
    const all = walk(seed, 10000, 0.4);
    const e1 = computeGateEntry(null, "MOMUSDT", all.slice(0, 9000), 1);
    const v = e1.verdicts.blitz_zero!;
    if (!v.allowed) continue;
    found = true;
    assert.equal(v.streak, 1);
    assert.equal(verdictIsOpen(v), false);
    // 12 velas depois, ainda aberta → streak 2 → aberta
    const merged = [...tailToCandles(e1.tail), ...all.slice(9000, 9012)];
    const e2 = computeGateEntry(JSON.parse(JSON.stringify(e1)), "MOMUSDT", merged, 2);
    if (e2.verdicts.blitz_zero!.allowed) {
      assert.equal(e2.verdicts.blitz_zero!.streak, 2);
      assert.equal(verdictIsOpen(e2.verdicts.blitz_zero!), true);
    } else {
      assert.equal(e2.verdicts.blitz_zero!.streak, 0); // fecha de imediato
    }
    break;
  }
  assert.ok(found, "algum mercado com momentum plantado abre");
});

test("tail <-> candles ida e volta; isFresh", () => {
  const c = walk(5, 50, 0);
  assert.deepStrictEqual(tailToCandles(candlesToTail(c)), c);
  assert.equal(isFresh({ updatedAt: 1000 }, 1000 + GATE_FRESH_MS), true);
  assert.equal(isFresh({ updatedAt: 1000 }, 1001 + GATE_FRESH_MS), false);
});
