// Pede o histórico de ticks à Deriv (sem login) e corre a pesquisa.
// Uso: node src/cli/research.ts --symbol 1HZ100V --count 5000 --return 0.82 --return-high 8
import { parseHistoryMessage, digitsFromPrices } from "../core/history.ts";
import { runResearch, formatReport } from "../core/research.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbol = arg("symbol", "1HZ100V");
const count = Number(arg("count", "5000"));
const returnA = Number(arg("return", "0.82"));
const returnB = Number(arg("return-high", "8"));
const fallbackPip = Number(arg("pip", "2"));

if (!Number.isInteger(count) || count < 1500) {
  console.error("--count tem de ser um inteiro >= 1500");
  process.exit(1);
}
if (!(returnA > 0) || !(returnB > 0)) {
  console.error("--return e --return-high têm de ser positivos");
  process.exit(1);
}

const timer = setTimeout(() => {
  console.error("Sem resposta da Deriv em 60 segundos.");
  process.exit(1);
}, 60_000);

const ws = new WebSocket(URL);

ws.onopen = () => {
  console.log(`Ligado. A pedir ${count} ticks de ${symbol}...`);
  ws.send(JSON.stringify({ ticks_history: symbol, end: "latest", count, style: "ticks", subscribe: 0, req_id: 1 }));
};

ws.onmessage = (event: MessageEvent) => {
  const msg = parseHistoryMessage(String(event.data));
  if (msg.kind === "other") return;
  clearTimeout(timer);

  if (msg.kind === "error") {
    console.error(`Erro da Deriv: ${msg.code} - ${msg.message}`);
    process.exit(1);
  }
  if (msg.kind === "invalid") {
    console.error(`Resposta inválida: ${msg.reason}`);
    process.exit(1);
  }

  let pip = msg.pipSize;
  if (pip === null) {
    pip = fallbackPip;
    console.warn(`Aviso: sem pip_size na resposta; a usar --pip ${fallbackPip}.`);
  }
  console.log(`Recebidos ${msg.prices.length} ticks (pip_size ${pip}).`);

  try {
    const digits = digitsFromPrices(msg.prices, pip);
    console.log(formatReport(runResearch(digits, { returnA, returnB })));
    ws.close();
  } catch (e) {
    console.error(`Erro na pesquisa: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
};

ws.onerror = () => console.error("Erro de ligação ao WebSocket.");
ws.onclose = () => process.exit(process.exitCode ?? 0);
