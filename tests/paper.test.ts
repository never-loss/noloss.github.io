import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperSession, MAX_SESSION_MS } from "../src/core/paper.ts";
import type { PaperConfig, PaperEvent } from "../src/core/paper.ts";
import { makeRule, parityStreak, runBacktest } from "../src/core/backtest.ts";

function close(actual: number, expected: number, tol: number): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} não está perto de ${expected}`);
}

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

// Aposta sempre em ímpar (ou par) assim que há pelo menos 1 dígito de histórico.
const semprImpar = makeRule("sempre-impar", 0.9, (h) => (h.length >= 1 ? { type: "odd" } : null));
const semprePar = makeRule("sempre-par", 0.9, (h) => (h.length >= 1 ? { type: "even" } : null));

function cfg(over: Partial<PaperConfig> = {}): PaperConfig {
  return {
    rule: semprImpar,
    stake: 1,
    maxLoss: 1000,
    maxTrades: 1000,
    maxDurationMs: 60 * 60 * 1000,
    maxConsecutiveLosses: 1000,
    cooldownTicks: 0,
    ...over,
  };
}

function feed(s: PaperSession, digits: number[], startTime = 0): PaperEvent[] {
  const all: PaperEvent[] = [];
  digits.forEach((d, i) => all.push(...s.onTick(d, startTime + i)));
  return all;
}

test("começa STOPPED e ignora ticks até ao PLAY", () => {
  const s = new PaperSession(cfg());
  assert.equal(s.status, "STOPPED");
  assert.deepEqual(feed(s, [1, 2, 3, 4]), []);
  assert.equal(s.summary().opened, 0);
});

test("PLAY liga a análise mas não força operações", () => {
  const nunca = makeRule("nunca", 0.9, () => null);
  const s = new PaperSession(cfg({ rule: nunca }));
  s.start(0);
  assert.equal(s.status, "RUNNING");
  assert.deepEqual(feed(s, [1, 2, 3, 4, 5, 6]), []);
  assert.equal(s.summary().opened, 0);
});

test("a operação abre num tick e só fecha no tick seguinte", () => {
  const s = new PaperSession(cfg({ rule: semprePar }));
  s.start(0);
  const e1 = s.onTick(1, 1);
  assert.equal(e1.length, 1);
  assert.equal(e1[0]!.type, "trade_opened");
  const e2 = s.onTick(4, 2);
  assert.equal(e2[0]!.type, "trade_closed");
  if (e2[0]!.type === "trade_closed") {
    assert.equal(e2[0]!.won, true);
    assert.equal(e2[0]!.digit, 4);
    close(e2[0]!.pnl, 0.9, 1e-12);
  }
  assert.equal(e2[1]!.type, "trade_opened");
});

test("stake fixa: nunca muda depois de perdas (sem martingale)", () => {
  const s = new PaperSession(cfg({ stake: 2, maxLoss: 1000 }));
  s.start(0);
  const events = feed(s, new Array(30).fill(2));
  const opened = events.filter((e) => e.type === "trade_opened");
  assert.ok(opened.length > 20);
  assert.ok(opened.every((e) => e.type === "trade_opened" && e.stake === 2));
  const closed = events.filter((e) => e.type === "trade_closed");
  assert.ok(closed.every((e) => e.type === "trade_closed" && e.pnl === -2));
});

test("opções de martingale ou recuperação são rejeitadas", () => {
  const base = cfg();
  assert.throws(() => new PaperSession({ ...base, martingale: true } as unknown as PaperConfig), RangeError);
  assert.throws(() => new PaperSession({ ...base, stakeMultiplier: 2 } as unknown as PaperConfig), RangeError);
  assert.throws(() => new PaperSession({ ...base, recoverLosses: true } as unknown as PaperConfig), RangeError);
});

test("configuração inválida é rejeitada", () => {
  assert.throws(() => new PaperSession(cfg({ stake: 0.49 })), RangeError);
  assert.throws(() => new PaperSession(cfg({ stake: NaN })), RangeError);
  assert.throws(() => new PaperSession(cfg({ maxLoss: 0.5, stake: 1 })), RangeError);
  assert.throws(() => new PaperSession(cfg({ maxDurationMs: MAX_SESSION_MS + 1 })), RangeError);
  assert.throws(() => new PaperSession(cfg({ maxDurationMs: 0 })), RangeError);
  assert.throws(() => new PaperSession(cfg({ maxTrades: 0 })), RangeError);
  assert.throws(() => new PaperSession(cfg({ maxConsecutiveLosses: 0 })), RangeError);
  assert.throws(() => new PaperSession(cfg({ cooldownTicks: -1 })), RangeError);
  assert.throws(() => new PaperSession(cfg({ maxDrawdown: 0 })), RangeError);
  assert.throws(() => new PaperSession(cfg({ rule: undefined as never })), RangeError);
});

test("dígito inválido é rejeitado", () => {
  const s = new PaperSession(cfg());
  s.start(0);
  assert.throws(() => s.onTick(10, 1), RangeError);
  assert.throws(() => s.onTick(-1, 1), RangeError);
  assert.throws(() => s.onTick(1.5, 1), RangeError);
});

test("perda máxima da sessão para o bot", () => {
  const s = new PaperSession(cfg({ stake: 1, maxLoss: 3 }));
  s.start(0);
  const events = feed(s, new Array(50).fill(2));
  const stop = events.find((e) => e.type === "stopped");
  assert.ok(stop && stop.type === "stopped" && stop.reason === "max_loss");
  const sum = s.summary();
  assert.equal(sum.status, "STOPPED");
  assert.equal(sum.closed, 3);
  close(sum.totalPnl, -3, 1e-12);
  assert.equal(sum.opened, 3);
});

test("perdas seguidas máximas param o bot", () => {
  const s = new PaperSession(cfg({ maxConsecutiveLosses: 2 }));
  s.start(0);
  feed(s, new Array(20).fill(2));
  assert.equal(s.stopReason, "max_consecutive_losses");
  assert.equal(s.summary().closed, 2);
});

test("número máximo de operações", () => {
  const s = new PaperSession(cfg({ rule: semprePar, maxTrades: 5 }));
  s.start(0);
  feed(s, new Array(30).fill(2));
  assert.equal(s.stopReason, "max_trades");
  assert.equal(s.summary().opened, 5);
  assert.equal(s.summary().closed, 5);
});

test("queda máxima (drawdown) para o bot", () => {
  const s = new PaperSession(cfg({ maxDrawdown: 2.5, maxLoss: 1000 }));
  s.start(0);
  feed(s, new Array(20).fill(2));
  assert.equal(s.stopReason, "max_drawdown");
  assert.equal(s.summary().closed, 3);
});

test("duração máxima para o bot", () => {
  const s = new PaperSession(cfg({ rule: semprePar, maxDurationMs: 10_000 }));
  s.start(0);
  s.onTick(2, 1000);
  s.onTick(2, 5000);
  const ev = s.onTick(2, 10_000);
  assert.ok(ev.some((e) => e.type === "stopped" && e.reason === "max_duration"));
  assert.equal(s.status, "STOPPED");
});

test("cooldown depois de uma perda", () => {
  const s = new PaperSession(cfg({ cooldownTicks: 3 }));
  s.start(0);
  const opens: number[] = [];
  for (let t = 0; t < 20; t++) {
    for (const e of s.onTick(2, t)) if (e.type === "trade_opened") opens.push(t);
  }
  assert.deepEqual(opens, [0, 4, 8, 12, 16]);
});

test("PAUSE bloqueia novas operações e PLAY retoma", () => {
  const s = new PaperSession(cfg({ rule: semprePar }));
  s.start(0);
  s.onTick(2, 1);
  s.pause(2);
  assert.equal(s.status, "PAUSED");
  const e = s.onTick(2, 3);
  assert.deepEqual(e.map((x) => x.type), ["trade_closed"]);
  assert.deepEqual(s.onTick(2, 4), []);
  s.start(5);
  assert.equal(s.status, "RUNNING");
  assert.equal(s.onTick(2, 6).some((x) => x.type === "trade_opened"), true);
});

test("STOP com operação aberta: ela fecha e depois nada mais acontece", () => {
  const s = new PaperSession(cfg({ rule: semprePar }));
  s.start(0);
  s.onTick(2, 1);
  s.stop(2);
  assert.equal(s.status, "STOPPED");
  const e = s.onTick(2, 3);
  assert.deepEqual(e.map((x) => x.type), ["trade_closed"]);
  assert.deepEqual(s.onTick(2, 4), []);
  assert.equal(s.stopReason, "manual");
  assert.equal(s.summary().closed, 1);
});

test("sessão terminada não pode ser reiniciada", () => {
  const s = new PaperSession(cfg());
  s.start(0);
  s.stop(1);
  assert.throws(() => s.start(2), Error);
});

test("a configuração fica congelada depois de criada", () => {
  const config = cfg({ stake: 1 });
  const s = new PaperSession(config);
  config.stake = 50;
  s.start(0);
  const e = s.onTick(2, 1);
  const opened = e.find((x) => x.type === "trade_opened");
  assert.ok(opened && opened.type === "trade_opened" && opened.stake === 1);
});

test("a sessão de paper dá exatamente os mesmos resultados que o backtest", () => {
  const r = mulberry32(9);
  const digits = Array.from({ length: 3000 }, () => Math.floor(r() * 10));
  const rule = parityStreak({ length: 2, follow: false, returnRate: 0.9 });
  const s = new PaperSession(
    cfg({ rule, maxLoss: 1e9, maxTrades: 1e9, maxConsecutiveLosses: 1e9, cooldownTicks: 0 }),
  );
  s.start(0);
  const outcomes: boolean[] = [];
  digits.forEach((d, t) => {
    for (const e of s.onTick(d, t)) if (e.type === "trade_closed") outcomes.push(e.won);
  });
  assert.deepEqual(outcomes, runBacktest(digits, rule).outcomes);
});

test("resumo: contas e estado", () => {
  const s = new PaperSession(cfg({ rule: semprePar, stake: 2, maxTrades: 4 }));
  s.start(0);
  feed(s, [2, 2, 2, 2, 2, 2]);
  const sum = s.summary();
  assert.equal(sum.closed, 4);
  close(sum.totalPnl, 4 * 2 * 0.9, 1e-9);
  assert.equal(sum.metrics.wins, 4);
  assert.equal(sum.status, "STOPPED");
  assert.equal(sum.stake, 2);
});
