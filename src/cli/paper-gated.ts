// Paper trading com PORTA DE EVIDÊNCIA: ticks reais (sem login), operações SIMULADAS.
// O bot só abre operações se a regra passar num teste fora da amostra. Senão: NO TRADE.
// Uso: node src/cli/paper-gated.ts --symbol 1HZ100V --lane A --stake 3 --minutes 10
import { lastDigit } from "../core/digits.ts";
import { parseMessage } from "../core/ticks.ts";
import { parseHistoryMessage, digitsFromPrices } from "../core/history.ts";
import { PaperSession } from "../core/paper.ts";
import { GateController, formatGate } from "../core/gate.ts";
import { laneARules, laneBRules } from "../core/lanes.ts";
import { formatEvent, formatSummary } from "../core/report.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbol = arg("symbol", "1HZ100V");
const lane = arg("lane", "A").toUpperCase();
const returnRate = Number(arg("return", lane === "B" ? "8" : "0.82"));
const stake = Number(arg("stake", "3"));
const minutes = Number(arg("minutes", "10"));
const maxLoss = Number(arg("max-loss", String(stake * 10)));
const maxTrades = Number(arg("max-trades", "200"));
const maxConsecutiveLosses = Number(arg("max-consecutive-losses", "8"));
const cooldownTicks = Number(arg("cooldown", "0"));
const revalidateEvery = Number(arg("revalidate", "100"));
const minLabel = arg("min-label", "PRELIMINARY").toUpperCase() === "EVIDENCE" ? "EVIDENCE" : "PRELIMINARY";
const fallbackPip = Number(arg("pip", "2"));

if (lane !== "A" && lane !== "B") {
  console.error("--lane tem de ser A ou B");
  process.exit(1);
}
if (!(returnRate > 0)) {
  console.error("--return tem de ser positivo");
  process.exit(1);
}
const candidates = lane === "B" ? laneBRules(returnRate) : laneARules(returnRate);

let controller: GateController | null = null;
let session: PaperSession | null = null;
let phase: "history" | "live" = "history";
let started = false;
let finished = false;
let liveTicks = 0;

function finish(): void {
  if (finished) return;
  finished = true;
  if (session !== null) {
    if (session.status !== "STOPPED") for (const ev of session.stop(Date.now())) console.log(formatEvent(ev));
    console.log(formatSummary(session.summary()));
  }
  ws.close();
}

const hardTimer = setTimeout(finish, (minutes + 3) * 60_000);
const ws = new WebSocket(URL);

ws.onopen = () => {
  console.log(`Ligado. Faixa ${lane} | ${symbol} | stake ${stake} | retorno ${returnRate} | ${minutes} min | porta: ${minLabel}`);
  ws.send(JSON.stringify({ ticks_history: symbol, end: "latest", count: 1000, style: "ticks", req_id: 1 }));
};

ws.onmessage = (event: MessageEvent) => {
  const raw = String(event.data);
  const tick = parseMessage(raw);

  if (tick.kind === "error") {
    console.error(`Erro da Deriv: ${tick.code} - ${tick.message}`);
    process.exitCode = 1;
    finish();
    return;
  }

  if (phase === "history") {
    const h = parseHistoryMessage(raw);
    if (h.kind === "other" || h.kind === "error") return;
    if (h.kind === "invalid") {
      console.error(`Resposta inválida: ${h.reason}`);
      process.exitCode = 1;
      finish();
      return;
    }
    const digits = digitsFromPrices(h.prices, h.pipSize ?? fallbackPip);
    console.log(`Histórico recebido: ${digits.length} ticks.`);
    controller = new GateController({
      candidates,
      revalidateEvery,
      initial: digits,
      maxBuffer: 1500,
      gate: { minLabel },
    });
    console.log(`[início] ${formatGate(controller.result)}`);
    session = new PaperSession({
      rule: controller.asRule(),
      stake,
      maxLoss,
      maxTrades,
      maxDurationMs: minutes * 60_000,
      maxConsecutiveLosses,
      cooldownTicks,
    });
    phase = "live";
    ws.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 2 }));
    return;
  }

  if (tick.kind !== "tick" || finished || controller === null || session === null) return;
  const digit = lastDigit(tick.quote, tick.pipSize ?? fallbackPip);
  const at = tick.epoch * 1000;
  if (!started) {
    started = true;
    for (const ev of session.start(at)) console.log(formatEvent(ev));
  }

  const changed = controller.push(digit);
  liveTicks += 1;
  if (changed || liveTicks % revalidateEvery === 0) {
    console.log(`[tick ${liveTicks}] ${formatGate(controller.result)}`);
  }
  for (const ev of session.onTick(digit, at)) console.log(formatEvent(ev));

  if (session.status === "STOPPED" && !session.hasPending) {
    clearTimeout(hardTimer);
    finish();
  }
};

ws.onerror = () => console.error("Erro de ligação ao WebSocket.");
ws.onclose = () => process.exit(process.exitCode ?? 0);
