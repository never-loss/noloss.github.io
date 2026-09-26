# Binance Futures USDT-M — NEVER LOSS (2026-09-26)

## Canal Cripto

| Canal | Listagem | Velas | Trading | UI |
| --- | --- | --- | --- | --- |
| **Binance USDⓈ-M Futures** | `/fapi/v1/exchangeInfo` → PERPETUAL *USDT | `/fapi/v1/klines` | PAPER por omissão; REAL via proxy assinado | Painel Cripto |
| Deriv Options | active_symbols | WS público | Paper (dígitos/forex) | Dígitos / Forex |
| MT5 / CFD | — | — | Bloqueado | Secção MT5 |

## Proxies (CORS / geo)

- `/api/binance-futures-symbols`
- `/api/binance-futures-klines`
- `/api/binance-futures-status` (`keysConfigured`, `authMode`, sem revelar secrets)
- `/api/binance-futures-order` (POST place / DELETE cancel — só `mode=REAL`)
- Compat: `/api/binance-symbols` e `/api/binance-klines` reexportam Futures.

## Modo PAPER vs REAL

- **Omissão = PAPER / SIMULADO** (simulação local + velas reais; sem ordens).
- **REAL** se `BINANCE_API_KEY` + (`BINANCE_API_PRIVATE_KEY` Ed25519 PEM **ou** `BINANCE_API_SECRET` HMAC) no servidor.
- Preferido: **Ed25519** (sem restrição de IP fixo no Vercel). HMAC continua como fallback.
- Status: `authMode: "ed25519" | "hmac" | "none"`.
- Env opcional: `BINANCE_FUTURES_BASE_URL` (default `https://fapi.binance.com`).
- Nunca colar secrets no chat — configurar no Vercel / host.
- REAL: porta de evidência obrigatória, stake fixa, sem martingale, máx. 3 h + STOP.

## Regras intactas

Lucro rápido / Loss zero + evidence gate · NO TRADE · OAuth Deriv intacto · Dígitos/Forex = Deriv.
