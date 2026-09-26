# Cloud timed PAPER arm — NEVER LOSS (2026-09-27)

## What

User picks Bybit linear USDT perpetual + strategy + **duration (≤3h)** → **Armar na nuvem (PAPER)** → can leave the page. On return, status shows whether the co-pilot operated (gate + signal → paper trades).

**Not** 24/7 infinite. Timer they set. Browser **ARMAR neste ecrã** unchanged.

## Architecture

| Piece | Role |
| --- | --- |
| `src/core/cloud-arm.ts` | Validate, create, **deterministic advance** (replay closed klines through `CandleGateController` + `CandlePaperSession`), cancel |
| `lib/nl-cloud.mjs` | esbuild bundle of core for Vercel (`npm run build:api`) |
| `lib/arm-store.js` | **Upstash Redis REST** if `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`; else **memory** (ephemeral) |
| `lib/arm-klines.js` | Server fetch Bybit v5 linear klines |
| `api/bybit-arm-jobs.js` | `POST` create · `GET` list/status (lazy advance) · `DELETE` cancel |
| `api/bybit-arm-tick.js` | Advance all RUNNING (cron / external scheduler) |
| `/api/bybit-arm-tick` | optional external cron; lazy GET advance is primary |

**Lazy advance:** GET status / list replays real closed candles since `startedAt`. Same outcome as frequent ticks for PAPER (deterministic). User return = truth.

## PAPER-only (v1)

- API forces `mode: "PAPER"`. No calls to `/api/bybit-order`. No unsolicited REAL.
- Fixed stake · evidence gate · no martingale · max 180 min.

## Limits (honest)

1. **Durable store:** without Upstash env, jobs live only in the warm serverless instance — configure free Upstash for multi-instance durability.
2. **No vercel.json cron** (Hobby deploy + interval limits). For background ticks use external cron → `GET /api/bybit-arm-tick` (optional `CRON_SECRET`). Lazy advance on page open covers “come back later”.
3. Open paper position past `endsAt` may remain until next closed candle resolves (same as local session).

## How Hudson arms and leaves

1. `/bybit` → pick perpetual, strategy, stake, **Duração (min)**.
2. **Armar na nuvem (PAPER)** (not “neste ecrã”).
3. Leave. Optional: external cron ticks.
4. Return → cloud box shows RUNNING/STOPPED, ops, PnL, gate. **STOP nuvem** cancels.

## Chart (only)

- Display history **96** bars (was 200).
- Clear series `setData([])` on symbol switch (no stale BTC).
- WS: proximity every 8th tick or on candle close — no heavy work every tick.
- Poll: `updateLastBar` when same epoch.

## Untouched

Deriv OAuth (`index.html`, `callback.html`, `api/token.js`) · no dashboard rewrite · no MT5 · no Binance UI.
