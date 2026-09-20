// Pesquisa em velas reais (Forex, ouro, cripto): sem login, sem operações.
// Uso: node src/cli/research-candles.ts --symbols cryBTCUSD,cryETHUSD,frxEURUSD --candles 6000 --granularity 300
import { parseCandlesMessage } from "../core/market-data.ts";
import type { Candle } from "../core/market-data.ts";
import { mergeCandlePages, nextCandleEnd } from "../core/candle-pages.ts";
import { runCandleResearch, formatCandleReport } from "../core/candle-research.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbols = arg("symbols", "cryBTCUSD,cryETHUSD,frxEURUSD,frxGBPUSD,frxUSDJPY,frxXAUUSD")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const target = Number(arg("candles", "6000"));
const granularity = Number(arg("granularity", "300"));
const slAtr = Number(arg("sl-atr", "1.5"));
const tpR = Number(arg("tp-r", "2"));
const maxBars = Number(arg("max-bars", "24"));
const costOverride = arg("cost", "");
const pageSize = 1000;

if (!Number.isInteger(target) || target < 1500 || target > 20000) {
  console.error("--candles tem de ser um inteiro entre 1500 e 20000");
  process.exit(1);
}
if (!Number.isInteger(granularity) || granularity < 60) {
  console.error("--granularity tem de ser um inteiro >= 60");
  process.exit(1);
}

/** Custos de ida e volta ASSUMIDOS (fração do preço). São suposições até medirmos os reais na Deriv. */
function costFor(symbol: string): number {
  if (costOverride !== "") return Number(costOverride);
  return symbol.startsWith("cry") ? 0.001 : 0.0001;
}

const ws = new WebSocket(URL);
let nextId = 1;
const waiting = new Map<number, (raw: string) => void>();

ws.onmessage = (event: MessageEvent) => {
  const raw = String(event.data);
  try {
    const id = (JSON.parse(raw) as { req_id?: unknown }).req_id;
    if (typeof id === "number" && waiting.has(id)) {
      const done = waiting.get(id)!;
      waiting.delete(id);
      done(raw);
    }
  } catch {
    // ignora mensagens que não são JSON
  }
};

function requestRaw(payload: Record<string, unknown>): Promise<string> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("Sem resposta da Deriv em 30 segundos"));
    }, 30_000);
    waiting.set(id, (raw) => {
      clearTimeout(timer);
      resolve(raw);
    });
    ws.send(JSON.stringify({ ...payload, req_id: id }));
  });
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
  const pages: Candle[][] = [];
  let end: number | "latest" = "latest";
  let total = 0;
  for (let p = 1; p <= 30 && total < target; p++) {
    const m = parseCandlesMessage(
      await requestRaw({ ticks_history: symbol, end, count: pageSize, style: "candles", granularity }),
    );
    if (m.kind !== "candles" || m.candles.length === 0) {
      const why = m.kind === "error" ? `${m.code} - ${m.message}` : m.kind === "invalid" ? m.reason : "página vazia";
      console.warn(`  ${symbol}: página ${p}: ${why}. A continuar com o que já tenho.`);
      break;
    }
    pages.push(m.candles);
    total = mergeCandlePages(pages).length;
    const next = nextCandleEnd(m.candles);
    if (next === null) break;
    end = next;
  }
  return mergeCandlePages(pages).slice(-target);
}

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Erro de ligação ao WebSocket"));
  });
  console.log(`Ligado. A pedir até ${target} velas de ${granularity}s para ${symbols.length} símbolos...`);

  const data: Record<string, Candle[]> = {};
  for (const sym of symbols) {
    const candles = await fetchCandles(sym);
    const first = candles[0];
    const last = candles[candles.length - 1];
    console.log(
      `  ${sym}: ${candles.length} velas` +
        (first && last ? ` (${new Date(first.epoch * 1000).toISOString().slice(0, 10)} a ${new Date(last.epoch * 1000).toISOString().slice(0, 10)})` : ""),
    );
    if (candles.length >= 1500) data[sym] = candles;
    else console.warn(`  ${sym}: poucas velas (${candles.length}); ignorado.`);
  }
  if (Object.keys(data).length === 0) throw new Error("Nenhum símbolo com velas suficientes");

  const smallest = Math.min(...Object.values(data).map((c) => c.length));
  const trainSize = Math.min(2000, Math.floor(smallest * 0.5));
  const testSize = Math.min(500, Math.floor(smallest * 0.25));
  const opts = { slAtr, tpR, maxBars, costFor, trainSize, testSize };
  console.log(formatCandleReport(runCandleResearch(data, opts), opts));
}

main()
  .catch((e) => {
    console.error(`Erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    ws.close();
    setTimeout(() => process.exit(process.exitCode ?? 0), 100);
  });
