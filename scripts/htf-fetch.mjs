// Descarrega klines REAIS Bybit linear (via proxy do projecto) para 15m/1h/4h e guarda em JSON (cache local).
//   node scripts/htf-fetch.mjs [--out /workspace/tmp/htf] [--proxy https://noloss-zeta.vercel.app]
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg("out", "/workspace/tmp/htf");
const PROXY = arg("proxy", "https://noloss-zeta.vercel.app");
export const UNIVERSE = "BTC ETH SOL XRP DOGE BNB ADA AVAX LINK LTC DOT TRX BCH ATOM NEAR APT ARB OP SUI INJ FIL ETC UNI AAVE XLM HBAR ICP ALGO RUNE CRV".split(" ").map((s) => s + "USDT");
const ALLTFS = [{ id: "15m", interval: "15", sec: 900, days: 180 }, { id: "1h", interval: "60", sec: 3600, days: 540 }, { id: "4h", interval: "240", sec: 14400, days: 1080 }];
const TFSEL = arg("tfs", "");
const DAYS = Number(arg("days", "0"));
const TFS = ALLTFS.filter((t) => !TFSEL || TFSEL.split(",").includes(t.id)).map((t) => ({ ...t, days: DAYS || t.days }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function page(sym, interval, end) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`${PROXY}/api/bybit-klines?symbol=${sym}&interval=${interval}&limit=1000&end=${end}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { const j = await r.json(); if (j.retCode === 0) return j.result.list; }
    } catch {}
    await sleep(500 * (a + 1));
  }
  throw new Error(`falha ${sym} ${interval} ${end}`);
}
async function fetchSym(sym, tf, nowMs) {
  const lastClosed = (Math.floor(nowMs / 1000 / tf.sec) - 1) * tf.sec; // início da última vela fechada
  const oldest = lastClosed - tf.days * 86400;
  const map = new Map();
  let end = (lastClosed + tf.sec) * 1000 - 1; // inclui a última fechada
  let complete = true;
  for (let g = 0; g < 80; g++) {
    const list = await page(sym, tf.interval, end);
    if (!list.length) break;
    let minT = Infinity;
    for (const r of list) {
      const t = Math.floor(Number(r[0]) / 1000);
      if (t < minT) minT = t;
      if (t > lastClosed || t < oldest) continue;
      const v = Number(r[5]);
      if (!(v > 0)) continue;
      map.set(t, { epoch: t, open: +r[1], high: +r[2], low: +r[3], close: +r[4] });
    }
    if (minT <= oldest) break;
    if (list.length < 1000) { complete = false; break; } // histórico acaba (listagem recente)
    end = minT * 1000 - 1;
  }
  const candles = [...map.values()].sort((a, b) => a.epoch - b.epoch);
  const expected = tf.days * 86400 / tf.sec;
  const first = candles[0]?.epoch ?? Infinity;
  const coversStart = first <= oldest + 5 * tf.sec;
  return { symbol: sym, tf: tf.id, n: candles.length, expected, coversStart, from: first, to: candles.at(-1)?.epoch, candles };
}
mkdirSync(OUT, { recursive: true });
const nowMs = Date.now();
const jobs = [];
const ONLY = arg("only", ""); // ex.: SUIUSDT:15m,UNIUSDT:15m (repetir só falhas)
for (const tf of TFS) for (const s of UNIVERSE) if (!ONLY || ONLY.split(",").includes(`${s}:${tf.id}`)) jobs.push([s, tf]);
let idx = 0; const summary = [];
async function worker() {
  while (idx < jobs.length) {
    const [s, tf] = jobs[idx++];
    try {
      const r = await fetchSym(s, tf, nowMs);
      writeFileSync(`${OUT}/${s}_${tf.id}.json`, JSON.stringify(r));
      summary.push({ symbol: s, tf: tf.id, n: r.n, expected: r.expected, coversStart: r.coversStart });
      console.log(`${s} ${tf.id} n=${r.n}/${r.expected} cobre=${r.coversStart}`);
    } catch (e) { console.log(`ERRO ${s} ${tf.id} ${e.message}`); summary.push({ symbol: s, tf: tf.id, error: String(e.message) }); }
  }
}
await Promise.all([1, 2, 3, 4].map(worker));
if (ONLY) {
  const prev = existsSync(`${OUT}/_summary.json`) ? JSON.parse((await import("node:fs")).readFileSync(`${OUT}/_summary.json`, "utf8")) : { summary: [] };
  const keep = prev.summary.filter((x) => !summary.some((y) => y.symbol === x.symbol && y.tf === x.tf));
  writeFileSync(`${OUT}/_summary.json`, JSON.stringify({ ...prev, retriedAt: new Date(nowMs).toISOString(), summary: [...keep, ...summary] }, null, 1));
} else writeFileSync(`${OUT}/_summary.json`, JSON.stringify({ fetchedAt: new Date(nowMs).toISOString(), proxy: PROXY, summary }, null, 1));
console.log("FIM");
