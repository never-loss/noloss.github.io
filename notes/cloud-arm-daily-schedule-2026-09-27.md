# Cloud arm — agenda diária 08–20 Africa/Luanda (2026-09-27)

## O que mudou

- Sessão máxima **12 h** (`MAX_SESSION_MS` / UI ≤720 min).
- **PLAY (Armar na nuvem)** activa agenda diária Redis: todos os dias **08:00–20:00 Africa/Luanda** até **STOP**.
- **STOP** desactiva a agenda + cancela o job activo (permite mudar stake/estratégia).
- PAPER/REAL e estratégia = payload do PLAY (não força REAL).
- Futures Linear USDT only. Deriv OAuth intacto.

## Cron (Hobby)

Hobby = no máximo 1×/dia por expressão. Dois crons diários:

| UTC | ≈ Luanda | Função |
| --- | --- | --- |
| `0 7 * * *` | 08:00 | Tick → arranca sessão do dia se agenda activa |
| `0 19 * * *` | 20:00 | Tick → para sessão fora da janela |

Lazy GET (`?clientId=`) também reconcilia a agenda quando a página volta.

## Store

- Jobs: `nl:arm:{id}` (como antes)
- Agenda: `nl:arm:sched:{clientId}` + índice `nl:arm:sched:index`

## Env

Igual: Upstash Redis, `BYBIT_API_KEY/SECRET` para REAL, `CRON_SECRET` opcional.
