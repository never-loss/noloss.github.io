// Descarrega klines 1 h REAIS (com volume) Bybit linear via proxy do projecto. node scripts/ad-fetch.mjs --out /workspace/tmp/ad
import { mkdirSync, writeFileSync } from "node:fs";
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "/workspace/tmp/ad"), PROXY = "https://noloss-zeta.vercel.app", DAYS = 560;
const U = "BTC ETH SOL XRP DOGE BNB ADA AVAX LINK LTC DOT TRX BCH ATOM NEAR APT ARB OP SUI INJ FIL ETC UNI AAVE XLM HBAR ICP ALGO RUNE CRV 1000PEPE WIF SHIB1000 1000BONK TIA SEI WLD ORDI LDO ENA".split(" ").map((s) => s + "USDT");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function page(sym, end) {
  for (let a = 0; a < 6; a++) {
    try { const r = await fetch(`${PROXY}/api/bybit-klines?symbol=${sym}&interval=60&limit=1000&end=${end}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { const j = await r.json(); if (j.retCode === 0) return j.result.list; } } catch {}
    await sleep(700 * (a + 1));
  }
  throw new Error(`falha ${sym} ${end}`);
}
mkdirSync(OUT, { recursive: true });
const last = (Math.floor(Date.now() / 3600000) - 1) * 3600, oldest = last - DAYS * 86400;
let i = 0;
async function worker() { while (i < U.length) { const s = U[i++]; try {
  const m = new Map(); let end = (last + 3600) * 1000 - 1;
  for (let g = 0; g < 20; g++) { const l = await page(s, end); if (!l.length) break; let mn = Infinity;
    for (const r of l) { const t = Number(r[0]) / 1000; mn = Math.min(mn, t); if (t > last || t < oldest) continue;
      m.set(t, { epoch: t, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }); }
    if (mn <= oldest || l.length < 1000) break; end = mn * 1000 - 1; }
  const c = [...m.values()].sort((a, b) => a.epoch - b.epoch);
  writeFileSync(`${OUT}/${s}.json`, JSON.stringify(c)); console.log(s, c.length, new Date((c[0]?.epoch ?? 0) * 1000).toISOString().slice(0, 10));
} catch (e) { console.log("ERRO", s, e.message); } } }
await Promise.all([1, 2, 3, 4].map(worker));
