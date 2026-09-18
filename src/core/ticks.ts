export type ParsedMessage =
  | { kind: "tick"; symbol: string; epoch: number; quote: number; pipSize: number | null }
  | { kind: "error"; code: string; message: string }
  | { kind: "invalid"; reason: string }
  | { kind: "other" };

export function parseMessage(raw: string): ParsedMessage {
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
    return {
      kind: "error",
      code: String(e.code ?? "unknown"),
      message: String(e.message ?? ""),
    };
  }

  if (obj.msg_type !== "tick") return { kind: "other" };

  const t = obj.tick;
  if (typeof t !== "object" || t === null) {
    return { kind: "invalid", reason: "Tick sem objeto tick" };
  }
  const tick = t as Record<string, unknown>;
  const quote = typeof tick.quote === "string" ? Number(tick.quote) : tick.quote;

  if (typeof tick.symbol !== "string") return { kind: "invalid", reason: "symbol em falta" };
  if (typeof tick.epoch !== "number") return { kind: "invalid", reason: "epoch em falta" };
  if (typeof quote !== "number" || !Number.isFinite(quote)) {
    return { kind: "invalid", reason: "quote inválida" };
  }

  const pip = tick.pip_size;
  return {
    kind: "tick",
    symbol: tick.symbol,
    epoch: tick.epoch,
    quote,
    pipSize: typeof pip === "number" && Number.isInteger(pip) ? pip : null,
  };
}
