// Descobre que multiplicadores a Deriv oferece por símbolo e tenta pedir um preço de teste.
// Sem login, sem compras: só leitura.
// Uso: node src/cli/discover-contracts.ts --symbols cryBTCUSD,cryETHUSD,frxEURUSD
import { parseContractsFor, shorten } from "../core/contracts-info.ts";

const URL = "wss://api.derivws.com/trading/v1/options/ws/public";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const symbols = arg("symbols", "cryBTCUSD,cryETHUSD,frxEURUSD,frxGBPUSD,frxUSDJPY,frxXAUUSD")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

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

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Erro de ligação ao WebSocket"));
  });
  console.log("Ligado.\n");

  let sampleSymbol: string | null = null;
  let sampleMultiplier: number | null = null;

  for (const sym of symbols) {
    try {
      const raw = await requestRaw({ contracts_for: sym });
      const m = parseContractsFor(raw);
      if (m.kind === "contracts") {
        console.log(`${sym}: ${m.types.map((t) => `${t.type}(${t.count})`).join(" ") || "sem contratos"}`);
        console.log(`  multiplicadores: ${m.multipliers.length > 0 ? m.multipliers.join(", ") : "nenhum reconhecido"}`);
        if (m.cancellation.length > 0) console.log(`  cancelamento do negócio: ${m.cancellation.join(", ")}`);
        if (m.multipliers.length === 0) console.log(`  chaves recebidas: ${m.keys.join(",")}\n  amostra: ${shorten(raw, 500)}`);
        if (sampleSymbol === null && m.multipliers.length > 0) {
          sampleSymbol = sym;
          sampleMultiplier = m.multipliers[Math.min(1, m.multipliers.length - 1)]!;
        }
      } else if (m.kind === "error") {
        console.log(`${sym}: ERRO ${m.code} - ${m.message}`);
      } else {
        console.log(`${sym}: resposta inesperada (${m.kind === "invalid" ? m.reason : m.kind})\n  amostra: ${shorten(raw, 500)}`);
      }
    } catch (e) {
      console.log(`${sym}: falhou (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // Pedido de preço de teste (sem comprar nada): mostra a resposta bruta, seja qual for.
  if (sampleSymbol !== null && sampleMultiplier !== null) {
    console.log(`\nPreço de teste (não compra nada): MULTUP em ${sampleSymbol}, stake 1 USD, multiplicador ${sampleMultiplier}`);
    try {
      const raw = await requestRaw({
        proposal: 1,
        contract_type: "MULTUP",
        symbol: sampleSymbol,
        amount: 1,
        basis: "stake",
        currency: "USD",
        multiplier: sampleMultiplier,
      });
      console.log(shorten(raw, 1500));
    } catch (e) {
      console.log(`falhou (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    console.log("\nNenhum multiplicador reconhecido: sem pedido de preço de teste.");
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
