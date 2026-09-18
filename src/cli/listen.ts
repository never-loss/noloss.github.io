import { lastDigit, TickWindow } from "../core/digits.ts";
import { parseMessage } from "../core/ticks.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbol = arg("symbol", "1HZ100V");
const fallbackPip = Number(arg("pip", "2"));
const maxTicks = Number(arg("max", "0"));

if (!Number.isInteger(fallbackPip) || fallbackPip < 0 || fallbackPip > 8) {
  console.error("--pip tem de ser um inteiro entre 0 e 8");
  process.exit(1);
}

const window = new TickWindow();
let received = 0;
let invalid = 0;
let warnedPip = false;

const ws = new WebSocket(URL);

ws.onopen = () => {
  console.log(`Ligado. A subscrever ${symbol}...`);
  ws.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 1 }));
};

ws.onmessage = (event: MessageEvent) => {
  const msg = parseMessage(String(event.data));

  if (msg.kind === "error") {
    console.error(`Erro da Deriv: ${msg.code} - ${msg.message}`);
    return;
  }
  if (msg.kind === "invalid") {
    invalid += 1;
    console.warn(`Mensagem inválida ignorada (${invalid}): ${msg.reason}`);
    return;
  }
  if (msg.kind !== "tick") return;

  let pip = msg.pipSize;
  if (pip === null) {
    pip = fallbackPip;
    if (!warnedPip) {
      warnedPip = true;
      console.warn(`Aviso: sem pip_size na resposta; a usar --pip ${fallbackPip}.`);
    }
  }

  const digit = lastDigit(msg.quote, pip);
  window.push(digit);
  received += 1;

  const time = new Date(msg.epoch * 1000).toISOString().slice(11, 19);
  console.log(`${time}  ${msg.symbol}  ${msg.quote.toFixed(pip)}  ->  dígito ${digit}`);

  if (received % 25 === 0) {
    const s = window.stats(100);
    const linhas = s.counts.map((c, d) => `${d}: ${c} (${s.percentages[d]!.toFixed(0)}%)`);
    console.log(`--- Últimos ${s.total} ticks ---`);
    console.log(linhas.join("   "));
  }

  if (maxTicks > 0 && received >= maxTicks) {
    console.log(`Concluído: ${received} ticks recebidos, ${invalid} inválidos.`);
    ws.close();
  }
};

ws.onerror = () => console.error("Erro de ligação ao WebSocket.");
ws.onclose = () => {
  console.log("Ligação fechada.");
  process.exit(0);
};
