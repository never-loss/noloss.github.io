// Pesquisa longa: vários pedidos de histórico (sem login) e relatório + porta de evidência.
// Uso: node src/cli/research-long.ts --symbol 1HZ100V --pages 5 --return 0.82 --return-high 8
import { parseHistoryMessage, digitsFromPrices } from "../core/history.ts";
import type { HistoryMessage } from "../core/history.ts";
import { mergeHistoryPages, nextPageEnd } from "../core/history-pages.ts";
import type { HistoryPage } from "../core/history-pages.ts";
import { runResearch, formatReport } from "../core/research.ts";
import { evaluateGate, formatGate } from "../core/gate.ts";
import { laneARules, laneBRules } from "../core/lanes.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbol = arg("symbol", "1HZ100V");
const pages = Number(arg("pages", "5"));
const returnA = Number(arg("return", "0.82"));
const returnB = Number(arg("return-high", "8"));
const fallbackPip = Number(arg("pip", "2"));

if (!Number.isInteger(pages) || pages < 1 || pages > 10) {
  console.error("--pages tem de ser um inteiro entre 1 e 10");
  process.exit(1);
}
if (!(returnA > 0) || !(returnB > 0)) {
  console.error("--return e --return-high têm de ser positivos");
  process.exit(1);
}

const ws = new WebSocket(URL);
let nextId = 1;
const waiting = new Map<number, (m: HistoryMessage) => void>();

ws.onmessage = (event: MessageEvent) => {
  const raw = String(event.data);
  let reqId: unknown;
  try {
    reqId = (JSON.parse(raw) as { req_id?: unknown }).req_id;
  } catch {
    return;
  }
  if (typeof reqId === "number" && waiting.has(reqId)) {
    const done = waiting.get(reqId)!;
    waiting.delete(reqId);
    done(parseHistoryMessage(raw));
  }
};

function request(payload: Record<string, unknown>): Promise<HistoryMessage> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("Sem resposta da Deriv em 30 segundos"));
    }, 30_000);
    waiting.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    ws.send(JSON.stringify({ ...payload, req_id: id }));
  });
}

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Erro de ligação ao WebSocket"));
  });
  console.log(`Ligado. A pedir até ${pages} páginas de ${symbol}...`);

  const got: HistoryPage[] = [];
  let pip: number | null = null;
  let end: number | "latest" = "latest";

  for (let i = 1; i <= pages; i++) {
    const m = await request({ ticks_history: symbol, end, count: 1000, style: "ticks" });
    if (m.kind !== "history" || m.prices.length === 0) {
      const why = m.kind === "error" ? `${m.code} - ${m.message}` : m.kind === "invalid" ? m.reason : "página vazia";
      console.warn(`Página ${i}: ${why}. A continuar com o que já tenho.`);
      break;
    }
    if (pip === null) pip = m.pipSize;
    got.push({ prices: m.prices, times: m.times });
    console.log(`Página ${i}: ${m.prices.length} ticks.`);
    const next = nextPageEnd(m.times);
    if (next === null) break;
    end = next;
  }

  if (got.length === 0) throw new Error("Não recebi nenhum tick");
  const merged = mergeHistoryPages(got);
  const usedPip = pip ?? fallbackPip;
  if (pip === null) console.warn(`Aviso: sem pip_size na resposta; a usar --pip ${fallbackPip}.`);
  const digits = digitsFromPrices(merged.prices, usedPip);
  console.log(`Total: ${digits.length} ticks únicos (pip_size ${usedPip}).`);

  const trainSize = Math.min(1000, Math.floor(digits.length * 0.5));
  const testSize = Math.min(500, Math.floor(digits.length * 0.25));
  console.log(formatReport(runResearch(digits, { returnA, returnB, trainSize, testSize })));

  console.log("");
  console.log("=== PORTA DE EVIDÊNCIA (últimos 3000 ticks) ===");
  const recent = digits.slice(-3000);
  console.log(`Faixa A: ${formatGate(evaluateGate(recent, laneARules(returnA)))}`);
  console.log(`Faixa B: ${formatGate(evaluateGate(recent, laneBRules(returnB)))}`);
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
