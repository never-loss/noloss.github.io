# Porta em cache (PR4) — histórico profundo + livro-razão no Redis

**Estado:** PAPER por defeito. Só Bybit Linear USDT, velas de 5 min. Nada aqui garante lucro: é o veredicto estatístico
fora da amostra (walk-forward, custos incluídos). Etiquetas honestas: `INSUFFICIENT`, `NO_EVIDENCE`, `AGILE`,
`PRELIMINARY`, `EVIDENCE`.

## Peças
- `lib/history.js` — descarga paralela por janelas alinhadas (PR2).
- `src/core/gate-ledger.ts` — blocos de 500 velas alinhados à época; incremental == completo (PR3).
- `src/core/gate-service.ts` → `lib/nl-gate.mjs` (`npm run build:gate`) — presets + veredicto + streak.
- `lib/gate-store.js` — Redis (Upstash REST `/pipeline`) com memória como recurso quando não há Redis.
- `lib/gate-cache.js` — actualização preguiçosa, bloqueio, orçamento, backfill com cursor.
- `api/bybit-klines.js` — `?mode=gate`, `?mode=gate-backfill` (o proxy clássico não mudou).

## Chaves Redis (`v1`)
| chave | tipo | conteúdo |
|---|---|---|
| `nl:gate:v1:{SYM}:{gran}` | HASH | `meta`, `ledgers` (3 presets), `tail` (2700 velas fechadas) — TTL 14 d |
| `nl:gate:v1:sum:{gran}` | HASH | `SYM` → resumo (≈ 3 KB: veredictos por preset) — o radar lê tudo com 1 `HGETALL` |
| `nl:gate:v1:lock:{SYM}:{gran}` | STRING | `SET NX EX 90` — um só actualizador por símbolo |
| `nl:gate:v1:budget:{cold\|warm}:{hora}` | INT | limites globais: 40 arranques a frio/h, 400 a quente/h |
| `nl:gate:v1:neg:{SYM}` | STRING | símbolo inválido (10 min) |
| `nl:gate:v1:cursor`, `nl:gate:v1:top` | STRING | cursor do backfill; top 40 por turnover (24 h) |

Cauda = aquecimento 600 + treino 1000 + 2 blocos de 500 = **2600** velas mínimas (guardamos 2700).
Se o buraco desde a última vela guardada for > 480 velas (≈ 40 h), refaz-se o arranque a frio (90 dias) em vez de colar.

## Endpoint
- `GET /api/bybit-klines?mode=gate&symbol=BTCUSDT&interval=5` — resumo + actualização preguiçosa se em falta/velho (> 15 min).
  `&refresh=0` nunca toca na Bybit. Por preset: `allowed, open, nOOS, meanR, p, folds, foldsPositive, asOf, depthDays, streak, label, reason, strategy`.
  Campos do topo: `updatedAt, ageMs, stale, historyDays, cfg` (mult. 100, custo 0,001, treino 1000).
- `GET ...?mode=gate&symbols=all` (ou lista) — leitura em massa para o radar; 0 pedidos à Bybit, 1 comando Redis.
- `GET ...?mode=gate-backfill` — cron diário `30 3 * * *` UTC (Hobby: 1×/dia, precisão ±59 min; limite 100 crons/projecto).
  Com `CRON_SECRET` definido exige `Authorization: Bearer`. Processa até 40 s e guarda o cursor.
- Redis configurado mas em baixo → `503 gate_store_unavailable` (a UI usa o cálculo local). Sem Redis → memória (por instância).

## Streak / histerese
`streak` = validações positivas seguidas separadas por ≥ 12 velas; fecha a 0 de imediato. `open = allowed && streak ≥ 2`
(mesma regra do `CandleGateController`). Num símbolo novo o 1.º veredicto positivo começa em 1.

## Plataforma (verificado na documentação da Vercel)
Hobby: funções até 300 s (fluid compute); definimos `maxDuration: 60` só em `api/bybit-klines.js` (válido com e sem fluid).
Crons Hobby: 1×/dia por expressão. Upstash grátis: 500 k comandos/mês — leitura de 1 símbolo = 1 comando, radar = 1,
actualização ≈ 8 comandos, backfill de 40 símbolos ≈ 320/dia.
