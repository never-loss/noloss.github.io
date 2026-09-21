// Paper trading AO VIVO em velas (Forex, metais, cripto) com PORTA DE EVIDÊNCIA. Sem login, sem dinheiro.
// Só opera (simulado) se a estratégia passar no teste fora da amostra, com custos e só com stops executáveis.
// Uso: node src/cli/paper-candles.ts --symbol cryBTCUSD --granularity 300 --minutes 60
import { parseCandlesMessage } from "../core/market-data.ts";
import type { Candle } from "../core/market-data.ts";
import { mergeCandlePages, nextCandleEnd } from "../core/candle-pages.ts";
import { marketOf, marketStatus, MARKETS } from "../core/markets.ts";
import { feasible } from "../core/feasible.ts";
import { strategyLibrary } from "../core/strategies.ts";
import { CandleGateController, formatCandleGate } from "../core/candle-gate.ts";
import { CandlePaperSession, formatCandleEvent, formatCandleSummary } from "../core/candle-paper.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbol = arg("symbol", "cryBTCUSD");
const granularity = Number(arg("granularity", "300"));
const stake = Number(arg("stake", "1"));
const minutes = Number(arg("minutes", "60"));
const slAtr = Number(arg("sl-atr", "1.5"));
const tpR = Number(arg("tp-r", "2"));
const maxBars = Number(arg("max-bars", "24"));
const minMultiplier = Number(arg("min-multiplier", "100"));
const revalidateEvery = Number(arg("revalidate", "12"));
const pollSeconds = Number(arg("poll", "20"));
const historyTarget = Number(arg("history", "3500"));
const maxLoss = Number(arg("max-loss", String(stake * 10)));
const maxTrades = Number(arg("max-trades", "50"));
const maxConsecutiveLosses = Number(arg("max-consecutive-losses", "6"));
const cooldownCandles = Number(arg("cooldown", "0"));
const minLabel = arg("min-label", "PRELIMINARY").toUpperCase() === "EVIDENCE" ? "EVIDENCE" : "PRELIMINARY";
const kind = marketOf(symbol);
const costFraction = arg("cost", "") !== "" ? Number(arg("cost", "")) : kind ? MARKETS[kind].assumedCostFraction : NaN;

if (kind === null) {
  console.error(`Símbolo desconhecido (não é forex, metal nem cripto): ${symbol}`);
  process.exit(1);
}
if (!Number.isInteger(granularity) || granularity < 60 || !(minutes > 0) || minutes > 180 || !(pollSeconds >= 5)) {
  console.error("Parâmetros inválidos: --granularity >= 60, --minutes entre 1 e 180, --poll >= 5");
  process.exit(1);
}
if (!Number.isInteger(historyTarget) || historyTarget < 1500 || historyTarget > 10000 || !Number.isFinite(costFraction)) {
  console.error("Parâmetros inválidos: --history entre 1500 e 10000 e --cost numérico");
  process.exit(1);
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

/** Só velas FECHADAS (a última pode ainda estar a formar-se). */
function closedOnly(candles: Candle[]): Candle[] {
  const nowSec = Date.now() / 1000;
  return candles.filter((c) => c.epoch + granularity <= nowSec);
}

async function fetchHistory(): Promise<Candle[]> {
  const pages: Candle[][] = [];
  let end: number | "latest" = "latest";
  let total = 0;
  for (let p = 1; p <= 30 && total < historyTarget; p++) {
    const m = parseCandlesMessage(
      await requestRaw({ ticks_history: symbol, end, count: 1000, style: "candles", granularity }),
    );
    if (m.kind !== "candles" || m.candles.length === 0) {
      const why = m.kind === "error" ? `${m.code} - ${m.message}` : m.kind === "invalid" ? m.reason : "página vazia";
      console.warn(`Histórico: página ${p}: ${why}. A continuar com o que já tenho.`);
      break;
    }
    pages.push(m.candles);
    total = mergeCandlePages(pages).length;
    const next = nextCandleEnd(m.candles);
    if (next === null) break;
    end = next;
  }
  return closedOnly(mergeCandlePages(pages)).slice(-historyTarget);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Erro de ligação ao WebSocket"));
  });

  const history = await fetchHistory();
  const last = history[history.length - 1];
  if (!last || history.length < 1500) throw new Error(`Histórico insuficiente (${history.length} velas)`);
  const status = marketStatus(kind!, last.epoch, Date.now(), granularity);
  console.log(
    `Ligado. Paper trading em ${symbol} [${MARKETS[kind!].label.split(" ")[0]}] | velas de ${granularity}s | risco por operação ${stake} | custo assumido ${(costFraction * 100).toFixed(3)}% | ${minutes} min | mercado agora: ${status}`,
  );
  if (status === "closed") {
    console.log("Mercado fechado: nada a fazer agora. Tenta quando o mercado abrir (forex e metais: de domingo às 22:00 UTC a sexta às 21:00 UTC).");
    return;
  }
  console.log(`Histórico: ${history.length} velas até ${new Date(last.epoch * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC.`);

  const n = history.length;
  const trainSize = Math.min(1000, Math.floor(n * 0.4));
  const testSize = Math.min(500, Math.floor(n * 0.2));
  const strategies = strategyLibrary().map((s) => feasible(s, { slAtr, maxStopFraction: 1 / minMultiplier }));
  const controller = new CandleGateController({
    strategies,
    gate: { slAtr, tpR, maxBars, costFraction, trainSize, testSize, minLabel },
    revalidateEvery,
    maxBuffer: 3500,
    initial: history,
  });
  console.log(`[início] ${formatCandleGate(controller.result)}`);

  const session = new CandlePaperSession({
    strategy: controller.asStrategy(),
    stake,
    slAtr,
    tpR,
    maxBars,
    costFraction,
    maxLoss,
    maxTrades,
    maxDurationMs: Math.min(minutes, 180) * 60_000,
    maxConsecutiveLosses,
    cooldownCandles,
  });
  for (const e of session.start(last.epoch * 1000)) console.log(formatCandleEvent(e));

  const deadline = Date.now() + minutes * 60_000;
  let lastEpoch = last.epoch;
  let seen = 0;
  while (Date.now() < deadline && !(session.status === "STOPPED" && !session.hasOpenPosition)) {
    await sleep(pollSeconds * 1000);
    let fresh: Candle[] = [];
    try {
      const m = parseCandlesMessage(
        await requestRaw({ ticks_history: symbol, end: "latest", count: 10, style: "candles", granularity }),
      );
      if (m.kind === "candles") fresh = closedOnly(m.candles).filter((c) => c.epoch > lastEpoch).sort((a, b) => a.epoch - b.epoch);
      else if (m.kind === "error") console.warn(`Aviso: ${m.code} - ${m.message}`);
    } catch (e) {
      console.warn(`Aviso: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const c of fresh) {
      lastEpoch = c.epoch;
      seen += 1;
      const changed = controller.push(c);
      const stamp = new Date(c.epoch * 1000).toISOString().slice(11, 16);
      console.log(`${stamp}  vela fechada ${String(Number(c.close.toPrecision(8)))}`);
      if (changed || seen % revalidateEvery === 0) console.log(`[vela ${seen}] ${formatCandleGate(controller.result)}`);
      for (const e of session.onCandle(c)) console.log(formatCandleEvent(e));
    }
  }

  if (session.status !== "STOPPED") for (const e of session.stop(Date.now())) console.log(formatCandleEvent(e));
  console.log(formatCandleSummary(session.summary()));
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
