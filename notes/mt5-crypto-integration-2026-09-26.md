# Cripto MT5/CFD vs Options — NEVER LOSS (2026-09-26)

## Status para o parent

**MT5/CFD: BLOQUEADO** — não há caminho oficial Deriv API para listar símbolos CFD/MT5 nem obter candles/ticks desses pares. Trading MT5 é explicitamente fora da API.

**Options cripto: MELHORADO** — `active_symbols` continua a devolver tipicamente só `cryBTCUSD` + `cryETHUSD`, mas o WS público Options serve velas reais para ~16 `cry*USD`. O painel/CLIs passam a listar **active + feed** (sem inventar preços; feed = `ticks_history` real).

## Conclusão

| Canal | Listagem | Velas / ticks | Trading API | NEVER LOSS |
| --- | --- | --- | --- | --- |
| Options (WS público + OAuth JWT) | active_symbols ≈ 2 cry* | candles em mais cry*USD | Options (paper only aqui) | Integrado (active+feed) |
| MT5 / CFD | Sem endpoint público | BTCUSD/AAVUSD → InvalidSymbol no WS Options | Não suportado (docs Deriv) | UI bloqueador + next steps |

## Evidência

1. Docs Deriv MT5: só gestão de conta (deposit, settings, accounts list, passwords, withdrawal). Aviso: *trading on MT5 is not supported via our APIs*.
2. OAuth Options JWT/scopes (`trade`, `account_manage`) **não** cobrem market data CFD/MT5.
3. Probe `wss://api.derivws.com/trading/v1/options/ws/public` (2026-09-26):
   - active_symbols: 89 total, 2 cryptocurrency.
   - Candles OK: cryBTC, ETH, LTC, XRP, BCH, ADA, SOL, BNB, XLM, TRX, NEO, ZEC, USDC, XMR, IOT, DSH.
   - Candles InvalidSymbol: BTCUSD, ETHUSD, AAVUSD, BNBUSD, …
4. Marketing `/markets/cryptocurrencies` lista CFD (AAVUSD, …) sem API JSON oficial — **não** scrapámos para fingir cotações.

## Implementado neste commit

- `KNOWN_OPTIONS_CRYPTO_FEED` + `mergeCryptoUsdListings` / `listAllCryptoUsd`
- `src/core/mt5-status.ts` + secção dashboard “BLOQUEADO”
- CLI `--all-crypto` usa active+feed
- Sem saldos inventados, OAuth Options intacto, paper + CandleGate

## Próximos passos (desbloquear MT5 “muito bem”)

1. **Pedir à Deriv** endpoint oficial market-data CFD/MT5 (symbols + candles/ticks), **ou**
2. **Bridge MT5 terminal** (login MetaTrader do utilizador / Manager API) — fora do OAuth Options e desta app; requer credenciais separadas e política de segurança, **ou**
3. Se Deriv expandir o mesmo WS Options a símbolos CFD — hoje não existe.

Até lá: paper/pesquisa só em `cry*USD` Options (lista expandida). Strategy picker: outro agente.
