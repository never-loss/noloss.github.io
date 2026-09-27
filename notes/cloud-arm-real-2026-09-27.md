# Cloud arm PAPER + REAL — NEVER LOSS (2026-09-27)

## What

Bybit cloud arm follows the existing **PAPER / REAL** toggle:

- **Simulado (PAPER)** — same deterministic kline replay as before.
- **REAL** — same replay for evidence + signals; API layer places at most one Bybit Linear USDT market order per new `trade_opened` / `trade_closed` (de-duped via `realAppliedEventKeys`).

## Env (Vercel)

| Var | Purpose |
| --- | --- |
| `BYBIT_API_KEY` + `BYBIT_API_SECRET` | Required for REAL (browser + cloud) |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Durable jobs across serverless instances |
| `CRON_SECRET` (optional) | Protects `GET/POST /api/bybit-arm?tick=1` when set; Vercel Cron header still allowed |

## Cron

`vercel.json` schedules `0 0 * * *` (daily) → `/api/bybit-arm?tick=1` — Hobby-safe.

- Browser poll every 60s + lazy GET advance remain the primary “page closed then return” path.
- On Pro you may tighten to `*/5 * * * *` for background ticks with the page closed.

## Safety

- PAPER default. REAL create requires `confirmReal: true` + keys on server.
- Fixed stake · no martingale · max 180 min · Linear USDT only.
- Cancel of REAL with open mirrored qty → `needsRealFlatten` → best-effort reduceOnly close.
- Deriv OAuth untouched.

## Untouched

`public/index.html`, `public/callback.html`, `api/token.js`.
