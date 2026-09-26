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
