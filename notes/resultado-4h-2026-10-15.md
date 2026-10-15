# Resultado do backtest 4 h pré-registado (2026-10-15) — dados REAIS

Pré-registo: `notes/preregistro-4h-forward-2026-10-15.md` (commit 9611f7d, feito antes de descarregar os dados).
Dados: klines 4 h reais da Bybit linear via proxy do projecto, descarregados 2026-10-15 ~14:00 (Luanda). Script: `scripts/f4h-backtest.ts`; resultados em bruto: `notes/data/f4h-backtest-2026-10-15.json`.

- Universo B: 20 símbolos pré-registados; **17 usados**. Excluídos pela regra pré-registada: FETUSDT, EOSUSDT, MKRUSDT (sem velas no proxy: provavelmente deslistados/renomeados). SANDUSDT falhou o 1.º download (erro de rede) e foi descarregado de novo — não foi exclusão.
- Janela: 2024-06-01 → 2026-10-15 12:00 UTC (28 blocos de 30 d). Custo primário 0,13 %, robustez 0,17 %.

| id | regra | n op | R/op líq. 0,13 % | R/op bruto | R/op 0,17 % | p diário | p ajust. (BH m=5) | blocos 30 d > 0 | último bloco | símb. R>0 | veredicto |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A3 | Donchian 20 | 871 | 0.107 | 0.127 | 0.101 | 0.080 | 0.196 | 19/28 | 0.0134 | 71% | falha: 1_BH |
| A4 | Donchian 55 | 563 | 0.061 | 0.080 | 0.054 | 0.275 | 0.275 | 17/28 | 0.0160 | 53% | falha: 1_BH,3_largura |
| B2 | EMA 20/50 | 450 | 0.124 | 0.143 | 0.118 | 0.138 | 0.196 | 16/28 | 0.0235 | 65% | falha: 1_BH,2_blocos |
| C2 | Donchian 20 + volatilidade | 264 | 0.134 | 0.152 | 0.128 | 0.137 | 0.196 | 11/28 | 0.0026 | 76% | falha: 1_BH,2_blocos |
| D2 | Momentum 90 velas | 1196 | 0.074 | 0.092 | 0.068 | 0.157 | 0.196 | 17/28 | -0.0010 | 65% | falha: 1_BH,2_blocos |

**Passam todas as regras: 0 de 5.** Nenhum passa o BH (p ajustados 0,196–0,275 > 0,10).

Leitura honesta: pela 3.ª vez (agora em 17 instrumentos novos) os 5 candidatos de tendência 4 h têm R/op líquido **positivo** (+0,06 a +0,13 R a 0,13 %),
resistem a 0,17 % e são positivos em 53–76 % dos símbolos — mas **sem significância estatística** depois do FDR, e vários falham a consistência por blocos de 30 d.
A época sobrepõe-se à dos estudos anteriores e as criptos são correlacionadas: não é evidência independente. Conclusão: **sem evidência**; nada vai para REAL.
A única evidência realmente nova virá do teste PAPER ao vivo (90 d, critérios fixos no pré-registo).
