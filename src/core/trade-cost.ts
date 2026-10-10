// NEVER LOSS - custo por operação: MODELADO (PAPER) e REAL (execuções da Bybit), para comparar com o custo ASSUMIDO (0,1 %).
// Só medição e rótulos: nunca altera entradas, saídas, R, porta nem o custo por omissão.
//
// Taxas oficiais Bybit, USDT perpétuos, não-VIP (VIP 0): taker 0,055 % e maker 0,02 % do valor nocional
// (Help Center "Trading Fee Structure" / "Futures Contracts: Fees Explained"). São constantes configuráveis, não promessas:
// a conta real pode ter outro escalão.
//
// A derrapagem modelada é uma SUPOSIÇÃO (não foi medida): 0,01 % por lado em ordens a mercado/stop. É rotulada como tal na UI.

export const BYBIT_TAKER_FEE = 0.00055;
export const BYBIT_MAKER_FEE = 0.0002;
/** SUPOSIÇÃO (não medida): derrapagem por lado em ordens a mercado e stops. */
export const ASSUMED_SLIPPAGE_PER_SIDE = 0.0001;
/** Rótulo honesto que a UI mostra junto do custo modelado. */
export const MODELED_COST_LABEL = "modelado (taxas oficiais + derrapagem SUPOSTA, não medida)";

export interface FillModelConfig {
  takerFee: number;
  makerFee: number;
  /** Derrapagem por lado (fração do preço) em saídas/entradas a mercado. SUPOSIÇÃO. */
  slippagePerSide: number;
  /** Saída no alvo por ordem limite (maker, sem derrapagem)? Suposição: sim. */
  takeProfitIsMaker: boolean;
}

export const DEFAULT_FILL_MODEL: Readonly<FillModelConfig> = Object.freeze({
  takerFee: BYBIT_TAKER_FEE,
  makerFee: BYBIT_MAKER_FEE,
  slippagePerSide: ASSUMED_SLIPPAGE_PER_SIDE,
  takeProfitIsMaker: true,
});

export type ModeledExitKind = "taker" | "maker";

/** Preenchimento simulado de uma operação PAPER (informativo; r e pnl NÃO mudam). */
export interface ModeledFill {
  /** Preço de entrada da simulação (abertura da vela seguinte) e o que teria sido pago com a derrapagem suposta. */
  entry: number;
  entryFill: number;
  /** Preço de saída da simulação e o que teria sido recebido com a derrapagem suposta. */
  exit: number;
  exitFill: number;
  stopPrice: number;
  /** Fecho da vela de saída. */
  exitCandleClose: number;
  /** (stop − saída) × direcção / entrada: > 0 = a simulação saiu pior que o stop (salto/gap). */
  gapVsStopFrac: number;
  exitKind: ModeledExitKind;
  /** Taxas (entrada taker + saída taker|maker), fração do nocional. */
  feeFrac: number;
  /** Derrapagem SUPOSTA (entrada + saída se for a mercado), fração do preço. */
  slipFrac: number;
  modeledCostFrac: number;
  /** Custo modelado em unidades de R (custo × entrada / distância do stop). */
  modeledCostR: number;
  /** Custo ASSUMIDO pela simulação (costFraction) e em R. */
  assumedCostFrac: number;
  assumedCostR: number;
}

export interface ModelFillInput {
  direction: 1 | -1;
  entry: number;
  exit: number;
  stopPrice: number;
  exitCandleClose: number;
  /** Distância do stop em preço (slAtr × ATR). */
  dist: number;
  reason: "sl" | "tp" | "time";
  /** Custo assumido (fração) usado no cálculo do R da simulação. */
  assumedCostFrac: number;
}

export function resolveFillModel(over: Partial<FillModelConfig> | undefined): FillModelConfig {
  const m = { ...DEFAULT_FILL_MODEL, ...(over ?? {}) };
  for (const k of ["takerFee", "makerFee", "slippagePerSide"] as const) {
    if (!Number.isFinite(m[k]) || m[k] < 0 || m[k] > 0.05) throw new RangeError(`fillModel.${k} inválido: ${m[k]}`);
  }
  return m;
}

export function modelTradeFill(i: ModelFillInput, model: FillModelConfig = DEFAULT_FILL_MODEL): ModeledFill {
  const tpMaker = i.reason === "tp" && model.takeProfitIsMaker;
  const exitKind: ModeledExitKind = tpMaker ? "maker" : "taker";
  const feeFrac = model.takerFee + (tpMaker ? model.makerFee : model.takerFee);
  const slipFrac = model.slippagePerSide * (tpMaker ? 1 : 2);
  const entryFill = i.entry * (1 + i.direction * model.slippagePerSide);
  const exitFill = tpMaker ? i.exit : i.exit * (1 - i.direction * model.slippagePerSide);
  const modeledCostFrac = feeFrac + slipFrac;
  return {
    entry: i.entry,
    entryFill,
    exit: i.exit,
    exitFill,
    stopPrice: i.stopPrice,
    exitCandleClose: i.exitCandleClose,
    gapVsStopFrac: (i.direction * (i.stopPrice - i.exit)) / i.entry,
    exitKind,
    feeFrac,
    slipFrac,
    modeledCostFrac,
    modeledCostR: (modeledCostFrac * i.entry) / i.dist,
    assumedCostFrac: i.assumedCostFrac,
    assumedCostR: (i.assumedCostFrac * i.entry) / i.dist,
  };
}

// ---------- Resumos ----------

export interface ModeledCostSummary {
  n: number;
  /** Média do custo modelado por operação (ida e volta), fração do preço. */
  meanModeledFrac: number;
  meanFeeFrac: number;
  meanSlipFrac: number;
  /** Média do custo assumido pela simulação. */
  meanAssumedFrac: number;
  meanModeledR: number;
  meanAssumedR: number;
}

const mean = (a: readonly number[]): number => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length);

/** Só dados que existem: sem operações → null (a UI não mostra nada). */
export function summarizeModeledFills(fills: readonly Pick<ModeledFill, "feeFrac" | "slipFrac" | "modeledCostFrac" | "modeledCostR" | "assumedCostFrac" | "assumedCostR">[]): ModeledCostSummary | null {
  const f = fills.filter((x) => x && Number.isFinite(x.modeledCostFrac));
  if (f.length === 0) return null;
  return {
    n: f.length,
    meanModeledFrac: mean(f.map((x) => x.modeledCostFrac)),
    meanFeeFrac: mean(f.map((x) => x.feeFrac)),
    meanSlipFrac: mean(f.map((x) => x.slipFrac)),
    meanAssumedFrac: mean(f.map((x) => x.assumedCostFrac)),
    meanModeledR: mean(f.map((x) => x.modeledCostR)),
    meanAssumedR: mean(f.map((x) => x.assumedCostR)),
  };
}

/** Execução REAL de uma ordem (um lado), lida da Bybit. Positivo = pior para nós. */
export interface RealFill {
  key: string;
  action: "open" | "close";
  side: "BUY" | "SELL";
  symbol: string;
  /** Preço do sinal (entrada/saída da simulação). */
  signalPrice: number;
  avgPrice: number;
  qty: number;
  /** Taxa paga em USDT (negativa = rebate). */
  execFee: number;
  feeFrac: number;
  slipFrac: number;
  costFrac: number;
  at: number;
  source?: string;
}

export interface RealCostSummary {
  /** Execuções lidas (lados). */
  fills: number;
  /** Operações completas (abertura + fecho emparelhados por ordem). */
  roundTrips: number;
  /** Média por lado (taxa + derrapagem), fração do preço. */
  meanSideFrac: number;
  meanSideFee: number;
  meanSideSlip: number;
  /** Média por operação completa (ida e volta); null se ainda não há operações completas. */
  meanRoundTripFrac: number | null;
  meanRoundTripFee: number | null;
  meanRoundTripSlip: number | null;
}

/** Resume execuções reais; null se não houver nenhuma válida. Emparelha abertura e fecho pela ordem de `at`. */
export function summarizeRealFills(fills: readonly RealFill[]): RealCostSummary | null {
  const ok = fills.filter((f) => f && Number.isFinite(f.costFrac) && Number.isFinite(f.feeFrac) && Number.isFinite(f.slipFrac));
  if (ok.length === 0) return null;
  const sorted = [...ok].sort((a, b) => a.at - b.at);
  const trips: { fee: number; slip: number }[] = [];
  let open: RealFill | null = null;
  for (const f of sorted) {
    if (f.action === "open") {
      open = f;
    } else if (open !== null && open.symbol === f.symbol) {
      trips.push({ fee: open.feeFrac + f.feeFrac, slip: open.slipFrac + f.slipFrac });
      open = null;
    }
  }
  return {
    fills: ok.length,
    roundTrips: trips.length,
    meanSideFrac: mean(ok.map((f) => f.costFrac)),
    meanSideFee: mean(ok.map((f) => f.feeFrac)),
    meanSideSlip: mean(ok.map((f) => f.slipFrac)),
    meanRoundTripFrac: trips.length ? mean(trips.map((t) => t.fee + t.slip)) : null,
    meanRoundTripFee: trips.length ? mean(trips.map((t) => t.fee)) : null,
    meanRoundTripSlip: trips.length ? mean(trips.map((t) => t.slip)) : null,
  };
}

const pct = (x: number, d = 3): string => `${(x * 100).toFixed(d).replace(".", ",")} %`;

/** Linha honesta do custo REAL (ou null se n = 0). `assumed` = custo assumido por ida e volta (ex.: 0,001). */
export function formatRealCostLine(s: RealCostSummary | null, assumed: number): string | null {
  if (s === null) return null;
  if (s.roundTrips > 0 && s.meanRoundTripFrac !== null) {
    return `Custo real médio: ${pct(s.meanRoundTripFrac)} por operação (taxas ${pct(s.meanRoundTripFee ?? 0)} + derrapagem ${pct(s.meanRoundTripSlip ?? 0)}) · n = ${s.roundTrips} ${s.roundTrips === 1 ? "operação" : "operações"} · assumido ${pct(assumed, 2)}`;
  }
  return `Custo real médio: ${pct(s.meanSideFrac)} por lado (≈ ${pct(s.meanSideFrac * 2)} ida e volta) · n = ${s.fills} ${s.fills === 1 ? "execução" : "execuções"} (sem operação completa ainda) · assumido ${pct(assumed, 2)}`;
}

/** Linha do custo MODELADO em PAPER (ou null). */
export function formatModeledCostLine(s: ModeledCostSummary | null): string | null {
  if (s === null) return null;
  return `Custo ${MODELED_COST_LABEL}: ${pct(s.meanModeledFrac)} por operação · n = ${s.n} · assumido ${pct(s.meanAssumedFrac, 2)}`;
}
