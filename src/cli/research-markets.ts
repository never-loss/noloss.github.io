// Pesquisa em velas reais, separada por mercado (forex, metais, cripto). Sem login, sem operações.
// Uso: node src/cli/research-markets.ts --granularity 3600 --candles 6000
import { parseCandlesMessage } from "../core/market-data.ts";
import type { Candle } from "../core/market-data.ts";
import { mergeCandlePages, nextCandleEnd } from "../core/candle-pages.ts";
import { runMarketResearch, formatMarketReport } from "../core/market-research.ts";
import { marketOf, marketStatus, MARKETS } from "../core/markets.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbols = arg("symbols", "frxEURUSD,frxGBPUSD,frxUSDJPY,frxXAUUSD,cryBTCUSD,cryETHUSD")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const target = Number(arg("candles", "6000"));
const granularity = Number(arg("granularity", "3600"));
const slAtr = Number(arg("sl-atr", "1.5"));
const tpR = Number(arg("tp-r", "2"));
const maxBars = Number(arg("max-bars", "24"));
const costArg = arg("cost", "");
const pageSize = 1000;

if (!Number.isInteger(target) || target < 1500 || target > 20000) {
  console.error("--candles tem de ser um inteiro entre 1500 e 20000");
  process.exit(1);
}
if (!Number.isInteger(granularity) || granularity < 60) {
  console.error("--granularity tem de ser um inteiro >= 60");
  process.exit(1);
}
for (const s of symbols) {
  if (marketOf(s) === null) {
    console.error(`Símbolo desconhecido (não é forex, metal nem cripto): ${s}`);
    process.exit(1);
  }
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
  console.log(`Ligado. Velas de ${granularity}s, até ${target} por símbolo.`);

  const data: Record<string, Candle[]> = {};
  for (const sym of symbols) {
    const candles = await fetchCandles(sym);
    const kind = marketOf(sym)!;
    const first = candles[0];
    const last = candles[candles.length - 1];
    const status = last ? marketStatus(kind, last.epoch, Date.now(), granularity) : "unknown";
    console.log(
      `  [${MARKETS[kind].label.split(" ")[0]}] ${sym}: ${candles.length} velas` +
        (first && last ? ` (${new Date(first.epoch * 1000).toISOString().slice(0, 10)} a ${new Date(last.epoch * 1000).toISOString().slice(0, 10)})` : "") +
        ` | mercado agora: ${status}`,
    );
    if (candles.length >= 1500) data[sym] = candles;
    else console.warn(`  ${sym}: poucas velas (${candles.length}); ignorado.`);
  }
  if (Object.keys(data).length === 0) throw new Error("Nenhum símbolo com velas suficientes");

  const smallest = Math.min(...Object.values(data).map((c) => c.length));
  const trainSize = Math.min(2000, Math.floor(smallest * 0.5));
  const testSize = Math.min(500, Math.floor(smallest * 0.25));
  const opts = {
    slAtr,
    tpR,
    maxBars,
    trainSize,
    testSize,
    ...(costArg !== "" ? { costOverride: Number(costArg) } : {}),
  };
  console.log(formatMarketReport(runMarketResearch(data, opts)));
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
