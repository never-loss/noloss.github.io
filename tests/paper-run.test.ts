import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRuleSpec } from "../src/core/rules.ts";
import { formatEvent, formatSummary, describeContract } from "../src/core/report.ts";
import { PaperSession } from "../src/core/paper.ts";
import { parseMessage } from "../src/core/ticks.ts";
import { lastDigit } from "../src/core/digits.ts";

test("regras a partir de texto", () => {
  assert.equal(parseRuleSpec("paridade-inverte-3", 0.82).returnRate, 0.82);
  assert.ok(parseRuleSpec("paridade-segue-4", 0.82).name.includes("segue"));
  assert.ok(parseRuleSpec("dominante-100-20", 8).name.includes("dominante"));
  assert.ok(parseRuleSpec("ausente-30", 8).name.includes("ausente"));
  assert.ok(parseRuleSpec("  Paridade-Inverte-2 ", 0.82).name.includes("inverte"));
});

test("regras inválidas são rejeitadas", () => {
  assert.throws(() => parseRuleSpec("martingale-2", 0.82), RangeError);
  assert.throws(() => parseRuleSpec("paridade-inverte", 0.82), RangeError);
  assert.throws(() => parseRuleSpec("paridade-inverte-x", 0.82), RangeError);
  assert.throws(() => parseRuleSpec("dominante-100", 8), RangeError);
  assert.throws(() => parseRuleSpec("ausente-0", 8), RangeError);
  assert.throws(() => parseRuleSpec("", 8), RangeError);
});

test("descrição dos contratos", () => {
  assert.equal(describeContract({ type: "even" }), "par");
  assert.equal(describeContract({ type: "odd" }), "ímpar");
  assert.equal(describeContract({ type: "match", digit: 6 }), "match 6");
});

test("mensagens de tick reais alimentam a sessão e geram texto", () => {
  const session = new PaperSession({
    rule: parseRuleSpec("paridade-inverte-2", 0.82),
    stake: 3,
    maxLoss: 30,
    maxTrades: 10,
    maxDurationMs: 10 * 60_000,
    maxConsecutiveLosses: 5,
    cooldownTicks: 0,
  });
  const quotes = [938.82, 938.84, 938.86, 938.81, 938.8, 938.88, 938.92];
  const linhas: string[] = [];
  let epoch = 1_700_000_000;
  for (const q of quotes) {
    const raw = JSON.stringify({
      msg_type: "tick",
      tick: { symbol: "1HZ100V", epoch, quote: q, pip_size: 2 },
    });
    const msg = parseMessage(raw);
    assert.equal(msg.kind, "tick");
    if (msg.kind !== "tick") continue;
    const at = msg.epoch * 1000;
    if (epoch === 1_700_000_000) for (const e of session.start(at)) linhas.push(formatEvent(e));
    for (const e of session.onTick(lastDigit(msg.quote, msg.pipSize ?? 2), at)) linhas.push(formatEvent(e));
    epoch += 1;
  }
  assert.ok(linhas[0]!.includes("PLAY"));
  assert.ok(linhas.some((l) => l.includes("ABRE")));
  assert.ok(linhas.some((l) => l.includes("FECHA")));
  const resumo = formatSummary(session.summary());
  assert.ok(resumo.includes("RESUMO"));
  assert.ok(resumo.includes("não garante resultado futuro"));
});

test("resumo sem operações diz NO TRADE", () => {
  const session = new PaperSession({
    rule: parseRuleSpec("ausente-30", 8),
    stake: 3,
    maxLoss: 30,
    maxTrades: 10,
    maxDurationMs: 60_000,
    maxConsecutiveLosses: 5,
    cooldownTicks: 0,
  });
  session.start(0);
  session.onTick(1, 1000);
  assert.ok(formatSummary(session.summary()).includes("NO TRADE"));
});

test("a sessão para pelo limite e o texto explica o motivo", () => {
  const session = new PaperSession({
    rule: parseRuleSpec("paridade-segue-1", 0.82),
    stake: 1,
    maxLoss: 2,
    maxTrades: 50,
    maxDurationMs: 60_000,
    maxConsecutiveLosses: 50,
    cooldownTicks: 0,
  });
  session.start(0);
  const textos: string[] = [];
  [2, 3, 2, 3, 2, 3, 2, 3, 2, 3].forEach((d, i) => {
    for (const e of session.onTick(d, i * 1000)) textos.push(formatEvent(e));
  });
  assert.equal(session.status, "STOPPED");
  assert.ok(textos.some((t) => t.includes("perda máxima atingida")));
});
