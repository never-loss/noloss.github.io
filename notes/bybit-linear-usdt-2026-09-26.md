# Bybit Linear USDT Perpetual — NEVER LOSS (2026-09-26)

## Canal Cripto (PR2: market + paper + REAL order route)

| Canal | Listagem | Velas | Trading | UI |
| --- | --- | --- | --- | --- |
| **Bybit v5 linear USDT** | `/v5/market/instruments-info?category=linear` → LinearPerpetual *USDT | `/v5/market/kline` | PAPER por omissão; REAL via `/api/bybit-order` (HMAC) | Painel Cripto |
| Deriv Options | active_symbols | WS público | Paper (dígitos/forex) | Dígitos / Forex |
| MT5 / CFD | — | — | Bloqueado | Secção MT5 |

## Proxies (CORS / geo — região `fra1`)

- `/api/bybit-symbols`
- `/api/bybit-klines`
- `/api/bybit-status` (`exchange`, `keysConfigured`, `paperAvailable`, `realAvailable`, `authMode` — sem revelar secrets)
- `/api/bybit-order` — POST place Market / DELETE cancel (gates: REAL, evidence, sessão &lt; 3 h, anti-martingale, stake mín.)

Legado Binance (`/api/binance-futures-*`) permanece no repo, unused no dashboard.

## Modo PAPER vs REAL

- **Omissão = PAPER / SIMULADO** (simulação local + velas reais Bybit; sem ordens assinadas).
- **keysConfigured** / **realAvailable** se `BYBIT_API_KEY` + `BYBIT_API_SECRET` no servidor (presença só; `authMode: hmac`).
- Env opcional: `BYBIT_BASE_URL` (default `https://api.bybit.com`). **Não** usar demo.
- PAPER **nunca** chama `/api/bybit-order`. `placeBybitOrder` só corre com `isRealTradingMode()` (toggle REAL + keys).
- Em **REAL** + keys: `onCandle` espelha `trade_opened`/`trade_closed` → MARKET via `/api/bybit-order` (opens com evidence gate; closes `reduceOnly`). PAPER continua só simulação local.
- Nunca colar secrets no chat.

## Regras intactas

Lucro rápido / Loss zero + evidence gate · NO TRADE · OAuth Deriv intacto · stake fixa · sem martingale · máx 3 h.
