# UI: Operar / Livros / Perfas (2026-09-26)

## Antes
Uma página longa: conta + sessão + porta + mercados (Dígitos/Forex/Cripto) + MT5 + histórico misturados.

## Depois
Abas de topo:
- **Operar** — conta, PLAY/PAUSE/STOP, porta, mercados (Dígitos/Forex/Cripto + PAPER/REAL), MT5
- **Livros** — diário de operações (aberturas/fechos PAPER|REAL, stake, resultado) + log de eventos da sessão
- **Perfas** — wins/perdas/taxa/PnL da sessão actual + agregado do diário (localStorage `nl_trade_journal`)

## Não tocado
OAuth (`index.html`, `callback.html`, `api/token.js`), Bybit signing/order gates, evidence gate, martingale ban, 3h stop.
