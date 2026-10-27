# Resultado "Analista Diário" (2026-10-27) — dados REAIS

Pré-registo: `notes/preregistro-analista-diario-2026-10-27.md` (commit ec09adf, feito antes de descarregar dados).
Dados: klines 1 h Bybit linear via proxy do projecto (`scripts/ad-fetch.mjs`), 40/40 símbolos, 13 441 velas cada (2025-04-15 → 2026-10-27 15:00 UTC).
Script: `scripts/ad-backtest.ts`; bruto: `notes/data/analista-diario-2026-10-27.json` (inclui por símbolo). OOS = 2026-05-01 → fim.
Stop 0,5 % / alvo 1 % (R:R 2), custo 0,1 % ida e volta = 0,2 R por operação.

| id | regra | treino n / R | OOS n | alvo 1 % atingido | R/op 0,1 % | % por op 0,1 % | R/op bruto | R/op 0,11 % | p op | p BH (m=6) | p diário | símb. R>0 | veredicto |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AD1 | pullback EMA20 1 h | 9311 / −0,215 | 4850 | 32,3 % | −0,190 | −0,095 % | +0,010 | −0,210 | 1,000 | 1,000 | 1,000 | 8 % | falha |
| AD2 | rompe máx/mín de ontem + volume | 3941 / −0,313 | 2027 | 27,9 % | −0,331 | −0,166 % | −0,131 | −0,351 | 1,000 | 1,000 | 1,000 | 3 % | falha |
| AD3 | rejeição de suporte/resistência de ontem | 3312 / −0,341 | 1831 | 31,3 % | −0,194 | −0,097 % | +0,006 | −0,214 | 1,000 | 1,000 | 0,659 | 15 % | falha |
| AD4 | AD1 + ATR diário ≥ 2 % | 9252 / −0,216 | 4759 | 32,5 % | −0,195 | −0,097 % | +0,005 | −0,215 | 1,000 | 1,000 | 1,000 | 8 % | falha |
| AD5 | rompe faixa de abertura (4 h) | 6441 / −0,308 | 3186 | 30,2 % | −0,259 | −0,129 % | −0,059 | −0,279 | 1,000 | 1,000 | 1,000 | 5 % | falha |
| AD6 | rompe Donchian 20 em 4 h | 2498 / −0,299 | 1233 | 26,9 % | −0,369 | −0,185 % | −0,169 | −0,389 | 1,000 | 1,000 | 1,000 | 3 % | falha |

**Passam: 0 de 6.** Todas negativas no treino e no OOS. (O ATR diário ≥ 2 % quase nunca filtra, por isso AD4 ≈ AD1.)

Leitura honesta: com alvo 1 % e stop 0,5 % é preciso acertar > 40 % (33,3 % + custo) só para empatar; as variantes atingem o alvo
em 27–33 % das vezes. Antes de custos ficam ≈ 0 (o melhor é +0,01 R); o custo de 0,2 R por operação torna tudo negativo.
"Lucrar 1 %+ e perder menos" por operação **não é suportado pelos dados**: um stop curto é tocado muito mais vezes que o alvo largo.

Implementado: só um cartão informativo em `/bybit` ("Analista Diário: sem garantia de lucro — só opera se a evidência passar a porta"),
NO TRADE, não seleccionável, sem preset/arm/ordens. Nenhuma porta, preset ou custo alterado.
