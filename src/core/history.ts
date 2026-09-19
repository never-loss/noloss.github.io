// Histórico de ticks da Deriv (pedido único, sem login) e conversão para dígitos.
import { lastDigit } from "./digits.ts";

export type HistoryMessage =
  | { kind: "history"; prices: number[]; times: number[]; pipSize: number | null }
  | { kind: "error"; code: string; message: string }
  | { kind: "invalid"; reason: string }
  | { kind: "other" };

export function parseHistoryMessage(raw: string): HistoryMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "JSON inválido" };
  }
  if (typeof data !== "object" || data === null) {
    return { kind: "invalid", reason: "Mensagem não é um objeto" };
  }
  const obj = data as Record<string, unknown>;

  if (obj.error && typeof obj.error === "object") {
    const e = obj.error as Record<string, unknown>;
    return { kind: "error", code: String(e.code ?? "unknown"), message: String(e.message ?? "") };
  }

  if (obj.msg_type !== "history") return { kind: "other" };

  const h = obj.history;
  if (typeof h !== "object" || h === null) return { kind: "invalid", reason: "history em falta" };
  const hist = h as Record<string, unknown>;
  if (!Array.isArray(hist.prices) || !Array.isArray(hist.times)) {
    return { kind: "invalid", reason: "prices ou times em falta" };
  }
  if (hist.prices.length !== hist.times.length) {
    return { kind: "invalid", reason: "prices e times com tamanhos diferentes" };
  }

  const prices: number[] = [];
  for (const p of hist.prices) {
    const v = typeof p === "string" ? Number(p) : p;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { kind: "invalid", reason: "preço inválido no histórico" };
    }
    prices.push(v);
  }
  const times: number[] = [];
  for (const t of hist.times) {
    if (typeof t !== "number" || !Number.isFinite(t)) {
      return { kind: "invalid", reason: "tempo inválido no histórico" };
    }
    times.push(t);
  }

  const rawPip = typeof obj.pip_size === "string" ? Number(obj.pip_size) : obj.pip_size;
  const pipSize = typeof rawPip === "number" && Number.isInteger(rawPip) ? rawPip : null;
  return { kind: "history", prices, times, pipSize };
}

/** Converte preços em últimos dígitos, respeitando o pipSize (938.80 -> 0). */
export function digitsFromPrices(prices: readonly number[], pipSize: number): number[] {
  return prices.map((p) => lastDigit(p, pipSize));
}
