// Juntar várias páginas de histórico (cada pedido à Deriv devolve até ~1000 ticks).

export interface HistoryPage {
  prices: number[];
  times: number[];
}

function assertPage(p: HistoryPage): void {
  if (p.prices.length !== p.times.length) throw new RangeError("Página com prices e times de tamanhos diferentes");
  for (const t of p.times) if (!Number.isFinite(t)) throw new RangeError("Tempo inválido na página");
  for (const x of p.prices) if (!Number.isFinite(x)) throw new RangeError("Preço inválido na página");
}

/** Junta páginas (em qualquer ordem), ordena do mais antigo para o mais recente e remove repetidos. */
export function mergeHistoryPages(pages: readonly HistoryPage[]): HistoryPage {
  const seen = new Set<number>();
  const rows: { t: number; p: number }[] = [];
  for (const page of pages) {
    assertPage(page);
    page.times.forEach((t, i) => {
      if (seen.has(t)) return;
      seen.add(t);
      rows.push({ t, p: page.prices[i]! });
    });
  }
  rows.sort((a, b) => a.t - b.t);
  return { prices: rows.map((r) => r.p), times: rows.map((r) => r.t) };
}

/** Fim do próximo pedido (mais antigo): um segundo antes do tick mais antigo já recebido. */
export function nextPageEnd(times: readonly number[]): number | null {
  if (times.length === 0) return null;
  let oldest = times[0]!;
  for (const t of times) if (t < oldest) oldest = t;
  return oldest - 1;
                                  }
