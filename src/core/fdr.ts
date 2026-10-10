// NEVER LOSS - Benjamini-Hochberg (controlo da taxa de falsas descobertas, FDR) para muitos testes em simultâneo.
// Com ~40 símbolos x 3 presets a olhar para os mesmos dados, alguns p < 0,05 aparecem só por acaso; o BH corrige isso.
// Critério MAIS ESTRITO e apenas informativo (modo sombra): não abre nem fecha nenhuma porta por si.

export interface BhResult {
  /** p-values ajustados (q-values), na ordem de entrada; null onde a entrada era null. */
  adjP: (number | null)[];
  /** true quando adjP <= q. */
  reject: boolean[];
  /** nº de testes considerados (entradas não nulas). */
  m: number;
}

/** Benjamini-Hochberg. Entradas null/NaN não contam para m. q em (0,1). */
export function benjaminiHochberg(pvalues: readonly (number | null | undefined)[], q: number = 0.1): BhResult {
  if (!(q > 0 && q < 1)) throw new RangeError(`q inválido: ${q}`);
  const idx: number[] = [];
  pvalues.forEach((p, i) => {
    if (p !== null && p !== undefined && Number.isFinite(p)) {
      if (p < 0 || p > 1) throw new RangeError(`p-value fora de [0,1]: ${p}`);
      idx.push(i);
    }
  });
  const m = idx.length;
  const adjP: (number | null)[] = pvalues.map(() => null);
  const reject: boolean[] = pvalues.map(() => false);
  if (m === 0) return { adjP, reject, m };
  // ordem crescente de p; desempate estável pela posição
  idx.sort((a, b) => (pvalues[a] as number) - (pvalues[b] as number) || a - b);
  let running = 1;
  for (let k = m; k >= 1; k--) {
    const i = idx[k - 1]!;
    const v = Math.min(1, ((pvalues[i] as number) * m) / k);
    running = Math.min(running, v);
    adjP[i] = running;
    reject[i] = running <= q;
  }
  return { adjP, reject, m };
}
