# Giro Diário (2026-10-27)

Novo preset `giro_diario` ("Giro Diário"). **Sem garantia de lucro diário — mais oportunidades testadas, não mais certezas.**
Não muda nenhuma porta, preset existente, custo por omissão (0,1 %) nem o PAPER por omissão. Stake fixa, sem martingale.

## Regras
- Velas: **5 min por omissão**, 1 min opcional (o arm na nuvem rejeita outras para este preset).
- Estratégias: só da biblioteca existente (`strategyLibrary`), sem parâmetros novos (ver selecção abaixo).
- Porta: walk-forward da porta existente (`CandleGateController`/`evaluateCandleGate`, o mesmo caminho de `tendencia_diaria`),
  `minLabel: PRELIMINARY` → **≥ 100 operações fora da amostra e p < 0,01** (`GATE_ALPHA`). Não entra no livro-razão em cache
  (`GATE_PRESET_IDS` continua só com os 3 presets de 5 m).
- Meta do dia: **+3R** (`GIRO_DIARIO_TARGET_R`) → STOP `daily_target`.
- Limite de perda do dia: **−3R** (`GIRO_DIARIO_LOSS_R`, simétrico à meta) → STOP `daily_loss_limit`. O que vier primeiro.
  Continuam activos os limites antigos (10 stakes, 6 perdas seguidas, 50 ops, 12 h).
- "Dia" = a sessão diária da agenda existente **08:00–20:00 Africa/Luanda** (uma sessão por dia de calendário de Luanda).
  R do dia = soma de R das operações fechadas nessa sessão. Na sessão local do browser, o "dia" é a sessão aberta.
  Nota: um STOP manual + novo PLAY no mesmo dia começa uma sessão nova (contagem a zero).
- Sem sinal válido (porta fechada ou sem sinal): **NO TRADE** o dia inteiro; nunca força operação.

## Selecção das estratégias (reprodutível)
`node scripts/giro-select.ts --out notes/data/giro-select-2026-10-27.json` — dados reais Bybit 5 m via proxy, BTC/ETH/SOL/XRP/DOGE,
janela de selecção dias 60→30 antes de 2026-10-27 (anterior aos dados que a porta usa ao vivo), custo 0,1 %, stop 1,2 ATR / alvo 1,5R / 12 velas.
Regra fixa: top-4 por média R entre as 20 estratégias da biblioteca, com ≥ 100 operações.

| estratégia | ops | média R |
|---|---|---|
| tendência-diária breakout-ATR 48×0.75 adx25 | 343 | −0,311 |
| rsi-reversao 14 25/75 | 400 | −0,335 |
| bollinger-reversao 20 k2.5 | 1130 | −0,345 |
| confluencia(estocastico 14/3 20/80 + rsi-reversao 14 30/70) ≥2 h3 | 901 | −0,360 |

**Todas negativas** (todas as 20 da biblioteca tinham média R < 0 com custo de 0,1 %). São as "menos más", não lucrativas. A EMA rápida
(`ema-cruza 9/21`, −0,509R) ficou de fora pela regra.

## Estado real da porta (2026-10-27, `node scripts/giro-gate-check.ts`)
5 m: BTC 11, ETH 7, SOL 10, XRP 1 operações OOS → **INSUFFICIENT (fechada, NO TRADE)**. 1 m: BTC 9, ETH 4 → fechada.

## Histórico profundo (PR seguinte, 2026-10-27) — porta no livro-razão em cache
**Diagnóstico:** o Giro Diário usava o walk-forward do arm (`CandleGateController`) sobre só **1600 velas** (5m ≈ 5,6 d; 1m ≈ 27 h),
com treino 1000 → ~600 velas fora da amostra → 1–16 operações OOS. Nunca chegaria a 100 por construção.

**Mudança:** `giro_diario` entra em `GATE_PRESET_IDS` → a cache do servidor (Redis, arranque a frio **90 d de 5m**, backfill diário
`30 3 * * *`, actualização preguiçosa) calcula o seu livro-razão (blocos de 500 velas, treino 1000, custo 0,1 %, stop 1,2 ATR / 1,5R / 12 velas).
O arm na nuvem em 5m usa o modo `ledger` (veredicto logo no arranque, streak semeado de validações passadas, sem esperar 12 velas).
1m continua no walk-forward local (a cache só existe para 5m).

**Sem fuga selecção→avaliação:** as 4 estratégias foram escolhidas nos dias 60→30 antes de 2026-10-27T14:41:47Z.
`GIRO_DIARIO_SELECTION_WINDOW = [1787928107, 1790524008)` (épocas s; + 13 velas de folga). Todo o bloco OOS que toque nesta janela
é **excluído** do veredicto (`ledgerAsOf(..., exclude)`), na cache e no arm. Os blocos antes (dias 90→60) e depois (dias 30→0) não foram
vistos pela selecção. Porta inalterada: ≥ 100 OOS e p < 0,01.

**Resultado real** (`node scripts/giro-ledger-check.ts`, proxy, 90 d = 25 920 velas, 48 blocos, 30 após exclusão, 83,3 d de profundidade):

| símbolo | n OOS | média R | p | porta |
|---|---|---|---|---|
| BTCUSDT | 395 | −0,976 | 1,000 | NO_EVIDENCE |
| ETHUSDT | 379 | −0,578 | 1,000 | NO_EVIDENCE |
| SOLUSDT | 422 | −0,518 | 1,000 | NO_EVIDENCE |
| XRPUSDT | 371 | −0,579 | 1,000 | NO_EVIDENCE |
| DOGEUSDT | 340 | −0,528 | 1,000 | NO_EVIDENCE |
| BNBUSDT | 389 | −0,773 | 1,000 | NO_EVIDENCE |
| ADAUSDT | 346 | −0,314 | 1,000 | NO_EVIDENCE |
| LINKUSDT | 306 | −0,260 | 1,000 | NO_EVIDENCE |

Já há operações de sobra (> 100); a porta fecha porque a média é **negativa** — mais histórico/dias não a abrem. 1m (só informativo,
25 d via proxy): BTC 840 OOS −2,65R, ETH 782 −1,46R, SOL 842 −1,06R → NO_EVIDENCE. Conclusão honesta: NO TRADE.
