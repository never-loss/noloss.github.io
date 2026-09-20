// Juntar várias páginas de velas (cada pedido à Deriv devolve um número limitado de velas).
import type { Candle } from "./market-data.ts";

/** Junta páginas (em qualquer ordem), ordena da mais antiga para a mais recente e remove repetidas. */
export function mergeCandlePages(pages: readonly (readonly Candle[])[]): Candle[] {
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const page of pages) {
    for (const c of page) {
      if (![c.epoch, c.open, c.high, c.low, c.close].every(Number.isFinite)) {
        throw new RangeError("Vela inválida numa página");
      }
      if (seen.has(c.epoch)) continue;
      seen.add(c.epoch);
      out.push(c);
    }
  }
  return out.sort((a, b) => a.epoch - b.epoch);
}

/** Fim do próximo pedido (mais antigo): um segundo antes da vela mais antiga já recebida. */
export function nextCandleEnd(candles: readonly Candle[]): number | null {
  if (candles.length === 0) return null;
  let oldest = candles[0]!.epoch;
  for (const c of candles) if (c.epoch < oldest) oldest = c.epoch;
  return oldest - 1;
}
