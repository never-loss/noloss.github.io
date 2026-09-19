import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHistoryMessage, digitsFromPrices } from "../src/core/history.ts";
import { runResearch, formatReport } from "../src/core/research.ts";

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

test("histórico válido é interpretado", () => {
  const raw = JSON.stringify({
    msg_type: "history",
    history: { prices: [938.83, 938.8], times: [1, 2] },
    pip_size: 2,
  });
  assert.deepEqual(parseHistoryMessage(raw), {
    kind: "history",
    prices: [938.83, 938.8],
    times: [1, 2],
    pipSize: 2,
  });
});

test("histórico: pip_size em texto e pip_size ausente", () => {
  const comTexto = JSON.stringify({ msg_type: "history", history: { prices: [1], times: [1] }, pip_size: "2" });
  const m1 = parseHistoryMessage(comTexto);
  assert.equal(m1.kind, "history");
  if (m1.kind === "history") assert.equal(m1.pipSize, 2);
  const sem = JSON.stringify({ msg_type: "history", history: { prices: [1], times: [1] } });
  const m2 = parseHistoryMessage(sem);
  if (m2.kind === "history") assert.equal(m2.pipSize, null);
});

test("histórico: casos inválidos não passam em silêncio", () => {
  assert.equal(parseHistoryMessage("nada").kind, "invalid");
  assert.equal(parseHistoryMessage(JSON.stringify({ msg_type: "history" })).kind, "invalid");
  const tamanhos = JSON.stringify({ msg_type: "history", history: { prices: [1, 2], times: [1] } });
  assert.equal(parseHistoryMessage(tamanhos).kind, "invalid");
  const preco = JSON.stringify({ msg_type: "history", history: { prices: ["x"], times: [1] } });
  assert.equal(parseHistoryMessage(preco).kind, "invalid");
  const tempo = JSON.stringify({ msg_type: "history", history: { prices: [1], times: ["x"] } });
  assert.equal(parseHistoryMessage(tempo).kind, "invalid");
});

test("histórico: erros da API e outras mensagens", () => {
  const err = JSON.stringify({ error: { code: "X", message: "y" } });
  assert.deepEqual(parseHistoryMessage(err), { kind: "error", code: "X", message: "y" });
  assert.equal(parseHistoryMessage(JSON.stringify({ msg_type: "tick" })).kind, "other");
});

test("digitsFromPrices mantém os zeros finais", () => {
  assert.deepEqual(digitsFromPrices([938.83, 938.8, 939.2, 938.77], 2), [3, 0, 0, 7]);
});

test("pesquisa em dados aleatórios: nunca encontra evidência", () => {
  for (let seed = 1; seed <= 5; seed++) {
    const r = runResearch(randomDigits(seed, 5000), { returnA: 0.82, returnB: 8 });
    assert.equal(r.n, 5000);
    assert.equal(r.counts.reduce((a, b) => a + b, 0), 5000);
    assert.equal(r.lanes.length, 2);
    for (const lane of r.lanes) {
      assert.ok(lane.label === "NO_EVIDENCE" || lane.label === "INSUFFICIENT", `${lane.lane}: ${lane.label}`);
    }
  }
});

test("pesquisa encontra o padrão real plantado na faixa A", () => {
  const r = runResearch(plantedDigits(1, 6000), { returnA: 0.82, returnB: 8 });
  const a = r.lanes[0]!;
  assert.ok(a.label === "PRELIMINARY" || a.label === "EVIDENCE");
  assert.ok(a.adjustedP !== null && a.adjustedP < 0.001);
  assert.ok(a.walk.oos.winRate > a.breakEven);
  assert.equal(r.lanes[1]!.label, "NO_EVIDENCE");
});

test("pesquisa: amostra curta e retornos inválidos são rejeitados", () => {
  assert.throws(() => runResearch(randomDigits(1, 1000), { returnA: 0.82, returnB: 8 }), RangeError);
  assert.throws(() => runResearch(randomDigits(1, 2000), { returnA: 0, returnB: 8 }), RangeError);
  assert.throws(() => runResearch(randomDigits(1, 2000), { returnA: 0.82, returnB: -1 }), RangeError);
});

test("relatório traz o aviso e os rótulos", () => {
  const texto = formatReport(runResearch(randomDigits(2, 3000), { returnA: 0.82, returnB: 8 }));
  assert.ok(texto.includes("PESQUISA (3000 ticks)"));
  assert.ok(texto.includes("Qui-quadrado"));
  assert.ok(texto.includes("Faixa A"));
  assert.ok(texto.includes("Faixa B"));
  assert.ok(texto.includes("Nenhum resultado, mesmo positivo, garante lucro futuro"));
});
