// Descobre os símbolos disponíveis (forex, cripto...) e testa se as velas chegam. Sem login, sem operações.
// Uso: node src/cli/discover.ts --symbols frxEURUSD,frxGBPUSD,cryBTCUSD,cryETHUSD --granularity 300 --count 500
import { parseActiveSymbols, parseCandlesMessage, summarizeMarkets } from "../core/market-data.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbols = arg("symbols", "frxEURUSD,frxGBPUSD,frxUSDJPY,frxXAUUSD,cryBTCUSD,cryETHUSD")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
const granularity = Number(arg("granularity", "300"));
const count = Number(arg("count", "500"));

if (!Number.isInteger(granularity) || granularity < 60 || !Number.isInteger(count) || count < 10 || count > 5000) {
  console.error("--granularity (>= 60 s) e --count (10 a 5000) têm de ser inteiros válidos");
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
    // mensagem que não é JSON: ignora
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

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Erro de ligação ao WebSocket"));
  });
  console.log("Ligado.");

  // 1) Símbolos
  const s = parseActiveSymbols(await requestRaw({ active_symbols: "brief" }));
  const known = new Set<string>();
  if (s.kind === "symbols") {
    console.log(`Símbolos recebidos: ${s.items.length} (ignorados: ${s.skipped})`);
    for (const m of summarizeMarkets(s.items)) console.log(`  ${m.market}: ${m.total} no total, ${m.open} abertos agora`);
    for (const it of s.items) known.add(it.symbol);
    for (const market of ["forex", "cryptocurrency", "commodities"]) {
      const open = s.items.filter((i) => i.market === market && i.open && !i.suspended).map((i) => i.symbol);
      console.log(`Abertos em ${market} (${open.length}): ${open.slice(0, 40).join(" ")}`);
    }
  } else if (s.kind === "error") {
    console.warn(`Lista de símbolos: erro ${s.code} - ${s.message}`);
  } else {
    console.warn(`Lista de símbolos: resposta inesperada (${s.kind === "invalid" ? s.reason : s.kind})`);
  }

  // 2) Velas de teste
  console.log(`\nA testar velas de ${granularity}s (${count} pedidas):`);
  for (const sym of symbols) {
    const note = known.size > 0 && !known.has(sym) ? " [não está na lista de símbolos]" : "";
    try {
      const m = parseCandlesMessage(
        await requestRaw({ ticks_history: sym, end: "latest", count, style: "candles", granularity }),
      );
      if (m.kind === "candles" && m.candles.length > 0) {
        const last = m.candles[m.candles.length - 1]!;
        const first = m.candles[0]!;
        const when = new Date(last.epoch * 1000).toISOString().replace("T", " ").slice(0, 19);
        console.log(`  ${sym}: OK ${m.candles.length} velas | ${new Date(first.epoch * 1000).toISOString().slice(0, 10)} a ${when} | último fecho ${last.close} | pip_size ${m.pipSize ?? "?"}${note}`);
      } else if (m.kind === "error") {
        console.log(`  ${sym}: ERRO ${m.code} - ${m.message}${note}`);
      } else {
        console.log(`  ${sym}: resposta inesperada (${m.kind === "invalid" ? m.reason : m.kind})${note}`);
      }
    } catch (e) {
      console.log(`  ${sym}: falhou (${e instanceof Error ? e.message : String(e)})${note}`);
    }
  }
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
