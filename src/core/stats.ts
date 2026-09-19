// NEVER LOSS - estatística (Fase 2). Funções puras, sem rede.
// Um resultado "EVIDENCE" nunca é garantia de lucro futuro.

export const PRELIMINARY_MIN_OBS = 100;
export const EVIDENCE_MIN_OBS = 1000;
export const ALPHA = 0.05;

// ---------- Payout, break-even, valor esperado ----------

function assertReturnRate(r: number): void {
  if (!Number.isFinite(r) || r <= 0) throw new RangeError(`returnRate inválido: ${r}`);
}

function assertProb(p: number): void {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new RangeError(`Probabilidade inválida: ${p}`);
}

/** returnRate = lucro / stake (ex.: 2,46 / 3 = 0,82). */
export function returnRateFrom(stake: number, profit: number): number {
  if (!(stake > 0) || !(profit > 0)) throw new RangeError("stake e lucro têm de ser positivos");
  return profit / stake;
}

/** Taxa de acerto mínima para não perder: 1 / (1 + returnRate). */
export function breakEvenProbability(returnRate: number): number {
  assertReturnRate(returnRate);
  return 1 / (1 + returnRate);
}

/** Valor esperado por 1 unidade de stake. */
export function expectedValue(winProb: number, returnRate: number): number {
  assertProb(winProb);
  assertReturnRate(returnRate);
  return winProb * returnRate - (1 - winProb);
}

/** Perda esperada por unidade de stake se a probabilidade for fairProb. */
export function houseEdge(fairProb: number, returnRate: number): number {
  return -expectedValue(fairProb, returnRate);
}

// ---------- Contratos de dígitos ----------

export type DigitContract =
  | { type: "match"; digit: number }
  | { type: "differs"; digit: number }
  | { type: "over"; barrier: number }
  | { type: "under"; barrier: number }
  | { type: "even" }
  | { type: "odd" };

function assertDigit(d: number): void {
  if (!Number.isInteger(d) || d < 0 || d > 9) throw new RangeError(`Dígito inválido: ${d}`);
}

export function didWin(digit: number, c: DigitContract): boolean {
  assertDigit(digit);
  switch (c.type) {
    case "match":
      assertDigit(c.digit);
      return digit === c.digit;
    case "differs":
      assertDigit(c.digit);
      return digit !== c.digit;
    case "over":
      assertDigit(c.barrier);
      return digit > c.barrier;
    case "under":
      assertDigit(c.barrier);
      return digit < c.barrier;
    case "even":
      return digit % 2 === 0;
    case "odd":
      return digit % 2 === 1;
  }
}

/** Probabilidade de ganhar se os dígitos forem uniformes (10% cada). */
export function uniformWinProbability(c: DigitContract): number {
  let wins = 0;
  for (let d = 0; d <= 9; d++) if (didWin(d, c)) wins++;
  return wins / 10;
}

// ---------- Funções matemáticas ----------

function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  const xm = x - 1;
  let a = c[0]!;
  const t = xm + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

function gammaPSeries(a: number, x: number): number {
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n < 1000; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaQContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Função gama incompleta regularizada superior Q(a, x). */
export function gammaQ(a: number, x: number): number {
  if (!(a > 0) || x < 0 || !Number.isFinite(x)) throw new RangeError("argumentos inválidos");
  if (x === 0) return 1;
  return x < a + 1 ? 1 - gammaPSeries(a, x) : gammaQContinuedFraction(a, x);
}

// ---------- Testes estatísticos ----------

export interface ChiSquareResult {
  statistic: number;
  df: number;
  pValue: number;
}

/** Os 10 dígitos são uniformes? p-value alto = compatível com aleatório. */
export function chiSquareUniformity(counts: readonly number[]): ChiSquareResult {
  if (counts.length !== 10) throw new RangeError("São precisas 10 contagens");
  if (counts.some((c) => !Number.isFinite(c) || c < 0)) throw new RangeError("Contagem inválida");
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) throw new RangeError("Sem observações");
  const expected = total / 10;
  const statistic = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  const df = 9;
  return { statistic, df, pValue: gammaQ(df / 2, statistic / 2) };
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** P(X >= k) para X ~ Binomial(n, p), exato. */
export function binomialUpperTail(n: number, k: number, p: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`n inválido: ${n}`);
  if (!Number.isInteger(k)) throw new RangeError(`k inválido: ${k}`);
  assertProb(p);
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p === 0) return 0;
  if (p === 1) return 1;
  let sum = 0;
  for (let i = k; i <= n; i++) {
    sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, sum);
}

/** Intervalo de confiança de Wilson (95% por defeito). */
export function wilsonInterval(wins: number, n: number, z = 1.96): { low: number; high: number } {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`n inválido: ${n}`);
  if (!Number.isInteger(wins) || wins < 0 || wins > n) throw new RangeError(`wins inválido: ${wins}`);
  const phat = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Correção de Benjamini-Hochberg (FDR). p-values ajustados, na ordem original. */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const m = pValues.length;
  for (const p of pValues) assertProb(p);
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = order[rank - 1]!;
    running = Math.min(running, (p * m) / rank);
    adjusted[i] = running;
  }
  return adjusted;
}

// ---------- Avaliação de um contrato ----------

export interface ContractEvaluation {
  n: number;
  wins: number;
  winRate: number;
  breakEven: number;
  estimatedEv: number;
  ci95: { low: number; high: number };
  /** P(acertar tanto ou mais se a taxa real fosse só o break-even). */
  pValue: number;
}

export function evaluateContract(wins: number, n: number, returnRate: number): ContractEvaluation {
  const breakEven = breakEvenProbability(returnRate);
  const ci95 = wilsonInterval(wins, n);
  const winRate = wins / n;
  return {
    n,
    wins,
    winRate,
    breakEven,
    estimatedEv: expectedValue(winRate, returnRate),
    ci95,
    pValue: binomialUpperTail(n, wins, breakEven),
  };
}

export type EvidenceLabel = "INSUFFICIENT" | "NO_EVIDENCE" | "PRELIMINARY" | "EVIDENCE";

/** Rótulo de pesquisa (não é recomendação de operar). adjustedP vem da correção FDR. */
export function classify(n: number, adjustedP: number): EvidenceLabel {
  if (n < PRELIMINARY_MIN_OBS) return "INSUFFICIENT";
  if (adjustedP >= ALPHA) return "NO_EVIDENCE";
  if (n < EVIDENCE_MIN_OBS) return "PRELIMINARY";
  return "EVIDENCE";
}
