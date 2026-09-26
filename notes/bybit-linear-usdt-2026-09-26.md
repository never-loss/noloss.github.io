# Bybit Linear USDT Perpetual — NEVER LOSS (2026-09-26)

## Canal Cripto (PR1: market + paper)

| Canal | Listagem | Velas | Trading | UI |
| --- | --- | --- | --- | --- |
| **Bybit v5 linear USDT** | `/v5/market/instruments-info?category=linear` → LinearPerpetual *USDT | `/v5/market/kline` | PAPER por omissão; REAL order path = PR2+ | Painel Cripto |
| Deriv Options | active_symbols | WS público | Paper (dígitos/forex) | Dígitos / Forex |
| MT5 / CFD | — | — | Bloqueado | Secção MT5 |

## Proxies (CORS / geo — região `fra1`)

- `/api/bybit-symbols`
- `/api/bybit-klines`
- `/api/bybit-status` (`exchange`, `keysConfigured`, `paperAvailable`, `realAvailable`, `authMode` — sem revelar secrets)
- `/api/bybit-order` — **ainda não** (PR2)

Legado Binance (`/api/binance-futures-*`) permanece no repo, unused no dashboard.

## Modo PAPER vs REAL

- **Omissão = PAPER / SIMULADO** (simulação local + velas reais Bybit; sem ordens).
- **keysConfigured** se `BYBIT_API_KEY` + `BYBIT_API_SECRET` no servidor (presença só).
- **PR1:** `realAvailable: false` mesmo com keys — sem place/cancel assinado.
- Env opcional: `BYBIT_BASE_URL` (default `https://api.bybit.com`). **Não** usar demo.
- Nunca colar secrets no chat.

## Regras intactas

Lucro rápido / Loss zero + evidence gate · NO TRADE · OAuth Deriv intacto · stake fixa · sem martingale · máx 3 h.
