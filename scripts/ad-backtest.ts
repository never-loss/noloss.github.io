// Backtest pré-registado notes/preregistro-analista-diario-2026-10-27.md (dados reais 1 h via proxy).
//   node scripts/ad-backtest.ts --dir /workspace/tmp/ad --out notes/data/analista-diario-2026-10-27.json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { expectancyPValue } from "../src/core/candle-backtest.ts";
import { benjaminiHochberg } from "../src/core/fdr.ts";
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1]! : d; };
const DIR = arg("dir", "/workspace/tmp/ad"), OUT = arg("out", "/workspace/tmp/ad-results.json");
type C = { epoch: number; open: number; high: number; low: number; close: number; volume: number };
const U = "BTC ETH SOL XRP DOGE BNB ADA AVAX LINK LTC DOT TRX BCH ATOM NEAR APT ARB OP SUI INJ FIL ETC UNI AAVE XLM HBAR ICP ALGO RUNE CRV 1000PEPE WIF SHIB1000 1000BONK TIA SEI WLD ORDI LDO ENA".split(" ").map((s) => s + "USDT");
const NEED = Date.parse("2025-05-01T00:00:00Z") / 1000, TR0 = Date.parse("2025-06-01T00:00:00Z") / 1000, OOS0 = Date.parse("2026-05-01T00:00:00Z") / 1000;
const STOP = 0.005, TP = 0.01;
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function ema(v: number[], n: number) { const k = 2 / (n + 1); const o: number[] = []; v.forEach((x, i) => o.push(i ? x * k + o[i - 1]! * (1 - k) : x)); return o; }
type Day = { d: number; o: number; h: number; l: number; c: number; ema20: number; atrp: number };
function daily(c: C[]): Map<number, Day> {
  const g = new Map<number, C[]>(); for (const x of c) { const d = Math.floor(x.epoch / 86400); (g.get(d) ?? g.set(d, []).get(d)!).push(x); }
  const ds = [...g.entries()].filter(([, v]) => v.length >= 20).sort((a, b) => a[0] - b[0]).map(([d, v]) => ({ d, o: v[0]!.open, h: Math.max(...v.map((x) => x.high)), l: Math.min(...v.map((x) => x.low)), c: v.at(-1)!.close, ema20: 0, atrp: 0 }));
  const e = ema(ds.map((x) => x.c), 20); let atr = 0;
  ds.forEach((x, i) => { x.ema20 = e[i]!; const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - ds[i - 1]!.c), Math.abs(x.l - ds[i - 1]!.c)) : x.h - x.l; atr = i < 14 ? (atr * i + tr) / (i + 1) : (atr * 13 + tr) / 14; x.atrp = atr / x.c; });
  return new Map(ds.map((x, i) => [x.d, i >= 25 ? x : null]).filter(([, v]) => v) as [number, Day][]);
}
type T = { sym: string; t: number; dir: 1 | -1; move: number };
const IDS = ["AD1", "AD2", "AD3", "AD4", "AD5", "AD6"] as const;
function run(sym: string, c: C[], D: Map<number, Day>, B: Map<number, Day>, id: string): T[] {
  const e20 = ema(c.map((x) => x.close), 20); const out: T[] = []; let busyUntil = -1, lastDay = -1;
  for (let i = 25; i < c.length - 1; i++) {
    const x = c[i]!, day = Math.floor(x.epoch / 86400), y = D.get(day - 1), b = B.get(day - 1);
    if (!y || !b || i <= busyUntil || day === lastDay) continue;
    const tr: 0 | 1 | -1 = y.c > y.ema20 ? 1 : y.c < y.ema20 ? -1 : 0; const br = b.c > b.ema20 ? 1 : b.c < b.ema20 ? -1 : 0;
    if (!tr || tr !== br) continue;
    let sig = false;
    if (id === "AD1" || id === "AD4") { sig = tr > 0 ? x.low <= e20[i]! && x.close > e20[i]! : x.high >= e20[i]! && x.close < e20[i]!; if (id === "AD4" && y.atrp < 0.02) sig = false; }
    else if (id === "AD2") { const av = mean(c.slice(i - 20, i).map((z) => z.volume)); sig = x.volume > 1.5 * av && (tr > 0 ? x.close > y.h : x.close < y.l); }
    else if (id === "AD3") sig = tr > 0 ? x.low < y.l && x.close > y.l : x.high > y.h && x.close < y.h;
    else if (id === "AD5") { const h = (x.epoch % 86400) / 3600; if (h >= 4) { const r = c.slice(i - h, i - h + 4).filter((z) => Math.floor(z.epoch / 86400) === day); if (r.length === 4) { const hi = Math.max(...r.map((z) => z.high)), lo = Math.min(...r.map((z) => z.low)); sig = tr > 0 ? x.close > hi : x.close < lo; } } }
    else if (id === "AD6") { if ((x.epoch + 3600) % 14400 === 0 && i >= 84) { const f = (k: number) => c.slice(k - 3, k + 1); const bars: { h: number; l: number; c: number }[] = []; for (let k = i; k >= i - 83; k -= 4) { const s = f(k); if (s.length < 4 || s[0]!.epoch !== c[k]!.epoch - 10800) { bars.length = 0; break; } bars.push({ h: Math.max(...s.map((z) => z.high)), l: Math.min(...s.map((z) => z.low)), c: s[3]!.close }); } if (bars.length === 21) { const prev = bars.slice(1); sig = tr > 0 ? bars[0]!.c > Math.max(...prev.map((z) => z.h)) : bars[0]!.c < Math.min(...prev.map((z) => z.l)); } } }
    if (!sig) continue;
    const ent = c[i + 1]!; if (Math.floor(ent.epoch / 86400) !== day && id !== "AD6") continue;
    const eday = Math.floor(ent.epoch / 86400); const p0 = ent.open; let move: number | null = null, j = i + 1;
    for (; j < c.length; j++) { const z = c[j]!; if (Math.floor(z.epoch / 86400) !== eday) { j--; break; }
      const adv = tr > 0 ? (z.low - p0) / p0 : (p0 - z.high) / p0, fav = tr > 0 ? (z.high - p0) / p0 : (p0 - z.low) / p0;
      if (adv <= -STOP) { move = -STOP; break; } if (fav >= TP) { move = TP; break; } }
    if (j >= c.length) continue;
    if (move === null) { const z = c[j]!; if (z.epoch + 3600 > c.at(-1)!.epoch + 3600 && Math.floor(z.epoch / 86400) === Math.floor(c.at(-1)!.epoch / 86400)) continue; move = tr * (z.close - p0) / p0; }
    out.push({ sym, t: ent.epoch, dir: tr, move }); busyUntil = j; lastDay = eday;
  }
  return out;
}
const used: string[] = [], dropped: string[] = []; const data = new Map<string, C[]>();
for (const s of U) { const f = `${DIR}/${s}.json`; if (!existsSync(f)) { dropped.push(`${s} (sem dados)`); continue; } const c = JSON.parse(readFileSync(f, "utf8")) as C[]; if (!c.length || c[0]!.epoch > NEED) { dropped.push(`${s} (começa ${c[0] ? new Date(c[0].epoch * 1000).toISOString().slice(0, 10) : "-"})`); continue; } data.set(s, c); }
const maxEnd = Math.max(...[...data.values()].map((c) => c.at(-1)!.epoch));
for (const [s, c] of data) if (c.at(-1)!.epoch < maxEnd - 2 * 86400) { dropped.push(`${s} (acaba cedo)`); data.delete(s); } else used.push(s);
const DD = new Map([...data].map(([s, c]) => [s, daily(c)])); const BD = DD.get("BTCUSDT")!;
const R = (m: number, cost: number) => (m - cost) / STOP;
const all: Record<string, T[]> = {}; for (const id of IDS) all[id] = used.flatMap((s) => run(s, data.get(s)!, DD.get(s)!, BD, id));
function stats(tr: T[], cost: number) { const rs = tr.map((t) => R(t.move, cost)); const days = new Map<number, number[]>(); tr.forEach((t, k) => { const d = Math.floor(t.t / 86400); (days.get(d) ?? days.set(d, []).get(d)!).push(rs[k]!); });
  const dm = [...days.values()].map(mean); return { n: tr.length, win: tr.filter((t) => t.move >= TP).length / (tr.length || 1), posClose: rs.filter((r) => r > 0).length / (rs.length || 1), avgR: mean(rs), pctPerTrade: mean(tr.map((t) => (t.move - cost) * 100)), p: expectancyPValue(rs) ?? 1, pDaily: expectancyPValue(dm) ?? 1 }; }
const rows = IDS.map((id) => { const oos = all[id]!.filter((t) => t.t >= OOS0), trn = all[id]!.filter((t) => t.t >= TR0 && t.t < OOS0);
  const perSym = used.map((s) => ({ s, n: oos.filter((t) => t.sym === s).length, avgR: mean(oos.filter((t) => t.sym === s).map((t) => R(t.move, 0.001))) }));
  return { id, train: stats(trn, 0.001), oos: stats(oos, 0.001), oos011: stats(oos, 0.0011), oosGross: stats(oos, 0), symPos: perSym.filter((x) => x.n && x.avgR > 0).length / perSym.filter((x) => x.n).length, perSym }; });
const bh = benjaminiHochberg(rows.map((r) => r.oos.p), 0.01);
const res = rows.map((r, i) => { const adj = bh.adjP[i]!; const ck = { "1_n100_R>0": r.oos.n >= 100 && r.oos.avgR > 0, "2_BH<0.01": adj < 0.01, "3_pDiario<0.01": r.oos.pDaily < 0.01, "4_R>0@0.11%": r.oos011.avgR > 0, "5_simb60%": r.symPos >= 0.6 }; return { ...r, adjP: adj, checks: ck, pass: Object.values(ck).every(Boolean) }; });
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), used, dropped, oosFrom: "2026-05-01", to: new Date((maxEnd + 3600) * 1000).toISOString(), results: res }, null, 1));
const f = (x: number, d = 3) => x.toFixed(d);
console.log(`símbolos ${used.length}; excluídos: ${dropped.join("; ") || "nenhum"}; fim ${new Date((maxEnd + 3600) * 1000).toISOString()}`);
console.log("| id | treino n / R | OOS n | acerto alvo 1% | R/op 0,1% | %/op 0,1% | R/op bruto | R/op 0,11% | p op | p BH | p diário | símb R>0 | veredicto |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of res) console.log(`| ${r.id} | ${r.train.n} / ${f(r.train.avgR)} | ${r.oos.n} | ${f(r.oos.win * 100, 1)}% | ${f(r.oos.avgR)} | ${f(r.oos.pctPerTrade)} | ${f(r.oosGross.avgR)} | ${f(r.oos011.avgR)} | ${f(r.oos.p)} | ${f(r.adjP)} | ${f(r.oos.pDaily)} | ${f(r.symPos * 100, 0)}% | ${r.pass ? "PASSA" : "falha: " + Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(",")} |`);
