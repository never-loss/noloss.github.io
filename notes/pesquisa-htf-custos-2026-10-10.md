# Pesquisa honesta: custos reais e estratégias 15 m / 1 h / 4 h (2026-10-10)

Todos os números abaixo são **REAIS** (klines Bybit linear USDT via proxy do projecto, descarregados em 2026-10-10 ~09:20 UTC+1), calculados com o motor existente
(`runCandleBacktest`, `expectancyPValue`, `benjaminiHochberg` de `src/core/fdr.ts`). **Não há dados sintéticos.** Nada aqui promete lucro.
Pré-registo: `preregistro-htf-2026-10-10.md` (commit 585a7d0, antes de qualquer backtest) e `preregistro-htf-addendo-2026-10-10.md`.
Scripts: `scripts/htf-fetch.mjs`, `scripts/htf-research.ts`. Resultados em bruto: `notes/data/htf-*.json`.

## 1. Custos reais

**Taxas oficiais Bybit (Help Center, "Trading Fee Structure" e "Futures Contracts: Fees Explained"), USDT perpétuos, não-VIP (VIP 0):**
taker **0,055 %**, maker **0,02 %** do valor nocional. VIP 1: 0,040 % / 0,018 %.
| cenário (ida e volta) | custo |
|---|---|
| taker × 2 | **0,110 %** |
| entrada taker + saída por ordem limite (maker) no alvo | 0,075 % |
| maker × 2 (sempre executado: irreal para stops) | 0,040 % |
| + derrapagem (não medida) | a somar |

- O custo assumido pelo bot é **0,1 %** fixo (`MARKETS.crypto.assumedCostFraction`). Em saídas de stop/tempo (a maioria) o custo real mínimo é 0,11 % + derrapagem, portanto **0,1 % é ligeiramente optimista, não pessimista**. Não foi alterado.
- **O PAPER não regista derrapagem nem preenchimentos**: `candle-paper.ts` e `candle-backtest.ts` aplicam `custo = preço de entrada × costFraction / distância do stop`, fixo, e os stops preenchem exactamente ao preço do stop (um stop de mercado real derrapa). Nas ordens reais (`bybit-trading.ts`, `lib/bybit-place.js`, `cloud-arm.ts`) não se lêem `avgPrice` / `execFee` das execuções. **O custo real não é medido em lado nenhum.**
- Funding de perpétuos (pago/recebido a cada 8 h) também não entra nos backtests.
- Próximo passo concreto (não implementado aqui): em PAPER guardar o preço de preenchimento simulado vs. fecho da vela e, no real, ler `execution/list` da Bybit (execFee, execPrice) para medir custo e derrapagem reais.

## 2. Estratégias em tempos gráficos superiores

### Desenho (resumo; detalhes no pré-registo)
17 candidatos fixos (Donchian, EMA, Donchian com filtro de volatilidade, momentum de série temporal, momentum/reversão cross-seccional) em 15 m (180 d), 1 h (540 d) e 4 h (1080 d), 30 símbolos líquidos (todos com histórico completo; nenhum excluído), stop 3 ATR (≤ 8 % do preço), alvo 2R, custo 0,11 %.
Descoberta = primeiros 2/3, confirmação = último 1/3; p-value sobre a série diária agregada; BH q = 0,10 com m = 17; regras 2–5 do pré-registo. Períodos: 15 m 2026-04-15→2026-10-10; 1 h 2025-04-28→2026-10-10; 4 h 2023-12-06→2026-10-10.
**Funding / open interest: não testados** — o proxy só serve klines (`mode=funding` é ignorado); exigiria um endpoint novo read-only + deploy.

### Resultado principal (17 testes) — REAL
| id | tf | símb. | nº op desc/conf | R/op líq. (0,11 %) | R/op bruto | R/op desc / conf | p desc | p ajust. (BH, m) | p conf | blocos 30 d > 0 | média diária último bloco | símb. com R>0 | R/op @0,075 % | R/op @0,15 % | veredicto |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | 1h | 30 | 4386/2221 | 0.031 | 0.069 | 0.045 / 0.003 | 0.248 | 0.753 | 0.478 | 9/17 | 0.0261 | 60% | 0.043 | 0.017 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| A2 | 1h | 30 | 2815/1390 | 0.006 | 0.042 | -0.010 / 0.038 | 0.546 | 0.919 | 0.311 | 7/17 | 0.0009 | 50% | 0.017 | -0.007 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| A3 | 4h | 30 | 1820/1184 | 0.062 | 0.082 | 0.125 / -0.036 | 0.034 | 0.416 | 0.677 | 15/34 | -0.0042 | 73% | 0.068 | 0.054 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| A4 | 4h | 30 | 1192/785 | 0.056 | 0.077 | 0.081 / 0.019 | 0.163 | 0.691 | 0.433 | 17/34 | 0.0064 | 67% | 0.063 | 0.049 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| A5 | 15m | 30 | 3976/2096 | -0.085 | 0.001 | -0.161 / 0.061 | 0.999 | 0.999 | 0.292 | 2/5 | 0.0619 | 20% | -0.057 | -0.116 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| A6 | 15m | 30 | 2747/1485 | -0.084 | -0.003 | -0.168 / 0.072 | 0.999 | 0.999 | 0.280 | 2/5 | 0.0241 | 13% | -0.058 | -0.113 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| B1 | 1h | 30 | 2968/1458 | -0.034 | 0.004 | -0.016 / -0.070 | 0.595 | 0.919 | 0.878 | 7/17 | 0.0448 | 50% | -0.022 | -0.048 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| B2 | 4h | 30 | 948/636 | 0.070 | 0.090 | 0.131 / -0.021 | 0.049 | 0.416 | 0.620 | 18/34 | 0.0147 | 70% | 0.076 | 0.062 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| B3 | 15m | 30 | 3039/1411 | -0.144 | -0.049 | -0.161 / -0.107 | 0.998 | 0.999 | 0.938 | 0/5 | -0.0749 | 7% | -0.114 | -0.178 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| C1 | 1h | 30 | 2964/1502 | 0.057 | 0.090 | 0.050 / 0.071 | 0.266 | 0.753 | 0.176 | 9/17 | 0.0019 | 70% | 0.067 | 0.045 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| C2 | 4h | 30 | 737/564 | 0.157 | 0.176 | 0.126 / 0.198 | 0.083 | 0.468 | 0.064 | 17/34 | -0.0125 | 83% | 0.163 | 0.150 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| C3 | 15m | 30 | 3050/1694 | -0.074 | 0.002 | -0.153 / 0.069 | 0.997 | 0.999 | 0.273 | 2/5 | 0.0204 | 20% | -0.050 | -0.102 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| D1 | 1h | 30 | 6183/3179 | 0.000 | 0.037 | 0.004 / -0.007 | 0.470 | 0.887 | 0.531 | 9/17 | 0.0222 | 47% | 0.012 | -0.013 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| D2 | 4h | 30 | 2453/1439 | 0.069 | 0.088 | 0.019 / 0.153 | 0.374 | 0.796 | 0.019 | 23/34 | 0.0195 | 80% | 0.075 | 0.062 | falha: 1_BH_descoberta,2_confirmacao |
| E1 | 1h | 30 | 2910/1417 | -0.037 | 0.001 | -0.015 / -0.081 | 0.793 | 0.999 | 0.999 | 6/17 | -0.0257 | 37% | -0.025 | -0.051 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| E2 | 1h | 30 | 3268/1634 | -0.051 | -0.013 | -0.032 / -0.090 | 0.958 | 0.999 | 1.000 | 2/17 | 0.0373 | 27% | -0.039 | -0.065 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |
| E3 | 4h | 30 | 1551/986 | -0.009 | 0.012 | 0.010 / -0.039 | 0.374 | 0.796 | 0.875 | 13/34 | -0.0106 | 47% | -0.002 | -0.017 | falha: 1_BH_descoberta,2_confirmacao,3_blocos,4_largura,5_custo015 |

Controlo de entradas aleatórias (1 h, 5941 operações): R/op líquido −0,081, bruto −0,044 (o motor não tem viés positivo; o custo come ≈ 0,04 R).

**Passam o BH na descoberta: 0 de 17. Passam todas as regras: 0 de 17.**

Leitura:
- **15 m**: claramente negativo (R/op −0,07 a −0,14; bruto ≈ 0). Pior que 5 m em custo/ruído. Descartado.
- **1 h**: bruto +0,00 a +0,09 R, líquido ≈ 0 a +0,06 (C1 melhor) — sem significância; cross-seccional (E1, E2) negativo.
- **4 h**: os 5 de tendência (A3, A4, B2, C2, D2) têm R/op líquido **+0,056 a +0,157** e bruto +0,08 a +0,18, positivo a 0,15 % também. Mas o p-value diário na descoberta é 0,03–0,37 (ajustado 0,42–0,80) e vários blocos de 30 d são negativos. **Sugestivo, não provado.** E3 (cross-seccional 4 h) ≈ 0.
- Menos operações/mês (1,3–3,7 por símbolo em 4 h vs 24–34 em 15 m) confirmam que o custo pesa muito menos.

### Adendo: 4 h em dados anteriores (hipótese gerada a posteriori; pré-registada antes de descarregar) — REAL
Apenas 5 candidatos (A3, A4, B2, C2, D2), mesmos parâmetros, janela anterior a 2023-12-06.
**A) Regra pré-registada (símbolos com velas 4 h desde ≤ 2021-03-01): só 4 símbolos sobraram** (a Bybit linear só tem histórico longo em poucos pares) → subpotenciado.
| id | tf | símb. | nº op desc/conf | R/op líq. (0,11 %) | R/op bruto | R/op desc / conf | p desc | p ajust. (BH, m) | p conf | blocos 30 d > 0 | média diária último bloco | símb. com R>0 | R/op @0,075 % | R/op @0,15 % | veredicto |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A3 | 4h | 4 | 221/196 | 0.135 | 0.157 | 0.145 / 0.124 | 0.082 | 0.118 | 0.196 | 16/33 | -0.0944 | 100% | 0.142 | 0.127 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| A4 | 4h | 4 | 140/118 | 0.199 | 0.220 | 0.303 / 0.076 | 0.017 | 0.085 | 0.327 | 17/33 | -0.0255 | 100% | 0.206 | 0.191 | falha: 2_confirmacao,3_blocos |
| B2 | 4h | 4 | 113/89 | 0.141 | 0.162 | 0.183 / 0.087 | 0.109 | 0.118 | 0.383 | 15/33 | -0.0255 | 100% | 0.148 | 0.133 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| C2 | 4h | 4 | 71/101 | 0.300 | 0.320 | 0.274 / 0.318 | 0.064 | 0.118 | 0.040 | 18/33 | -0.0681 | 100% | 0.306 | 0.293 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| D2 | 4h | 4 | 300/224 | 0.109 | 0.129 | 0.102 / 0.117 | 0.118 | 0.118 | 0.138 | 19/33 | -0.0159 | 75% | 0.115 | 0.101 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |

BH com m = 5: A4 passa na descoberta (p ajust. 0,085) mas **falha a confirmação** (p = 0,327). Controlo aleatório: R/op +0,064 em 305 operações (o ruído desta amostra é maior que o efeito).

**B) Desvio a posteriori (rotulado, não é confirmação):** relaxar para símbolos desde ≤ 2021-12-01 → 25 símbolos, 2022-01-10→2023-12-04. Descritivo; conta como +5 testes.
| id | tf | símb. | nº op desc/conf | R/op líq. (0,11 %) | R/op bruto | R/op desc / conf | p desc | p ajust. (BH, m) | p conf | blocos 30 d > 0 | média diária último bloco | símb. com R>0 | R/op @0,075 % | R/op @0,15 % | veredicto |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A3 | 4h | 25 | 949/754 | 0.120 | 0.142 | 0.105 / 0.140 | 0.102 | 0.170 | 0.127 | 11/23 | -0.0167 | 88% | 0.127 | 0.113 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| A4 | 4h | 25 | 607/457 | 0.184 | 0.205 | 0.180 / 0.189 | 0.043 | 0.120 | 0.103 | 12/23 | -0.0052 | 84% | 0.191 | 0.176 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| B2 | 4h | 25 | 436/366 | 0.091 | 0.113 | 0.089 / 0.094 | 0.188 | 0.235 | 0.280 | 9/23 | -0.0219 | 68% | 0.098 | 0.083 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| C2 | 4h | 25 | 336/404 | 0.211 | 0.230 | 0.040 / 0.352 | 0.371 | 0.371 | 0.016 | 11/23 | 0.0051 | 88% | 0.217 | 0.203 | falha: 1_BH_descoberta,2_confirmacao,3_blocos |
| D2 | 4h | 25 | 1224/935 | 0.111 | 0.131 | 0.120 / 0.099 | 0.048 | 0.120 | 0.181 | 15/23 | 0.0108 | 80% | 0.117 | 0.103 | falha: 1_BH_descoberta,2_confirmacao |

Controlo aleatório: R/op −0,009 (1242 operações). BH conjunto (17 + 5 = 22 p-values): ajustados 0,27–0,63 → **nenhum passa**.

### Contagem total de testes
17 (principal) + 5 (adendo A) + 5 (adendo B, a posteriori) = **27**; o FDR formal do estudo principal usa m = 17, o do conjunto m = 22 (A e B reutilizam os mesmos 5 candidatos; B é descritivo).
Sensibilidades de custo (0,075 % e 0,15 %) são descritivas e não contam como testes.

## 3. Conclusão e recomendação (honesta)

1. **Nenhuma estratégia passou as regras pré-registadas. Nenhum preset novo foi entregue; a porta, o custo por omissão e o modo PAPER ficam como estão.**
2. As estratégias de **5 min** (actuais) e as de **15 m** não têm edge líquido; **1 h** é ≈ 0.
3. Há uma **pista**, não uma evidência: seguimento de tendência em **4 h** (breakout Donchian 20/55, EMA 20/50, momentum 15 d, com stop largo 3 ATR e alvo 6 ATR) mostra R/op líquido positivo (≈ +0,06 a +0,21 com 30/25 símbolos; até +0,30 só com 4 símbolos) em **dois períodos disjuntos** (2023-12→2026-10 e 2022-01→2023-12) e resiste a 0,15 % de custo. Mas: (a) sem significância depois de FDR; (b) os 5 candidatos são muito correlacionados entre si, logo não são 5 provas independentes; (c) o último bloco de 30 d é misto no estudo principal (−0,013 a +0,020 de média diária) e negativo na maioria no adendo; (d) universo com viés de sobrevivência e a lista de candidatos escolhida a posteriori; (e) sem funding.
4. O que seria preciso a seguir (por ordem): (i) mais dados 4 h/1 d com histórico longo (Binance/Bybit spot ou inverse desde 2019–2020, BTC/ETH/…); (ii) registar **custo real** (derrapagem + execFee) em PAPER; (iii) um novo teste **pré-registado só em 4 h**, com família pequena fixa (≤ 5 candidatos), acompanhando em PAPER ao vivo (forward test) durante ≥ 2–3 meses antes de qualquer decisão; (iv) para a porta suportar 4 h seria necessário generalizar o livro-razão/cache (hoje só 5 min) — trabalho separado, só justificado se (iii) confirmar.
5. Não há evidência para baixar custos, abrir a porta ou prometer ganhos.

## Limitações
Sobrevivência de símbolos; sem funding; sem derrapagem; preenchimentos de stop/alvo idealizados; p-values sobre séries diárias com possível autocorrelação; período de 15 m de só 6 meses (um único regime); candidatos 4 h do adendo seleccionados depois de ver resultados.

## Como reproduzir
```
node scripts/htf-fetch.mjs --out /workspace/tmp/htf                       # ~6 min
node scripts/htf-research.ts --dir /workspace/tmp/htf                      # ~30 s
node scripts/htf-fetch.mjs --tfs 4h --days 2100 --out /workspace/tmp/htf-old
node scripts/htf-research.ts --mode old --dir /workspace/tmp/htf-old --only A3,A4,B2,C2,D2 [--min-start 2021-12-01T00:00:00Z]
```
(Nota: no modo `old` a linha do controlo imprime "1h" por engano de rótulo; é o controlo em 4 h.)
