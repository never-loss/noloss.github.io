import { test } from "node:test";
import assert from "node:assert/strict";
import { CandlePaperSession } from "../src/core/candle-paper.ts";
import type { CandlePaperConfig, CandlePaperEvent } from "../src/core/candle-paper.ts";
import { evaluateCandleGate, formatCandleGate, CandleGateController } from "../src/core/candle-gate.ts";
import { runCandleBacktest } from "../src/core/candle-backtest.ts";
import { strategyLibrary, emaCross } from "../src/core/strategies.ts";
import type { Strategy, Signal } from "../src/core/strategies.ts";
import type { Candle } from "../src/core/market-data.ts";

function close(actual: number | null, expected: number, tol = 1e-9): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `${actual} não está perto de ${expected}`);
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

function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function walk(seed: number, n: number, phi: number): Candle[] {
  const r = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const ret = phi * prev + gauss(r) * 0.002;
    prev = ret;
    const open = price;
    const close2 = open * (1 + ret);
    const high = Math.max(open, close2) * (1 + Math.abs(gauss(r)) * 0.0007);
    const low = Math.min(open, close2) * (1 - Math.abs(gauss(r)) * 0.0007);
    out.push({ epoch: 1_700_000_000 + i * 300, open, high, low, close: close2 });
    price = close2;
  }
  return out;
}

/** 40 velas planas com amplitude 2 (ATR = 2); as alterações são aplicadas por cima. */
function flat(changes: Record<number, Partial<Candle>> = {}): Candle[] {
  return Array.from({ length: 40 }, (_, i) => ({
    epoch: 1_000_000 + i * 60, open: 100, high: 101, low: 99, close: 100, ...(changes[i] ?? {}),
  }));
}

/** Mercado a cair sempre: cada operação de compra perde exatamente 1R. */
function falling(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const open = 1000 - i * 3;
    return { epoch: 1_000_000 + i * 60, open, high: open + 1, low: open - 4, close: open - 3 };
  });
}

/** Mercado a subir sempre: cada operação de compra ganha exatamente 2R (3 velas por operação). */
function rising(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const open = 100 + i * 3;
    return { epoch: 1_000_000 + i * 60, open, high: open + 4, low: open - 1, close: open + 3 };
  });
}

/** Só para testes: velas com 1 s de intervalo, para caberem na duração máxima de 3 horas da sessão. */
function compress(candles: Candle[]): Candle[] {
  return candles.map((c, i) => ({ ...c, epoch: 1_700_000_000 + i }));
}

const at = (index: number, dir: 1 | -1): Strategy => ({
  name: "manual",
  signals: (c) => Array.from({ length: c.length }, (_, i) => (i === index ? dir : 0)) as Signal[],
});
const sempre = (dir: 1 | -1): Strategy => ({
  name: "sempre",
  signals: (c) => new Array<Signal>(c.length).fill(dir),
});

function cfg(over: Partial<CandlePaperConfig> = {}): CandlePaperConfig {
  return {
    strategy: at(20, 1),
    stake: 1,
    slAtr: 1,
    tpR: 2,
    maxBars: 24,
    costFraction: 0,
    maxLoss: 1000,
    maxTrades: 1000,
    maxDurationMs: 3 * 60 * 60 * 1000,
    maxConsecutiveLosses: 1000,
    cooldownCandles: 0,
    maxBuffer: 5000,
    ...over,
  };
}

function run(s: CandlePaperSession, candles: Candle[]): CandlePaperEvent[] {
  const ev: CandlePaperEvent[] = [];
  for (const c of candles) ev.push(...s.onCandle(c));
  return ev;
}

/** Começa a sessão no instante da primeira vela (epoch em segundos). */
function started(config: CandlePaperConfig, firstEpoch = 1_000_000): CandlePaperSession {
  const s = new CandlePaperSession(config);
  s.start(firstEpoch * 1000);
  return s;
}

const closedR = (ev: CandlePaperEvent[]): number[] => ev.flatMap((e) => (e.type === "trade_closed" ? [e.r] : []));

// ---------- Sessão ----------

test("começa STOPPED e ignora velas até ao PLAY", () => {
  const s = new CandlePaperSession(cfg());
  assert.equal(s.status, "STOPPED");
  assert.deepEqual(run(s, flat()), []);
  assert.equal(s.summary().opened, 0);
});

test("compra: alvo dá +2R e o resultado em dinheiro é R x stake", () => {
  const s = started(cfg({ stake: 3 }));
  const ev = run(s, flat({ 22: { high: 104 } }));
  const abriu = ev.find((e) => e.type === "trade_opened");
  assert.ok(abriu && abriu.type === "trade_opened" && abriu.entry === 100 && abriu.stopLoss === 98 && abriu.takeProfit === 104);
  const fechou = ev.find((e) => e.type === "trade_closed");
  assert.ok(fechou && fechou.type === "trade_closed");
  if (fechou && fechou.type === "trade_closed") {
    assert.equal(fechou.reason, "tp");
    close(fechou.r, 2);
    close(fechou.pnl, 6);
  }
  close(s.totalPnl, 6);
});

test("compra: stop dá -1R; stop e alvo na mesma vela = stop", () => {
  const a = run(started(cfg()), flat({ 22: { low: 98 } }));
  close(closedR(a)[0]!, -1);
  const b = run(started(cfg()), flat({ 22: { high: 104, low: 98 } }));
  close(closedR(b)[0]!, -1);
});

test("salto (gap) dá pior que -1R e a saída por tempo fecha no fecho", () => {
  const gap = run(started(cfg()), flat({ 22: { open: 97, high: 97.5, low: 96.5, close: 97 } }));
  close(closedR(gap)[0]!, -1.5);
  const tempo = run(started(cfg({ maxBars: 3 })), flat({ 24: { close: 101 } }));
  close(closedR(tempo)[0]!, 0.5);
});

test("custos, venda e saída na própria vela de entrada", () => {
  const custo = run(started(cfg({ costFraction: 0.001 })), flat({ 22: { high: 104 } }));
  close(closedR(custo)[0]!, 2 - 0.05);
  const venda = run(started(cfg({ strategy: at(20, -1) })), flat({ 22: { low: 96 } }));
  close(closedR(venda)[0]!, 2);
  const entrada = run(started(cfg()), flat({ 21: { open: 100.5, low: 98.4 } }));
  close(closedR(entrada)[0]!, -1);
});

test("filtro de direção", () => {
  const s = started(cfg({ strategy: at(20, -1), directions: "long" }));
  assert.equal(run(s, flat({ 22: { low: 96 } })).length, 0);
});

test("a sessão dá exatamente os mesmos resultados que o backtest", () => {
  const candles = compress(walk(7, 2500, 0));
  const base = { slAtr: 1.5, tpR: 2, maxBars: 24, costFraction: 0.0002 };
  const strat = emaCross({ fast: 9, slow: 21 });
  const bt = runCandleBacktest(candles, strat, base).trades.map((t) => t.r);
  const s = started(cfg({ ...base, strategy: strat, maxBuffer: 5000 }), 1_700_000_000);
  const rs = closedR(run(s, candles));
  assert.ok(rs.length > 20);
  assert.ok(bt.length >= rs.length && bt.length - rs.length <= 1);
  assert.deepEqual(rs, bt.slice(0, rs.length));
});

test("perda máxima da sessão para o bot", () => {
  const s = started(cfg({ strategy: sempre(1), slAtr: 1, maxLoss: 3, stake: 1 }));
  const ev = run(s, falling(80));
  assert.equal(s.stopReason, "max_loss");
  const sum = s.summary();
  assert.equal(sum.closed, 3);
  close(sum.totalPnl, -3);
  assert.ok(ev.some((e) => e.type === "stopped"));
});

test("perdas seguidas máximas e número máximo de operações", () => {
  const a = started(cfg({ strategy: sempre(1), maxConsecutiveLosses: 2 }));
  run(a, falling(80));
  assert.equal(a.stopReason, "max_consecutive_losses");
  assert.equal(a.summary().closed, 2);
  const b = started(cfg({ strategy: sempre(1), maxTrades: 2 }));
  const ev = run(b, rising(80));
  assert.equal(b.stopReason, "max_trades");
  assert.equal(b.summary().closed, 2);
  assert.deepEqual(closedR(ev), [2, 2]);
});

test("duração máxima para o bot (pelo relógio das velas)", () => {
  const s = started(cfg({ strategy: sempre(1), maxDurationMs: 900_000 }));
  run(s, rising(40));
  assert.equal(s.stopReason, "max_duration");
});

test("cooldown depois de perdas reduz as entradas", () => {
  const sem = started(cfg({ strategy: sempre(1), cooldownCandles: 0, maxLoss: 1000 }));
  run(sem, falling(60));
  const com = started(cfg({ strategy: sempre(1), cooldownCandles: 3, maxLoss: 1000 }));
  run(com, falling(60));
  assert.ok(com.summary().opened < sem.summary().opened);
});

test("PAUSE bloqueia entradas novas; STOP deixa a posição aberta sair", () => {
  const s = started(cfg({ strategy: sempre(1) }));
  const candles = rising(60);
  run(s, candles.slice(0, 16)); // o ATR só existe a partir da vela 13
  assert.ok(s.summary().opened >= 1);
  s.pause(0);
  const abertasAntes = s.summary().opened;
  run(s, candles.slice(16, 40));
  assert.equal(s.summary().opened, abertasAntes); // sem novas entradas
  assert.equal(s.hasOpenPosition, false); // a posição que existia já saiu

  const t = started(cfg({ strategy: sempre(1) }));
  run(t, candles.slice(0, 15)); // entrada na vela 14
  assert.equal(t.hasOpenPosition, true);
  t.stop(0);
  const ev = run(t, candles.slice(15, 25));
  assert.ok(ev.some((e) => e.type === "trade_closed"));
  assert.equal(t.status, "STOPPED");
  assert.equal(t.hasOpenPosition, false);
  assert.equal(t.summary().opened, 1); // depois do STOP não abre mais
  assert.throws(() => t.start(1), Error);
});

test("martingale e opções desconhecidas são rejeitadas; configuração inválida também", () => {
  assert.throws(() => new CandlePaperSession({ ...cfg(), martingale: true } as unknown as CandlePaperConfig), RangeError);
  assert.throws(() => new CandlePaperSession({ ...cfg(), stakeMultiplier: 2 } as unknown as CandlePaperConfig), RangeError);
  assert.throws(() => new CandlePaperSession(cfg({ stake: 0.4 })), RangeError);
  assert.throws(() => new CandlePaperSession(cfg({ maxLoss: 0.5 })), RangeError);
  assert.throws(() => new CandlePaperSession(cfg({ maxDurationMs: 4 * 3600 * 1000 })), RangeError);
  assert.throws(() => new CandlePaperSession(cfg({ slAtr: 0 })), RangeError);
  assert.throws(() => new CandlePaperSession(cfg({ cooldownCandles: -1 })), RangeError);
  assert.throws(() => new CandlePaperSession(cfg({ strategy: undefined as never })), RangeError);
  const s = started(cfg());
  assert.throws(() => s.onCandle({ epoch: 1, open: 1, high: 0, low: 2, close: 1 }), RangeError);
});

test("a stake não muda depois de perdas", () => {
  const s = started(cfg({ strategy: sempre(1), stake: 2, maxLoss: 1000 }));
  const ev = run(s, falling(40));
  const pnls = ev.flatMap((e) => (e.type === "trade_closed" ? [e.pnl] : []));
  assert.ok(pnls.length > 5);
  assert.ok(pnls.every((p) => Math.abs(p - -2) < 1e-9));
});

// ---------- Porta de evidência ----------

const GATE = { slAtr: 1.5, tpR: 2, maxBars: 24, costFraction: 0.0002, trainSize: 1000, testSize: 500 };

test("porta: poucas velas fecha", () => {
  const g = evaluateCandleGate(walk(1, 500, 0), strategyLibrary(), GATE);
  assert.equal(g.allowed, false);
  assert.equal(g.label, "INSUFFICIENT");
  assert.ok(g.reason.includes("poucas velas"));
});

test("porta: passeios aleatórios ficam fechados", () => {
  let abertas = 0;
  for (let seed = 1; seed <= 8; seed++) {
    if (evaluateCandleGate(walk(seed, 3500, 0), strategyLibrary(), GATE).allowed) abertas += 1;
  }
  assert.ok(abertas <= 1, `${abertas} de 8 abriram por sorte`);
});

test("porta: momentum real plantado abre e escolhe uma estratégia", () => {
  const g = evaluateCandleGate(walk(2, 3500, 0.5), strategyLibrary(), GATE);
  assert.equal(g.allowed, true);
  assert.ok(g.strategy !== null);
  assert.ok(g.meanR > 0);
  assert.ok(formatCandleGate(g).startsWith("PORTA ABERTA"));
  const strict = evaluateCandleGate(walk(2, 3500, 0.5), strategyLibrary(), { ...GATE, minLabel: "EVIDENCE" });
  assert.ok(strict.allowed === false || strict.label === "EVIDENCE");
});

test("porta fechada explica o motivo", () => {
  const g = evaluateCandleGate(walk(3, 3500, 0), strategyLibrary(), GATE);
  assert.equal(g.allowed, false);
  assert.ok(formatCandleGate(g).startsWith("NO TRADE"));
});

test("controlador: sessão com porta em dados aleatórios não abre operações", () => {
  const data = compress(walk(11, 4500, 0));
  const c = new CandleGateController({
    strategies: strategyLibrary(),
    gate: GATE,
    revalidateEvery: 250,
    maxBuffer: 3500,
    initial: data.slice(0, 3500),
  });
  const s = started(cfg({ strategy: c.asStrategy(), slAtr: 1.5, costFraction: 0.0002 }), data[3500]!.epoch);
  for (const candle of data.slice(3500)) {
    c.push(candle);
    s.onCandle(candle);
  }
  assert.equal(s.summary().opened, 0);
});

test("controlador: abre com duas validações seguidas e fecha quando o padrão desaparece", () => {
  const todos = walk(4, 4000, 0.5);
  const c = new CandleGateController({
    strategies: strategyLibrary(),
    gate: GATE,
    revalidateEvery: 250,
    maxBuffer: 3500,
    initial: todos.slice(0, 3500),
  });
  assert.equal(c.isOpen, false); // uma validação positiva ainda não chega
  for (const candle of todos.slice(3500)) c.push(candle);
  assert.equal(c.isOpen, true);
  for (const candle of walk(9, 3500, 0)) c.push(candle);
  assert.equal(c.isOpen, false);
});

test("controlador: entradas inválidas", () => {
  assert.throws(() => new CandleGateController({ strategies: strategyLibrary(), gate: GATE, revalidateEvery: 0 }), RangeError);
  assert.throws(() => evaluateCandleGate(walk(1, 3500, 0), [], GATE), RangeError);
});

// ---------- Texto ----------

test("texto dos eventos e do resumo", async () => {
  const { formatCandleEvent, formatCandleSummary } = await import("../src/core/candle-paper.ts");
  const s = started(cfg({ stake: 3 }));
  const ev = run(s, flat({ 22: { high: 104 } }));
  const linhas = ev.map(formatCandleEvent);
  assert.ok(linhas.some((l) => l.includes("ABRE") && l.includes("COMPRA") && l.includes("stop 98") && l.includes("alvo 104")));
  assert.ok(linhas.some((l) => l.includes("FECHA") && l.includes("(alvo)") && l.includes("+2.00R") && l.includes("+6.00")));
  const resumo = formatCandleSummary(s.summary());
  assert.ok(resumo.includes("RESUMO"));
  assert.ok(resumo.includes("não garante resultado futuro"));
  const vazio = formatCandleSummary(started(cfg()).summary());
  assert.ok(vazio.includes("NO TRADE"));
  assert.ok(formatCandleEvent({ type: "stopped", at: 0, reason: "max_loss" }).includes("perda máxima atingida"));
});
