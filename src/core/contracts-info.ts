// Contratos disponíveis por símbolo (contracts_for, sem login): quais multiplicadores existem.
// Leitura tolerante: se a Deriv mudar o formato, devolve o que reconhece e diz o que não reconhece.

export interface ContractTypeCount {
  type: string;
  count: number;
}

export type ContractsMessage =
  | {
      kind: "contracts";
      types: ContractTypeCount[];
      /** Multiplicadores permitidos em MULTUP/MULTDOWN (união, por ordem crescente). */
      multipliers: number[];
      /** Opções de cancelamento do negócio (ex.: 5m, 10m), se existirem. */
      cancellation: string[];
      /** Chaves do objeto recebido, para diagnóstico. */
      keys: string[];
    }
  | { kind: "error"; code: string; message: string }
  | { kind: "invalid"; reason: string }
  | { kind: "other" };

export function parseContractsFor(raw: string): ContractsMessage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "invalid", reason: "JSON inválido" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { kind: "invalid", reason: "Mensagem não é um objeto" };
  }
  const obj = data as Record<string, unknown>;
  if (obj.error && typeof obj.error === "object") {
    const e = obj.error as Record<string, unknown>;
    return { kind: "error", code: String(e.code ?? "unknown"), message: String(e.message ?? "") };
  }
  if (obj.msg_type !== "contracts_for") return { kind: "other" };

  const inner = obj.contracts_for;
  const holder = typeof inner === "object" && inner !== null && !Array.isArray(inner) ? (inner as Record<string, unknown>) : obj;
  const available = holder.available;
  if (!Array.isArray(available)) {
    return { kind: "invalid", reason: `lista "available" em falta (chaves: ${Object.keys(holder).join(",")})` };
  }

  const counts = new Map<string, number>();
  const mult = new Set<number>();
  const cancel = new Set<string>();
  for (const entry of available) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e.contract_type === "string" ? e.contract_type : "?";
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (type === "MULTUP" || type === "MULTDOWN") {
      if (Array.isArray(e.multiplier_range)) {
        for (const m of e.multiplier_range) {
          const n = typeof m === "string" ? Number(m) : m;
          if (typeof n === "number" && Number.isFinite(n)) mult.add(n);
        }
      }
      if (Array.isArray(e.cancellation_range)) {
        for (const c of e.cancellation_range) if (typeof c === "string") cancel.add(c);
      }
    }
  }
  return {
    kind: "contracts",
    types: [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => a.type.localeCompare(b.type)),
    multipliers: [...mult].sort((a, b) => a - b),
    cancellation: [...cancel].sort(),
    keys: Object.keys(holder),
  };
}

/** Maior multiplicador permitido que NÃO seja mais apertado do que o stop planeado (1 / stopFraction). */
export function pickMultiplier(allowed: readonly number[], stopFraction: number): number | null {
  if (!(stopFraction > 0) || !Number.isFinite(stopFraction)) throw new RangeError(`stopFraction inválido: ${stopFraction}`);
  const limit = 1 / stopFraction;
  let best: number | null = null;
  for (const m of allowed) {
    if (!Number.isFinite(m) || m <= 0) continue;
    if (m <= limit && (best === null || m > best)) best = m;
  }
  return best;
}

/** Texto curto de uma resposta bruta, para o log. */
export function shorten(raw: string, max = 700): string {
  return raw.length <= max ? raw : `${raw.slice(0, max)}… (+${raw.length - max} caracteres)`;
            }
