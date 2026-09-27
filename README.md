# noloss.github.io

Never Loss — Deriv + Bybit Linear USDT co-pilot.

## Cloud arm (Bybit) ops

- **PAPER** (default) or **REAL** via the on-page toggle → **Armar na nuvem**.
- Durable jobs: set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` on Vercel.
- REAL orders: set `BYBIT_API_KEY` + `BYBIT_API_SECRET` (already used by browser REAL).
- Cron: `vercel.json` hits `/api/bybit-arm?tick=1` daily (`0 0 * * *`, Hobby-safe). Browser 60s poll + lazy GET are the main backup. Optional `CRON_SECRET`. Pro can use `*/5 * * * *`.
- Do not commit secrets.
