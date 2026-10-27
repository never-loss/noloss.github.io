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
