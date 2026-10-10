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

## UI (PR5)
- **Analisar e painel**: ao carregar um símbolo (5m), o gráfico pinta primeiro; depois lê `?mode=gate&symbol=…` (≈0,3 s a quente).
  Se os 3 presets vierem utilizáveis (≤ 6 h), **não** se descarregam as 4 páginas de 1000 velas nem se recalcula no browser.
  Falhou, velho ou fora da cache (Tendência diária/Biblioteca, outro intervalo, outro multiplicador) → cálculo local de sempre.
- **Radar**: 1 pedido `?mode=gate&symbols=all` (renovado a cada 5 min) dá `gateKnown` a todos os símbolos em cache (top 40 + os já pedidos);
  os restantes ficam "sinal · porta pendente". Tooltip de cada linha mostra a proveniência da porta.
- **Etiqueta honesta** sob a porta e nos cartões: `histórico: 90d · OOS 83d (48 blocos) · n OOS 610 · atualizado há 3 min · cache do servidor`
  ou `cálculo local: 3500 velas (≈12d) · n OOS 85 · sem cache`. Porta aberta com 1 só validação aparece como "a confirmar (1/2)".
- **ARMAR (sessão no browser)** passa a cálculo local (o controlador local é quem decide as entradas) — coerente e sem surpresas.
- Backfill: o cursor já não salta o símbolo que ficou sem orçamento; orçamento de arranques a frio subiu para 60/h.

## Arm na nuvem (PR6) — modo "ledger"
- **Modo fixado no 1.º tick de um job NOVO** (`job.gateMode`): `ledger` se o preset é Lucro rápido/Loss zero/Agressivo, vela 5m, Redis durável e
  o contexto da cache está completo; senão `legacy` (comportamento de antes, também para jobs antigos em curso e presets fora da cache).
  Nunca muda a meio: a reconstrução determinística do arm não pode misturar duas lógicas.
- **Fonte da evidência**: blocos do livro-razão (90 d+ de OOS) em vez de walk-forward sobre ~1500 velas. A cauda (≥1600 velas) só escolhe a
  estratégia. Cada tick: 1 leitura Redis + 1 pedido pequeno à Bybit (antes: 2 páginas de 1000 velas).
- **Sem esperar 12 velas**: o streak inicial deriva de validações passadas as-of (agora, −12, −24 velas). Porta já aberta nas 2 últimas
  validações abre logo; fecha de imediato à 1.ª reprovação. (Determinístico: não depende do streak "de agora" guardado no Redis.)
- **As-of**: o veredicto no instante t usa só blocos com fim ≤ t e velas ≤ t → um livro mais novo dá a mesma sequência (testado), logo
  reconstruir a sessão em ticks diferentes não altera o passado. O livro tem de já ter visto a última fronteira de bloco (senão actualiza-se antes).
- **Cache indisponível num job `ledger`** → o tick é saltado (aviso `advance_failed:gate_ledger_unavailable`), nunca dados parciais.
- **Loss zero (1000 OOS)**: deixa de ser impossível por construção (antes: 1500 velas → ~500 OOS). Em dados reais de 90 d continua
  `INSUFFICIENT` (p.ex. BTC 313/1000 operações): precisa de ~260 dias de 5m ou de outra decisão sobre o mínimo — decisão do utilizador.
- **Triggers externos** (Hobby só tem crons diários): o arm avança em cada GET de estado (lazy) e nos crons 07:00/19:00 UTC.
  Para avançar de 5 em 5 min sem a página aberta, usar um agendador externo que chame `GET /api/bybit-arm?tick=1` com
  `Authorization: Bearer $CRON_SECRET` (cron-job.org, GitHub Actions `schedule`, Upstash QStash) ou subir para Vercel Pro (crons por minuto).
