# Modo sombra, FDR e sensibilidade ao custo (2026-10-10)

Tudo aqui é **informativo e só de leitura**. Não muda o custo por omissão (0,1 % ida-e-volta), nenhuma porta, nenhum arm,
nenhum stake/modo. PAPER continua o padrão. Nada nesta nota promete lucro.

## 1. Modo sombra (porta nova vs antiga)

- **Porta nova** = livro-razão (`gate-ledger`, 90 d de histórico, blocos fechados). **Porta antiga** = walk-forward curto sobre a cauda guardada
  (treino 40 %, teste 20 %, máx. 1000/500 velas) — o que o painel fazia antes do livro.
- Cada refresh da cache (`computeGateEntry`) guarda também o veredicto antigo (`legacy`) e o OOS agregado (`oosMeanR`, `oosP`). Não há
  chamadas extra à Bybit: usa a cauda que já existe.
- `GET /api/bybit-klines?mode=gate-shadow` → por preset: `bothOpen / newOnly / oldOnly / bothClosed`, lista de discordâncias, portas novas abertas
  e quantas sobrevivem ao FDR. `mode=gate&symbols=all` passa a trazer `fdr` por símbolo/preset (`adjP`, `pass`, `m`, `q`).
- Nada disto abre ou fecha portas.

## 2. FDR (Benjamini-Hochberg), critério mais estrito

- Com ~40 símbolos × 3 presets a olhar para os mesmos dados, alguns `p < 0,05` aparecem só por acaso. O BH controla a taxa de falsas descobertas.
- Família = mesmo preset, entre símbolos, só com `nOOS >= 30` e p-value do OOS agregado disponível. `q = 0,10`.
- É **mais estrito e apenas informativo**: a porta continua a decidir pelos seus critérios; o FDR é uma segunda opinião.
- Implementação: `src/core/fdr.ts` (puro, testado: exemplo clássico do BH, monotonia, empates, nulos), `src/core/gate-shadow.ts`.

### Medição real (dados REAIS da Bybit via proxy, 39 símbolos da cache, 90 d, 2026-10-10 ~07:20 UTC+1)

`node scripts/shadow-report.ts` (cálculo local, não escreve em Redis):

| preset | testados | ambas abertas | só nova | só antiga | ambas fechadas | portas novas abertas | passam FDR (q=0,1) |
|---|---|---|---|---|---|---|---|
| lucro_rapido | 39 | 0 | 0 | 0 | 39 | 0 | 0 |
| loss_zero | 39 | 0 | 0 | 0 | 39 | 0 | 0 |
| blitz_zero | 39 | 0 | 0 | 0 | 39 | 0 | 0 |

Leitura honesta: hoje **as duas portas concordam em tudo — fechadas** — e nenhum símbolo passa o FDR em nenhum preset. Isto é coerente
com a secção 3: com o custo de 0,1 % não há evidência. Um modo sombra sem discordâncias não prova que a porta nova é "melhor", só que
não é mais permissiva do que a antiga neste instante. Convém continuar a observar em regimes de mercado diferentes.

## 3. Sensibilidade ao custo e a stops mais largos (DADOS REAIS, proxy)

`node scripts/cost-sensitivity.ts --days 90` — 10 símbolos (BTC, ETH, SOL, XRP, DOGE, BNB, ADA, AVAX, LINK, LTC), 25 920 velas de 5 min cada
(90 d, 2026-07-12 → 2026-10-10), 3 presets × 3 stops × 5 custos = 45 cenários × 10 símbolos. Veredicto = porta do livro (OOS dos últimos ≤100 blocos).

Custos testados (por ida-e-volta, fracção do preço; rótulos ilustrativos, **não** é a tabela oficial da Bybit):
0,10 % (padrão do bot) · 0,06 % (taker×2 tipo VIP) · 0,04 % (maker×2) · 0,02 % (maker×2 tipo VIP) · 0,00 % (limite teórico, irreal).
Stops: o do preset (1,2 ATR em lucro_rapido/blitz_zero, 1,5 em loss_zero), 2,5 e 4,0 ATR.

### Custo em unidades de R (mediana) — porque o custo mata o scalping de 5 min

| símbolo / stop | 0,10 % | 0,06 % | 0,04 % | 0,02 % |
|---|---|---|---|---|
| BTC, 1,2 ATR | 0,69 R | 0,41 R | 0,28 R | 0,14 R |
| BTC, 2,5 ATR | 0,33 R | 0,20 R | 0,13 R | 0,07 R |
| BTC, 4,0 ATR | 0,21 R | 0,12 R | 0,08 R | 0,04 R |
| SOL, 1,2 ATR | 0,43 R | 0,26 R | 0,17 R | 0,09 R |
| SOL, 4,0 ATR | 0,13 R | 0,08 R | 0,05 R | 0,03 R |

Com o stop do preset, só o custo de 0,1 % come ~0,4–0,7 R por operação: a estratégia precisaria de uma expectativa bruta superior a isso.

### Mediana (entre símbolos) da média de R por operação OOS · portas abertas / 10

Cada célula: `mediana meanR (nº de portas abertas)`. "pos" = nº de símbolos (de 10, com n OOS ≥ 30) com média > 0.

| preset | stop (ATR) | 0,10 % | 0,06 % | 0,04 % | 0,02 % | 0,00 % |
|---|---|---|---|---|---|---|
| lucro_rapido | 1,2 | −0,403 (0) | −0,269 (0) | −0,172 (0) | −0,081 (0) | +0,011 (0) · pos 8 |
| lucro_rapido | 2,5 | −0,248 (0) | −0,127 (0) | −0,088 (0) | −0,041 (0) | +0,017 (0) · pos 8 |
| lucro_rapido | 4,0 | −0,202 (0) | −0,133 (0) | −0,095 (0) | −0,048 (0) | −0,004 (0) · pos 3 |
| blitz_zero | 1,2 | −0,411 (0) | −0,236 (0) | −0,145 (0) | −0,070 (0) | +0,011 (0) · pos 6 |
| blitz_zero | 2,5 | −0,202 (0) | −0,086 (0) | −0,027 (0) | 0,000 (0) | +0,107 (0) · pos 6 |
| blitz_zero | 4,0 | −0,151 (0) | −0,068 (0) | −0,032 (0) | 0,000 (0) | +0,022 (0) · pos 2 |
| loss_zero | 1,5 | −0,301 (0) | −0,185 (0) | −0,131 (0) | −0,061 (0) | +0,017 (0) · pos 6 |
| loss_zero | 2,5 | −0,044 (0) | 0,000 (0) | +0,017 (0) | +0,070 (0) | +0,122 (0) · pos 5 |
| loss_zero | 4,0 | sem operações (todas as variantes inviáveis pelo stake mínimo) | | | | |

### Conclusões (honestas)

1. **Nenhuma das 450 células (45 cenários × 10 símbolos) abriu a porta.** Nem com custo zero.
2. Baixar o custo ajuda muito (a mediana sobe de ≈ −0,40 R para ≈ −0,08 R com 0,02 %), mas **a mediana só chega a ≈ 0 com custo 0**: o
   edge bruto destas estratégias de 5 min, nestes 90 d, é praticamente nulo. O custo não é a única causa.
3. Stops mais largos reduzem o custo em R, mas também reduzem o nº de operações viáveis (loss_zero a 4 ATR: 0 operações) e não criaram evidência.
4. **Procurar na grelha é "olhar para o lado"**: FDR sobre a grelha inteira por preset (lucro_rapido 150 testes, loss_zero 84, blitz_zero 110, com n OOS ≥ 30):
   **0 portas abertas e 0 que passem o BH**. O melhor p-value bruto de toda a grelha foi 0,03 (AVAX, lucro_rapido, 2,5 ATR, custo 0) — com 150 testes
   é exactamente o que o acaso produz, e não sobrevive à correção.
5. Implicação prática: baixar custos (ordens maker, escalão VIP) é necessário mas **não suficiente**; não há razão, com estes dados, para mudar o custo por omissão
   nem para abrir a porta. Qualquer mudança de custo deve ser feita só com o custo realmente pago (taxa da conta + derrapagem medida em PAPER), nunca por "otimismo".

### Limitações
- 90 d é uma única fase de mercado; 10 símbolos; presets e parâmetros fixos (não otimizados — de propósito).
- O custo em R é a mediana ao longo do período; o custo real varia (derrapagem, funding, maker nem sempre executado — `0,04 %` assume sempre executado).
- A média de R do OOS agregado ignora a escolha da estratégia por bloco para loss_zero (INSUFFICIENT por n < 1000 mesmo assim aparece como número, mas a porta fecha).

## Como reproduzir
```
node scripts/cost-sensitivity.ts --days 90 --out /tmp/cost.json   # ~1 min 35 s
node scripts/shadow-report.ts --out /tmp/shadow.json              # ~2 min 40 s (39 símbolos)
```
