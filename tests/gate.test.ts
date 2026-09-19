import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, chooseRule, formatGate, GateController } from "../src/core/gate.ts";
import { laneARules, laneBRules } from "../src/core/lanes.ts";
import { PaperSession } from "../src/core/paper.ts";

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

function randomDigits(seed: number, n: number): number[] {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => Math.floor(r() * 10));
}

function plantedDigits(seed: number, n: number): number[] {
  const r = mulberry32(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    let wantOpposite = false;
    if (i >= 3) {
      const p = out[i - 1]! % 2;
      if (out[i - 2]! % 2 === p && out[i - 3]! % 2 === p) wantOpposite = r() < 0.75;
    }
    let d = Math.floor(r() * 10);
    if (wantOpposite) d = Math.floor(r() * 5) * 2 + (1 - (out[i - 1]! % 2));
    out.push(d);
  }
  return out;
}

const RULES = laneARules(0.82);

function newSession(rule: ReturnType<GateController["asRule"]>): PaperSession {
  const s = new PaperSession({
    rule,
    stake: 1,
    maxLoss: 1e6,
    maxTrades: 1e6,
    maxDurationMs: 3 * 60 * 60 * 1000,
    maxConsecutiveLosses: 1e6,
    cooldownTicks: 0,
  });
  s.start(0);
  return s;
}

test("poucos ticks: porta fechada", () => {
  const g = evaluateGate(randomDigits(1, 300), RULES);
  assert.equal(g.allowed, false);
  assert.equal(g.label, "INSUFFICIENT");
  assert.ok(g.reason.includes("poucos ticks"));
});

test("dados aleatórios: a porta fica fechada", () => {
  let abertas = 0;
  for (let seed = 1; seed <= 20; seed++) {
    if (evaluateGate(randomDigits(seed, 1500), RULES).allowed) abertas += 1;
  }
  assert.ok(abertas <= 1, `${abertas} de 20 abriram por sorte`);
});

test("padrão real plantado: a porta abre e escolhe a regra certa", () => {
  const g = evaluateGate(plantedDigits(1, 1500), RULES);
  assert.equal(g.allowed, true);
  assert.equal(g.label, "PRELIMINARY");
  assert.ok(g.rule !== null && g.rule.name.includes("inverte"));
  assert.ok(g.oosWinRate > g.breakEven);
  assert.ok(formatGate(g).startsWith("PORTA ABERTA"));
});

test("modo EVIDENCE é mais exigente que PRELIMINARY", () => {
  assert.equal(evaluateGate(plantedDigits(1, 1500), RULES, { minLabel: "EVIDENCE" }).allowed, false);
  assert.equal(evaluateGate(plantedDigits(1, 10000), RULES, { minLabel: "EVIDENCE" }).allowed, true);
});

test("porta fechada explica o motivo", () => {
  const g = evaluateGate(randomDigits(3, 1500), RULES);
  assert.equal(g.allowed, false);
  assert.ok(formatGate(g).startsWith("NO TRADE"));
  assert.ok(g.reason.length > 10);
});

test("faixa B em dados aleatórios: porta fechada", () => {
  const g = evaluateGate(randomDigits(2, 1500), laneBRules(8));
  assert.equal(g.allowed, false);
});

test("chooseRule respeita o mínimo de operações", () => {
  assert.equal(chooseRule(randomDigits(1, 100), laneBRules(8), 50, 1000), null);
  assert.ok(chooseRule(randomDigits(1, 1500), RULES, 500, 30) !== null);
});

test("entradas inválidas", () => {
  assert.throws(() => evaluateGate(randomDigits(1, 1000), []), RangeError);
  assert.throws(() => new GateController({ candidates: RULES, revalidateEvery: 0 }), RangeError);
  const c = new GateController({ candidates: RULES, revalidateEvery: 50 });
  assert.throws(() => c.push(10), RangeError);
});

test("sessão com porta em dados aleatórios: fica em NO TRADE, sem operações", () => {
  for (let seed = 1; seed <= 4; seed++) {
    const data = randomDigits(seed, 3500);
    const c = new GateController({ candidates: RULES, revalidateEvery: 100, initial: data.slice(0, 1000) });
    const s = newSession(c.asRule());
    data.slice(1000).forEach((d, i) => {
      c.push(d);
      s.onTick(d, i * 1000);
    });
    assert.equal(s.summary().opened, 0, `seed ${seed}: abriu ${s.summary().opened}`);
  }
});

test("sessão com porta em dados com padrão real: abre e opera acima do break-even", () => {
  const data = plantedDigits(2, 4000);
  const c = new GateController({ candidates: RULES, revalidateEvery: 100, initial: data.slice(0, 1000) });
  const s = newSession(c.asRule());
  data.slice(1000).forEach((d, i) => {
    c.push(d);
    s.onTick(d, i * 1000);
  });
  const sum = s.summary();
  assert.ok(sum.closed > 100);
  assert.ok(sum.metrics.winRate > 0.549);
});

test("a porta abre com duas validações seguidas e fecha quando o padrão desaparece", () => {
  const todos = plantedDigits(3, 1600);
  const c = new GateController({
    candidates: RULES,
    revalidateEvery: 100,
    initial: todos.slice(0, 1500),
    maxBuffer: 1500,
  });
  assert.equal(c.isOpen, false);
  for (const d of todos.slice(1500)) c.push(d);
  assert.equal(c.isOpen, true);
  for (const d of randomDigits(9, 1500)) c.push(d);
  assert.equal(c.isOpen, false);
});

test("a regra da porta devolve NO TRADE enquanto a porta está fechada", () => {
  const c = new GateController({ candidates: RULES, revalidateEvery: 100, initial: randomDigits(1, 1000) });
  assert.equal(c.isOpen, false);
  assert.equal(c.asRule().decide([2, 4, 6, 8]), null);
});
