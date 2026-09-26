# Binance Spot como fonte de dados — NEVER LOSS (2026-09-26)

## O que ficou

| Canal | Listagem | Velas | Trading | Paper NEVER LOSS |
| --- | --- | --- | --- | --- |
| Deriv Options | active_symbols + feed cry*USD | WS público | Options (paper only aqui) | Integrado |
| **Binance Spot** | exchangeInfo → *USDT TRADING | klines públicos | **Não** (sem chaves / sem ordens) | Integrado (toggle no painel) |
| MT5 / CFD Deriv | Sem API | — | Fora da API | Bloqueado (secção MT5) |

## Detalhes

- API pública: `data-api.binance.vision` (+ fallback `api.binance.com`).
- Proxies Vercel: `/api/binance-symbols`, `/api/binance-klines` (geo-friendly, sem secrets).
- Painel: toggle **Deriv Options** ↔ **Binance Spot**; mesmos presets (Lucro rápido / Loss zero), porta, stake fixa, NO TRADE, máx. 3 h, sem martingale.
- OAuth Deriv intacto (contas/saldo). Sessão sempre **paper / simulado**.
- CLIs: `--source binance` em `research-candles` e `paper-candles`.

## Não feito (de propósito)

- Trading real Binance (API keys, ordens, saldos Binance).


## Update 2026-09-26 (painel Cripto)

- **Cripto = Binance Spot only** — sem toggle Deriv Options no painel Cripto.
- Fonte segue o painel: Cripto → Binance Spot (*USDT); Dígitos/Forex → Deriv Options.
- UI PT: «Cripto = Binance Spot»; botão Deriv oculto em Cripto; Binance oculto em Dígitos/Forex.
- Estratégias, porta de evidência, paper, stake fixa, sem martingale e OAuth Deriv mantidos.


## Superseded 2026-09-26

Cripto moved to **Binance Futures USDT-M** (see `binance-futures-usdtm-2026-09-26.md`). Spot proxies reexport Futures.
