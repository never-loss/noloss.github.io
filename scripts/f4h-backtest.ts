// Backtest pré-registado (notes/preregistro-4h-forward-2026-10-15.md) no universo B, dados REAIS via proxy.
//   node scripts/f4h-backtest.ts --dir /workspace/tmp/f4h [--out /workspace/tmp/f4h-results.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { F4H_CANDIDATES, candidateTrades, dailySeries } from "../src/core/forward-4h.ts";
import type { F4hTrade } from "../src/core/forward-4h.ts";
import { expectancyPValue } from "../src/core/candle-backtest.ts";
import { benjaminiHochberg } from "../src/core/fdr.ts";
import type { Candle } from "../src/core/market-data.ts";

const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const DIR = arg("dir", "/workspace/tmp/f4h");
const OUT = arg("out", "/workspace/tmp/f4h-results.json");
const UNIVERSE_B = "1000PEPE WIF SHIB1000 1000BONK TIA SEI WLD FET ORDI LDO IMX GALA SAND MANA AXS EOS KAS MKR ONDO ENA".split(" ").map((s) => s + "USDT");
const EVAL_FROM = Date.parse("2024-06-01T00:00:00Z") / 1000;
const NEED_FROM = Date.parse("2024-04-20T00:00:00Z") / 1000;
const mean = (a: readonly number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const used: { symbol: string; candles: Candle[] }[] = [];
const dropped: string[] = [];
let lastEnd = Infinity;
for (const s of UNIVERSE_B) {
  const f = `${DIR}/${s}_4h.json`;
  if (!existsSync(f)) { dropped.push(`${s} (sem dados)`); continue; }
  const j = JSON.parse(readFileSync(f, "utf8"));
  const c = j.candles as Candle[];
  if (!c.length || c[0]!.epoch > NEED_FROM) { dropped.push(`${s} (começa ${c[0] ? new Date(c[0].epoch * 1000).toISOString().slice(0, 10) : "-"})`); continue; }
  used.push({ symbol: s, candles: c });
  lastEnd = Math.min(lastEnd, c.at(-1)!.epoch);
}
// fim comum; um símbolo que acabe > 2 dias antes dos outros (deslistado) é excluído
const maxEnd = Math.max(...used.map((u) => u.candles.at(-1)!.epoch));
for (let i = used.length - 1; i >= 0; i--) if (used[i]!.candles.at(-1)!.epoch < maxEnd - 2 * 86400) { dropped.push(`${used[i]!.symbol} (acaba ${new Date(used[i]!.candles.at(-1)!.epoch * 1000).toISOString().slice(0, 10)})`); used.splice(i, 1); }
const END = Math.min(...used.map((u) => u.candles.at(-1)!.epoch)) + 14400;
const nSym = used.length;
const d0 = Math.floor(EVAL_FROM / 86400), d1 = Math.floor(END / 86400);

function evalCost(cost: number) {
  const out: Record<string, F4hTrade[]> = {};
  for (const c of F4H_CANDIDATES) out[c.id] = used.flatMap((u) => candidateTrades(u.candles, c, u.symbol, EVAL_FROM, END, cost)).filter((t) => t.r !== null);
  return out;
}
const prim = evalCost(0.0013), rob = evalCost(0.0017), gross = evalCost(0);
const rows = F4H_CANDIDATES.map((c) => {
  const tr = prim[c.id]!;
  const daily = dailySeries(tr, d0, d1, nSym);
  const blocks: number[] = [];
  for (let e = d1; e - 30 >= d0; e -= 30) blocks.push(mean(daily.slice(e - 30 - d0, e - d0)));
  const symPos = used.filter((u) => mean(tr.filter((t) => t.symbol === u.symbol).map((t) => t.r as number)) > 0).length / nSym;
  return {
    id: c.id, label: c.label, n: tr.length, meanR: mean(tr.map((t) => t.r as number)), meanRGross: mean(gross[c.id]!.map((t) => t.r as number)),
    meanR017: mean(rob[c.id]!.map((t) => t.r as number)), dailyMean: mean(daily), p: expectancyPValue(daily),
    blocksPos: blocks.filter((b) => b > 0).length, blocks: blocks.length, lastBlock: blocks[0] ?? 0, symPos,
  };
});
const bh = benjaminiHochberg(rows.map((r) => r.p), 0.1);
const res = rows.map((r, i) => {
  const checks = {
    "1_BH": bh.reject[i]! && r.dailyMean > 0,
    "2_blocos": r.blocks > 0 && r.blocksPos / r.blocks >= 0.6 && r.lastBlock > 0,
    "3_largura": r.symPos >= 0.6 && r.meanR > 0,
    "4_custo017": r.meanR017 > 0,
  };
  return { ...r, adjP: bh.adjP[i], checks, pass: Object.values(checks).every(Boolean) };
});
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), symbols: used.map((u) => u.symbol), dropped, from: new Date(EVAL_FROM * 1000).toISOString(), to: new Date(END * 1000).toISOString(), results: res }, null, 1));
const f = (x: number | null | undefined, d = 3) => (x == null ? "-" : x.toFixed(d));
console.log(`símbolos ${nSym}: ${used.map((u) => u.symbol).join(" ")}\nexcluídos: ${dropped.join("; ") || "nenhum"}\njanela ${new Date(EVAL_FROM * 1000).toISOString().slice(0, 10)} → ${new Date(END * 1000).toISOString().slice(0, 16)}`);
console.log("| id | regra | n op | R/op líq. 0,13 % | R/op bruto | R/op 0,17 % | p diário | p ajust. (BH m=5) | blocos 30 d > 0 | último bloco | símb. R>0 | veredicto |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of res) console.log(`| ${r.id} | ${r.label} | ${r.n} | ${f(r.meanR)} | ${f(r.meanRGross)} | ${f(r.meanR017)} | ${f(r.p)} | ${f(r.adjP)} | ${r.blocksPos}/${r.blocks} | ${f(r.lastBlock, 4)} | ${(r.symPos * 100).toFixed(0)}% | ${r.pass ? "PASSA" : "falha: " + Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(",")} |`);
