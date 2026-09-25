// Estado honesto da integração MT5/CFD cripto com NEVER LOSS.
// Deriv documenta MT5 API só para gestão de conta; trading MT5 não é via API.
// O JWT/OAuth Options não dá listagem nem preços CFD/MT5.

export type Mt5IntegrationStatus = "blocked_no_public_api";

export interface Mt5StatusInfo {
  status: Mt5IntegrationStatus;
  /** Título curto (PT) para o painel. */
  title: string;
  /** Explicação para o utilizador (PT). */
  summary: string;
  /** O que seria necessário para desbloquear. */
  needed: readonly string[];
  /** O que NEVER LOSS faz entretanto (Options). */
  optionsPath: string;
  /** Exemplos de códigos CFD/MT5 no site Deriv (marketing) — NÃO são símbolos Options. */
  exampleMt5Codes: readonly string[];
  docsUrl: string;
}

/** Informação estática — sem inventar preços nem fingir ligação MT5. */
export const MT5_CRYPTO_STATUS: Mt5StatusInfo = {
  status: "blocked_no_public_api",
  title: "MT5 / CFD cripto — sem API pública de mercado",
  summary:
    "A Deriv expõe APIs MT5 só para gestão de conta (lista, passwords, depósito/levantamento). " +
    "Trading e símbolos CFD/MT5 não estão disponíveis via API — só na app Deriv MT5. " +
    "O login OAuth Options (JWT) não cobre listagem nem ticks/velas dos pares CFD (ex.: BTCUSD, AAVUSD). " +
    "No WS Options esses códigos devolvem InvalidSymbol.",
  needed: [
    "API oficial Deriv de market data CFD/MT5 (lista de símbolos + ticks/candles), ou",
    "Credenciais/terminal MetaTrader 5 com feed exportável (fora do âmbito desta app), ou",
    "Produto Deriv documentado que exponha CFD no mesmo WS Options (hoje não existe).",
  ],
  optionsPath:
    "Paper/pesquisa cripto usa o feed Options cry*USD (active_symbols + catálogo de velas público). " +
    "Mesmas estratégias e CandleGate. Sem saldos inventados e sem trades sem evidência.",
  exampleMt5Codes: [
    "AAVUSD",
    "ADAUSD",
    "BNBUSD",
    "BTCUSD",
    "ETHUSD",
    "BTCETH",
  ],
  docsUrl: "https://developers.deriv.com/docs/mt5",
};

export function formatMt5StatusBlock(info: Mt5StatusInfo = MT5_CRYPTO_STATUS): string {
  const need = info.needed.map((n, i) => `${i + 1}. ${n}`).join("\n");
  return [
    info.title,
    "",
    info.summary,
    "",
    "Para integrar MT5/CFD de verdade seria preciso:",
    need,
    "",
    "Entretanto: " + info.optionsPath,
    "",
    "Exemplos de códigos CFD/MT5 (site Deriv, não negociáveis aqui): " +
      info.exampleMt5Codes.join(", "),
    "Docs: " + info.docsUrl,
  ].join("\n");
}
