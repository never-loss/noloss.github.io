# UI: Operar / Livros / Perfas (2026-09-26)

## Antes
Uma página longa: conta + sessão + porta + mercados + MT5 + histórico misturados.

## Depois (amigável)
Abas de topo + fluxo claro:
- **Operar** — faixa "Seguinte" (1 Conta · 2 Estratégia · 3 Analisar · 4 PLAY), controlos grandes PLAY/PAUSE/STOP, banner PAPER/REAL impossível de confundir (REAL vermelho + confirm), porta com status simples (detalhes ocultos), opções avançadas e MT5 em `<details>`
- **Livros** — diário de operações escaneável + log da sessão recolhido
- **Perfas** — 4–5 números grandes (Ganhos, Perdas, Taxa, PnL, Estado/Fechos)

## Não tocado
OAuth (`index.html`, `callback.html`, `api/token.js`), Bybit signing/order gates, evidence gate, martingale ban, 3h stop.
