// Paper trading ao vivo: ticks reais da Deriv (sem login), operações SIMULADAS, sem dinheiro.
// Uso: node src/cli/paper.ts --symbol 1HZ100V --rule paridade-inverte-3 --return 0.82 --stake 3 --minutes 10
import { lastDigit } from "../core/digits.ts";
import { parseMessage } from "../core/ticks.ts";
import { PaperSession } from "../core/paper.ts";
import { parseRuleSpec } from "../core/rules.ts";
import { formatEvent, formatSummary } from "../core/report.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbol = arg("symbol", "1HZ100V");
const ruleSpec = arg("rule", "paridade-inverte-3");
const returnRate = Number(arg("return", "0.82"));
const stake = Number(arg("stake", "3"));
const minutes = Number(arg("minutes", "10"));
const maxLoss = Number(arg("max-loss", String(stake * 10)));
const maxTrades = Number(arg("max-trades", "200"));
const maxConsecutiveLosses = Number(arg("max-consecutive-losses", "8"));
const cooldownTicks = Number(arg("cooldown", "0"));
const fallbackPip = Number(arg("pip", "2"));

let session: PaperSession;
try {
  session = new PaperSession({
    rule: parseRuleSpec(ruleSpec, returnRate),
    stake,
    maxLoss,
    maxTrades,
    maxDurationMs: minutes * 60_000,
    maxConsecutiveLosses,
    cooldownTicks,
  });
} catch (e) {
  console.error(`Configuração inválida: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

let finished = false;
function finish(): void {
  if (finished) return;
  finished = true;
  if (session.status !== "STOPPED") for (const ev of session.stop(Date.now())) console.log(formatEvent(ev));
  console.log(formatSummary(session.summary()));
  ws.close();
}

const hardTimer = setTimeout(finish, (minutes + 2) * 60_000);

const ws = new WebSocket(URL);

ws.onopen = () => {
  console.log(`Ligado. Paper trading em ${symbol} | regra ${ruleSpec} | stake ${stake} | retorno ${returnRate} | ${minutes} min`);
  ws.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 1 }));
};

let started = false;

ws.onmessage = (event: MessageEvent) => {
  const msg = parseMessage(String(event.data));
  if (msg.kind === "error") {
    console.error(`Erro da Deriv: ${msg.code} - ${msg.message}`);
    process.exitCode = 1;
    finish();
    return;
  }
  if (msg.kind !== "tick" || finished) return;

  const digit = lastDigit(msg.quote, msg.pipSize ?? fallbackPip);
  const at = msg.epoch * 1000;
  if (!started) {
    started = true;
    for (const ev of session.start(at)) console.log(formatEvent(ev));
  }
  for (const ev of session.onTick(digit, at)) console.log(formatEvent(ev));

  if (session.status === "STOPPED" && !session.hasPending) {
    clearTimeout(hardTimer);
    finish();
  }
};

ws.onerror = () => console.error("Erro de ligação ao WebSocket.");
ws.onclose = () => process.exit(process.exitCode ?? 0);
