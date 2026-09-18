export const WINDOW_SIZES = [10, 25, 50, 100, 250, 500] as const;
export const MAX_WINDOW = 500;
export const EXPECTED_PCT = 10;

export type DigitColor = "blue" | "red" | "neutral";

function assertDigit(d: number): void {
  if (!Number.isInteger(d) || d < 0 || d > 9) {
    throw new RangeError(`Dígito inválido: ${d}`);
  }
}

// 1234.5 com pipSize 2 é "1234.50", logo o dígito é 0.
export function lastDigit(quote: number | string, pipSize: number): number {
  if (!Number.isInteger(pipSize) || pipSize < 0 || pipSize > 8) {
    throw new RangeError(`pipSize inválido: ${pipSize}`);
  }
  if (typeof quote === "string" && quote.trim() === "") {
    throw new TypeError("Cotação vazia");
  }
  const value = typeof quote === "string" ? Number(quote) : quote;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Cotação inválida: ${String(quote)}`);
  }
  const text = value.toFixed(pipSize);
  return Number(text[text.length - 1]);
}

export function countDigits(digits: readonly number[]): number[] {
  const counts = new Array<number>(10).fill(0);
  for (const d of digits) {
    assertDigit(d);
    counts[d] += 1;
  }
  return counts;
}

export function percentages(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  return counts.map((c) => (c / total) * 100);
}

export function deviationFromExpected(pcts: readonly number[]): number[] {
  return pcts.map((p) => p - EXPECTED_PCT);
}

export function deviationColor(deviation: number): DigitColor {
  if (deviation > 0) return "blue";
  if (deviation < 0) return "red";
  return "neutral";
}

export interface WindowStats {
  window: number;
  total: number;
  ready: boolean;
  counts: number[];
  percentages: number[];
  deviations: number[];
}

export class TickWindow {
  #digits: number[] = [];
  #max: number;

  constructor(max: number = MAX_WINDOW) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`Tamanho máximo inválido: ${max}`);
    }
    this.#max = max;
  }

  get size(): number {
    return this.#digits.length;
  }

  push(digit: number): void {
    assertDigit(digit);
    this.#digits.push(digit);
    if (this.#digits.length > this.#max) this.#digits.shift();
  }

  last(n: number): number[] {
    if (!Number.isInteger(n) || n < 1) {
      throw new RangeError(`n inválido: ${n}`);
    }
    return this.#digits.slice(-n);
  }

  recent(n: number): number[] {
    return this.last(n).reverse();
  }

  stats(window: number): WindowStats {
    const digits = this.last(window);
    const counts = countDigits(digits);
    const pcts = percentages(counts);
    return {
      window,
      total: digits.length,
      ready: digits.length >= window,
      counts,
      percentages: pcts,
      deviations: deviationFromExpected(pcts),
    };
  }
}
