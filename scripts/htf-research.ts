// Pesquisa pré-registada (notes/preregistro-htf-2026-10-10.md): 17 candidatos em 15m/1h/4h, dados REAIS Bybit (cache de scripts/htf-fetch.mjs).
// Só leitura: não toca na porta, no custo por omissão, nem em nada ao vivo.
//   node scripts/htf-research.ts [--dir /workspace/tmp/htf] [--out /workspace/tmp/htf-results.json]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { runCandleBacktest, expectancyPValue } from "../src/core/candle-backtest.ts";
import type { CandleTrade } from "../src/core/candle-backtest.ts";
import { atr } from "../src/core/indicators.ts";
import { emaCross } from "../src/core/strategies.ts";
import type { Signal, Strategy } from "../src/core/strategies.ts";
import { feasible } from "../src/core/feasible.ts";
import { benjaminiHochberg } from "../src/core/fdr.ts";
import type { Candle } from "../src/core/market-data.ts";

const arg = (k: string, d: string): string => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const DIR = arg("dir", "/workspace/tmp/htf");
const OUT = arg("out", "/workspace/tmp/htf-results.json");

const WARM = 250;
const SL_ATR = 3, TP_R = 2, MAX_STOP = 0.08;
const COST_PRIMARY = 0.0011, COST_MAKERTP = 0.00075, COST_SLIP = 0.0015;
const TF: Record<string, { sec: number; maxBars: number }> = { "15m": { sec: 900, maxBars: 192 }, "1h": { sec: 3600, maxBars: 96 }, "4h": { sec: 14400, maxBars: 60 } };

type SigFn = (candles: readonly Candle[]) => Signal[];
const zeros = (n: number): Signal[] => new Array<Signal>(n).fill(0);

const donchian = (N: number): SigFn => (c) => {
  const s = zeros(c.length);
  for (let i = N; i < c.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - N; j < i; j++) { if (c[j]!.high > hi) hi = c[j]!.high; if (c[j]!.low < lo) lo = c[j]!.low; }
    s[i] = c[i]!.close > hi ? 1 : c[i]!.close < lo ? -1 : 0;
  }
  return s;
};
const volExpansion = (base: SigFn): SigFn => (c) => {
  const raw = base(c);
  const a = atr(c, 14);
  const ratio = c.map((x, i) => (a[i] == null ? NaN : a[i]! / x.close));
  return raw.map((v, i) => {
    if (v === 0 || i < 200 || !Number.isFinite(ratio[i]!)) return 0;
    const w = ratio.slice(i - 200, i).filter(Number.isFinite).sort((x, y) => x - y);
    if (w.length < 100) return 0;
    return ratio[i]! > w[w.length >> 1]! ? v : 0;
  });
};
const tsmom = (L: number): SigFn => (c) => {
  const s = zeros(c.length);
  for (let i = L; i < c.length; i++) { const r = c[i]!.close / c[i - L]!.close - 1; s[i] = r > 0 ? 1 : r < 0 ? -1 : 0; }
  return s;
};
const ema2 = (fast: number, slow: number): SigFn => (c) => emaCross({ fast, slow }).signals(c);
function seeded(seed: number) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }
const randomDir = (seed: number): SigFn => (c) => { const r = seeded(seed); return c.map(() => (r() < 0.05 ? (r() < 0.5 ? 1 : -1) : 0)) as Signal[]; };

interface Cand { id: string; tf: string; kind: "single" | "xs"; sig?: SigFn; xs?: { lookback: number; reversal: boolean; maxBars: number } }
const CANDS: Cand[] = [
  { id: "A1", tf: "1h", kind: "single", sig: donchian(48) },
  { id: "A2", tf: "1h", kind: "single", sig: donchian(120) },
  { id: "A3", tf: "4h", kind: "single", sig: donchian(20) },
  { id: "A4", tf: "4h", kind: "single", sig: donchian(55) },
  { id: "A5", tf: "15m", kind: "single", sig: donchian(96) },
  { id: "A6", tf: "15m", kind: "single", sig: donchian(192) },
  { id: "B1", tf: "1h", kind: "single", sig: ema2(12, 48) },
  { id: "B2", tf: "4h", kind: "single", sig: ema2(20, 50) },
  { id: "B3", tf: "15m", kind: "single", sig: ema2(24, 96) },
  { id: "C1", tf: "1h", kind: "single", sig: volExpansion(donchian(48)) },
  { id: "C2", tf: "4h", kind: "single", sig: volExpansion(donchian(20)) },
  { id: "C3", tf: "15m", kind: "single", sig: volExpansion(donchian(96)) },
  { id: "D1", tf: "1h", kind: "single", sig: tsmom(168) },
  { id: "D2", tf: "4h", kind: "single", sig: tsmom(90) },
  { id: "E1", tf: "1h", kind: "xs", xs: { lookback: 168, reversal: false, maxBars: 24 } },
  { id: "E2", tf: "1h", kind: "xs", xs: { lookback: 24, reversal: true, maxBars: 24 } },
  { id: "E3", tf: "4h", kind: "xs", xs: { lookback: 180, reversal: false, maxBars: 18 } },
];
const M = CANDS.length; // 17 testes (pré-registo)

interface Series { symbol: string; candles: Candle[] }
function load(tf: string): { used: Series[]; dropped: string[] } {
  const used: Series[] = [], dropped: string[] = [];
  const expected = ({ "15m": 180 * 96, "1h": 540 * 24, "4h": 1080 * 6 } as Record<string, number>)[tf]!;
  const files = readFileSync(`${DIR}/_summary.json`, "utf8");
  void files;
  const syms = (JSON.parse(files).summary as { symbol: string; tf: string }[]).filter((s) => s.tf === tf).map((s) => s.symbol);
  for (const sym of syms) {
    const f = `${DIR}/${sym}_${tf}.json`;
    if (!existsSync(f)) { dropped.push(`${sym} (sem ficheiro)`); continue; }
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (!j.coversStart || j.n < 0.97 * expected) { dropped.push(`${sym} (${j.n}/${expected}, cobre=${j.coversStart})`); continue; }
    used.push({ symbol: sym, candles: j.candles });
  }
  return { used, dropped };
}

/** Sinais cross-seccionais por símbolo (diário, vela que fecha às 00:00 UTC). */
function xsSignals(series: Series[], sec: number, o: { lookback: number; reversal: boolean }): Map<string, Signal[]> {
  const idx = new Map<string, Map<number, number>>();
  for (const s of series) { const m = new Map<number, number>(); s.candles.forEach((c, i) => m.set(c.epoch, i)); idx.set(s.symbol, m); }
  const out = new Map<string, Signal[]>(series.map((s) => [s.symbol, zeros(s.candles.length)]));
  const epochs = new Set<number>();
  for (const s of series) for (const c of s.candles) if ((c.epoch + sec) % 86400 === 0) epochs.add(c.epoch);
  for (const e of [...epochs].sort((a, b) => a - b)) {
    const rets: { sym: string; i: number; r: number }[] = [];
    for (const s of series) {
      const m = idx.get(s.symbol)!;
      const i = m.get(e), j = m.get(e - o.lookback * sec);
      if (i === undefined || j === undefined) continue;
      rets.push({ sym: s.symbol, i, r: s.candles[i]!.close / s.candles[j]!.close - 1 });
    }
    if (rets.length < 10) continue;
    rets.sort((a, b) => b.r - a.r);
    const k = Math.floor(rets.length * 0.2);
    for (let q = 0; q < k; q++) {
      out.get(rets[q]!.sym)![rets[q]!.i] = o.reversal ? -1 : 1;
      out.get(rets[rets.length - 1 - q]!.sym)![rets[rets.length - 1 - q]!.i] = o.reversal ? 1 : -1;
    }
  }
  return out;
}

const mean = (a: readonly number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
interface Tr { sym: string; exitDay: number; r: number }

function dailySeries(trs: readonly Tr[], d0: number, d1: number, nSym: number): number[] {
  const arr = new Array<number>(Math.max(0, d1 - d0)).fill(0);
  for (const t of trs) if (t.exitDay >= d0 && t.exitDay < d1) arr[t.exitDay - d0]! += t.r / nSym;
  return arr;
}

function runCand(cand: Cand, series: Series[], cost: number, ctl?: SigFn): { disc: Tr[]; conf: Tr[]; splitEpoch: number; from: number; to: number } {
  const tf = TF[cand.tf]!;
  const t0 = Math.max(...series.map((s) => s.candles[0]!.epoch)) + WARM * tf.sec;
  const t1 = Math.min(...series.map((s) => s.candles.at(-1)!.epoch));
  // início/fim comuns: usa o primeiro/último época comum para que o nº de símbolos por dia seja o mesmo
  const split = Math.floor((t0 + (2 * (t1 - t0)) / 3) / 86400) * 86400;
  const xs = cand.kind === "xs" ? xsSignals(series, tf.sec, cand.xs!) : null;
  const disc: Tr[] = [], conf: Tr[] = [];
  const maxBars = cand.xs?.maxBars ?? tf.maxBars;
  for (const s of series) {
    const c = s.candles;
    const strat: Strategy = { name: cand.id, signals: () => (ctl ? ctl(c) : xs ? xs.get(s.symbol)! : cand.sig!(c)) };
    const strat2 = feasible(strat, { slAtr: SL_ATR, maxStopFraction: MAX_STOP });
    const sigs = strat2.signals(c);
    const a = atr(c, 14);
    const prepared = { signals: sigs, atrs: a };
    const iStart = c.findIndex((x) => x.epoch >= t0);
    const iSplit = c.findIndex((x) => x.epoch >= split);
    const iEnd = c.length - 1 - (c.at(-1)!.epoch > t1 ? c.filter((x) => x.epoch > t1).length : 0) + 1;
    const opt = { slAtr: SL_ATR, tpR: TP_R, maxBars, costFraction: cost };
    const toTr = (trades: CandleTrade[]): Tr[] => trades.map((t) => ({ sym: s.symbol, exitDay: Math.floor(c[t.exitIndex]!.epoch / 86400), r: t.r }));
    disc.push(...toTr(runCandleBacktest(c, strat2, { ...opt, start: iStart, end: iSplit }, prepared).trades));
    conf.push(...toTr(runCandleBacktest(c, strat2, { ...opt, start: iSplit, end: iEnd }, prepared).trades));
  }
  return { disc, conf, splitEpoch: split, from: t0, to: t1 };
}

interface Res {
  id: string; tf: string; nSym: number; dropped: string[]; from: string; split: string; to: string;
  nDisc: number; nConf: number; meanRDisc: number; meanRConf: number; meanRFull: number; meanRFullGross: number;
  dailyMeanDisc: number; pDisc: number | null; dailyMeanConf: number; pConf: number | null;
  adjPDisc?: number | null; passBH?: boolean;
  blocksPos: number; blocks: number; lastBlockPos: boolean; lastBlockMean: number; symPosShare: number;
  meanR_makerTP: number; meanR_slip: number; tradesPerSymPerMonth: number;
  stage?: string; pass?: boolean; checks?: Record<string, boolean>;
}
const iso = (e: number): string => new Date(e * 1000).toISOString().slice(0, 10);

function evaluate(cand: Cand, series: Series[], dropped: string[], ctlSig?: SigFn): Res {
  const prim = runCand(cand, series, COST_PRIMARY, ctlSig);
  const gross = runCand(cand, series, 0, ctlSig);
  const mk = runCand(cand, series, COST_MAKERTP, ctlSig);
  const sl = runCand(cand, series, COST_SLIP, ctlSig);
  const n = series.length;
  const d0 = Math.floor(prim.from / 86400), dS = Math.floor(prim.splitEpoch / 86400), d1 = Math.floor(prim.to / 86400);
  const all = [...prim.disc, ...prim.conf];
  const dd = dailySeries(prim.disc, d0, dS, n), dc = dailySeries(prim.conf, dS, d1, n);
  const daily = dailySeries(all, d0, d1, n);
  // blocos de 30 d a contar do fim
  const blocks: number[] = [];
  for (let e = d1; e - 30 >= d0; e -= 30) blocks.push(mean(daily.slice(e - 30 - d0, e - d0)));
  const symR = series.map((s) => mean(all.filter((t) => t.sym === s.symbol).map((t) => t.r)));
  const allR = (x: { disc: Tr[]; conf: Tr[] }): number => mean([...x.disc, ...x.conf].map((t) => t.r));
  return {
    id: cand.id, tf: cand.tf, nSym: n, dropped, from: iso(prim.from), split: iso(prim.splitEpoch), to: iso(prim.to),
    nDisc: prim.disc.length, nConf: prim.conf.length,
    meanRDisc: mean(prim.disc.map((t) => t.r)), meanRConf: mean(prim.conf.map((t) => t.r)), meanRFull: allR(prim), meanRFullGross: allR(gross),
    dailyMeanDisc: mean(dd), pDisc: expectancyPValue(dd), dailyMeanConf: mean(dc), pConf: expectancyPValue(dc),
    blocksPos: blocks.filter((b) => b > 0).length, blocks: blocks.length, lastBlockPos: (blocks[0] ?? 0) > 0, lastBlockMean: blocks[0] ?? 0,
    symPosShare: symR.filter((x) => x > 0).length / n,
    meanR_makerTP: allR(mk), meanR_slip: allR(sl),
    tradesPerSymPerMonth: all.length / n / ((d1 - d0) / 30),
  };
}

function main(): void {
  const results: Res[] = [];
  const loaded: Record<string, ReturnType<typeof load>> = {};
  for (const tf of Object.keys(TF)) { loaded[tf] = load(tf); console.error(`${tf}: ${loaded[tf]!.used.length} símbolos usados; excluídos: ${loaded[tf]!.dropped.join(", ") || "nenhum"}`); }
  for (const cand of CANDS) {
    const L = loaded[cand.tf]!;
    const r = evaluate(cand, L.used, L.dropped);
    results.push(r);
    console.error(`${cand.id} ${cand.tf} n=${r.nDisc + r.nConf} meanR=${r.meanRFull.toFixed(3)}`);
  }
  // FDR sobre os 17 p-values da descoberta (só se média diária > 0 conta como "a favor"; o p já é unilateral)
  const bh = benjaminiHochberg(results.map((r) => r.pDisc), 0.1);
  results.forEach((r, i) => { r.adjPDisc = bh.adjP[i] ?? null; r.passBH = bh.reject[i]! && r.dailyMeanDisc > 0; });
  const k = results.filter((r) => r.passBH).length;
  for (const r of results) {
    const checks = {
      "1_BH_descoberta": !!r.passBH,
      "2_confirmacao": !!r.passBH && r.dailyMeanConf > 0 && r.pConf !== null && r.pConf < 0.05 / Math.max(1, k),
      "3_blocos": r.blocks > 0 && r.blocksPos / r.blocks >= 0.6 && r.lastBlockPos,
      "4_largura": r.symPosShare >= 0.6 && r.meanRFull > 0,
      "5_custo015": r.meanR_slip > 0,
    };
    r.checks = checks;
    r.pass = Object.values(checks).every(Boolean);
    r.stage = r.pass ? "PASSA" : "falha: " + Object.entries(checks).filter(([, v]) => !v).map(([k2]) => k2).join(",");
  }
  // controlo aleatório (fora do FDR)
  const ctl = evaluate({ id: "CTL", tf: "1h", kind: "single" }, loaded["1h"]!.used, loaded["1h"]!.dropped, randomDir(12345));
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), m: M, bhPassed: k, results, control: ctl }, null, 1));
  const f = (x: number | null, d = 3): string => (x === null ? "-" : x.toFixed(d));
  console.log("id  tf   nSym  nOp(d/c)      R/op net  R/op bruto  R/op disc  R/op conf  pDisc  adjP   pConf  blocos+  ult30d  sym+   R@0.075  R@0.15  op/sim/mês  veredicto");
  for (const r of results) {
    console.log(`${r.id.padEnd(3)} ${r.tf.padEnd(4)} ${String(r.nSym).padStart(3)}  ${String(r.nDisc).padStart(6)}/${String(r.nConf).padEnd(6)} ${f(r.meanRFull).padStart(9)} ${f(r.meanRFullGross).padStart(10)} ${f(r.meanRDisc).padStart(10)} ${f(r.meanRConf).padStart(10)} ${f(r.pDisc).padStart(6)} ${f(r.adjPDisc ?? null).padStart(6)} ${f(r.pConf).padStart(6)}  ${r.blocksPos}/${r.blocks}`.padEnd(5) + `   ${f(r.lastBlockMean, 4).padStart(8)}  ${(r.symPosShare * 100).toFixed(0).padStart(3)}%  ${f(r.meanR_makerTP).padStart(7)} ${f(r.meanR_slip).padStart(7)}  ${r.tradesPerSymPerMonth.toFixed(1).padStart(6)}   ${r.stage}`);
  }
  console.log(`\nm=${M} testes; passam BH(q=0,10) na descoberta: ${k}; passam TODAS as regras: ${results.filter((r) => r.pass).length}`);
  console.log(`Controlo aleatório (1h, fora do FDR): n=${ctl.nDisc + ctl.nConf}, R/op net ${f(ctl.meanRFull)}, bruto ${f(ctl.meanRFullGross)}`);
  for (const tf of Object.keys(TF)) console.log(`${tf}: ${results.find((r) => r.tf === tf)!.nSym} símbolos; período ${results.find((r) => r.tf === tf)!.from} → ${results.find((r) => r.tf === tf)!.to} (divisão ${results.find((r) => r.tf === tf)!.split}); excluídos: ${loaded[tf]!.dropped.join("; ") || "nenhum"}`);
}
main();
