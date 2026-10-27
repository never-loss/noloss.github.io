# Pré-registo: "Analista Diário" (2026-10-27)

**Escrito e commitado ANTES de descarregar dados ou ver qualquer resultado.** Nada aqui promete lucro.
Não muda nenhuma porta, preset, custo por omissão (0,1 %) nem o PAPER por omissão. Stake fixa, sem martingale/recuperação.
Lista fechada de 6 candidatos; nenhum parâmetro será ajustado depois de ver dados.

Pedido do utilizador: "como um humano que analisa o mercado diariamente, faz trades lucrando 1 % ou mais e perdendo menos".

## 1. Regras comuns (todas as variantes)
- Dados: klines REAIS Bybit linear USDT (proxy `https://noloss-zeta.vercel.app/api/bybit-klines`), velas de **1 h** com volume;
  velas diárias (UTC) e de 4 h obtidas por reamostragem das de 1 h. Só velas fechadas; sinal na vela 1 h fechada → entrada na **abertura da vela seguinte**.
- Filtros diários usam só o **dia anterior fechado** (sem olhar para o futuro).
- Tendência diária do símbolo: fecho diário de ontem > EMA20 diária → só compras; < → só vendas.
- Regime BTC: fecho diário de ontem do BTCUSDT vs EMA20 diária do BTC — compras só com BTC acima, vendas só com BTC abaixo.
- Saídas: **stop 0,5 %** do preço de entrada, **alvo 1,0 %** (R:R 2). Se stop e alvo cabem na mesma vela de 1 h → conta como **stop** (conservador).
  Se nenhum for tocado: saída no fecho da última vela do dia UTC de entrada (máx. 1 dia em posição).
- Máx. **1 operação por símbolo por dia UTC** e uma posição por símbolo.
- Custo primário **0,1 % ida e volta** (= 0,2 R); robustez **0,11 %** (taker 0,055 % × 2). R líquido = (movimento % − custo) / 0,5 %.

## 2. Candidatos (6, fixos)
| id | ideia "humana" | entrada (na direcção da tendência diária + regime BTC) |
|---|---|---|
| AD1 | pullback à média | vela 1 h toca a EMA20 de 1 h (mínimo ≤ EMA para compra) e fecha do lado da tendência |
| AD2 | rompimento da máxima/mínima de ontem com volume | fecho 1 h > máxima de ontem (venda: < mínima) e volume da vela > 1,5 × média das 20 velas 1 h anteriores |
| AD3 | rejeição de suporte/resistência | mínimo 1 h < mínima de ontem e fecho 1 h > mínima de ontem (venda: espelho com a máxima) |
| AD4 | AD1 + volatilidade | AD1 só se ATR14 diário / fecho (de ontem) ≥ 2 % (dia com amplitude para 1 %) |
| AD5 | rompimento da faixa de abertura | faixa = primeira vela de 4 h do dia UTC (00–04); fecho 1 h acima da máxima da faixa (venda: abaixo da mínima), só depois das 04:00 |
| AD6 | rompimento 4 h com tendência | fecho de vela 4 h > máximo das 20 velas 4 h anteriores (venda: < mínimo); entrada na abertura da vela 1 h seguinte |

## 3. Universo e janelas
- 40 símbolos (pré-fixados): BTC ETH SOL XRP DOGE BNB ADA AVAX LINK LTC DOT TRX BCH ATOM NEAR APT ARB OP SUI INJ FIL ETC UNI AAVE XLM HBAR ICP ALGO RUNE CRV
  1000PEPE WIF SHIB1000 1000BONK TIA SEI WLD ORDI LDO ENA (todos `…USDT`). Símbolos sem histórico desde 2025-05-01 ou deslistados são excluídos e reportados.
- Download: ~560 dias de 1 h até à última vela fechada.
- **Treino/descrição: 2025-06-01 → 2026-04-30** (só reportado; não se escolhe nada com ele porque os parâmetros já estão fixos).
- **Fora da amostra (OOS, decide): 2026-05-01 → última vela fechada.**
  Limitação honesta: esta época sobrepõe-se à de estudos anteriores (regras diferentes) e as criptos são correlacionadas.

## 4. Critério de aprovação (OOS, todos obrigatórios, por candidato)
1. ≥ 100 operações OOS (pooled) e R médio líquido > 0 a 0,1 %.
2. p unilateral (`expectancyPValue`) sobre os R por operação; **BH ajustado (m = 6) < 0,01**.
3. Robustez à correlação: p da série diária (R médio por dia) < 0,01.
4. R médio > 0 também a 0,11 %.
5. ≥ 60 % dos símbolos com R médio > 0.
Se nenhum passar: "sem evidência"; a estratégia, se existir no bot, fica atrás da porta fechada (NO TRADE). Se algum passar: só PAPER; nunca REAL automático.
