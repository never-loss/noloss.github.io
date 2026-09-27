# Deriv cloud PAPER arm (Demo catch-up) — 2026-09-27

## Scope shipped

| Piece | Status |
| --- | --- |
| Entry readiness (porta+sinal) Digits/Forex | Live % + semaphore on cards + top proximity bar via `combineReadiness` |
| Conta Demo / Real selector | Existing Tipo de Conta; cloud job records `accountKind` + `accountId` |
| Cloud PAPER catch-up | Client `localStorage` job; on return / interval, fetch history and replay `CandleGateController` + `CandlePaperSession` |
| Cloud REAL contracts | **Not** placed. Banner: REAL cloud = página aberta + confirmação |

## Why client catch-up (not server like Bybit)

Bybit klines are REST-friendly on Vercel. Deriv market data is primarily WebSocket; serverless WS advance is fragile. Deterministic PAPER replay on return matches closed candles the user would have seen.

## Safety

- Mode forced **PAPER** (no Deriv proposal/buy in cloud path).
- Evidence gate + fixed stake + max 180 min + no martingale.
- Real account may be *selected* for labeling/balance context; cloud still PAPER only.

## UI

Dashboard → «PLAY na nuvem · Deriv (PAPER)» + entry boxes on Digits/Forex.
