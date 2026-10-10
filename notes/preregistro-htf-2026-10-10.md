# Pré-registo: estratégias de tempo gráfico superior (2026-10-10)

**Este ficheiro foi escrito e commitado ANTES de descarregar dados ou correr qualquer backtest desta investigação.**
Nada aqui promete lucro. Regras mantidas: a porta não é enfraquecida, o custo por omissão (0,1 %) não muda, PAPER é o padrão.

Contexto: com 90 d reais em 5 min o edge bruto das 3 estratégias actuais é ≈ 0 (ver `shadow-fdr-cost-2026-10-10.md`).
Hipótese a testar: tempos gráficos maiores (15 m / 1 h / 4 h), stops mais largos e menos operações reduzem o custo em R e podem deixar edge líquido.

## 1. Dados
- Fonte: klines **reais** Bybit linear USDT via proxy `https://noloss-zeta.vercel.app/api/bybit-klines` (velas fechadas, volume > 0, sem duplicados).
- Universo fixo (30, escolhido por liquidez conhecida, sem olhar para resultados):
  BTC ETH SOL XRP DOGE BNB ADA AVAX LINK LTC DOT TRX BCH ATOM NEAR APT ARB OP SUI INJ FIL ETC UNI AAVE XLM HBAR ICP ALGO RUNE CRV (todos `…USDT`).
  Um símbolo sem histórico completo na janela do tempo gráfico é **excluído desse tempo gráfico** e a exclusão é reportada.
- Janelas (terminam na última vela fechada no momento do download): **15 m: 180 d · 1 h: 540 d · 4 h: 1080 d**.
- Viés de sobrevivência: o universo são símbolos hoje líquidos; isso favorece estratégias long/momentum. Será dito no relatório.
- Funding / open interest: **não testados** (o proxy só serve klines; `mode=funding` é ignorado). Só entrariam via um caminho read-only novo por PR + deploy, que não faz parte deste estudo.

## 2. Execução simulada (igual para todos os candidatos; motor `runCandleBacktest`)
- Sinal na vela fechada i → entrada na abertura da vela i+1; compra e venda; uma posição por símbolo.
- Stop = 3 × ATR(14) da vela do sinal; alvo = 2R (= 6 ATR); saída por tempo: 15 m → 192 velas, 1 h → 96, 4 h → 60 (candidatos E têm o seu próprio, ver abaixo).
- Sinais com stop > 8 % do preço são descartados (equivale a alavancagem ≥ ~12× no limite; o filtro de 1 % do legado Deriv não se aplica a Bybit com stake por risco).
- **Custo primário (decisão): 0,11 % ida-e-volta** = taker 0,055 % × 2 (tabela oficial Bybit VIP 0), **sem** derrapagem (optimista; a derrapagem não é medida em lado nenhum do bot).
- Sensibilidades **descritivas** (não entram na decisão, excepto a regra 5 abaixo): 0,075 % (entrada taker + saída TP limite maker) e 0,15 % (≈ taker×2 + 0,04 % de derrapagem).
- Funding pago/recebido ignorado (limitação).

## 3. Candidatos (17, parâmetros fixos, sem optimização, sem escolha por bloco)
Donchian = fecho acima do máximo das N velas anteriores (+1) ou abaixo do mínimo (−1).
| id | tempo | regra |
|---|---|---|
| A1 | 1 h | Donchian N=48 |
| A2 | 1 h | Donchian N=120 |
| A3 | 4 h | Donchian N=20 |
| A4 | 4 h | Donchian N=55 |
| A5 | 15 m | Donchian N=96 |
| A6 | 15 m | Donchian N=192 |
| B1 | 1 h | cruzamento EMA 12/48 (`emaCross`) |
| B2 | 4 h | cruzamento EMA 20/50 |
| B3 | 15 m | cruzamento EMA 24/96 |
| C1 | 1 h | A1 só se ATR14/fecho > mediana das 200 velas anteriores (regime de volatilidade em expansão) |
| C2 | 4 h | A3 com o mesmo filtro |
| C3 | 15 m | A5 com o mesmo filtro |
| D1 | 1 h | momentum de série temporal: sinal = sinal do retorno das últimas 168 velas |
| D2 | 4 h | idem, 90 velas |
| E1 | 1 h | momentum cross-seccional: à vela que fecha às 00:00 UTC, ordenar símbolos pelo retorno de 168 velas; top 20 % → compra, bottom 20 % → venda; saída por tempo 24 velas |
| E2 | 1 h | reversão cross-seccional: retorno de 24 velas; top 20 % → venda, bottom 20 % → compra; saída por tempo 24 velas |
| E3 | 4 h | momentum cross-seccional: fecho às 00:00 UTC, retorno de 180 velas (30 d); top/bottom 20 %; saída por tempo 18 velas |

**Total de testes para o FDR: m = 17.** Controlo (fora do FDR, só para validar o motor): sinais de direcção aleatória (semente fixa) em 1 h com as mesmas saídas — esperado ≈ −custo em R.

## 4. Estatística
- Os parâmetros são fixos a priori ("sem ajuste") → o período inteiro é fora da amostra para a regra; o risco é eu escolher candidatos, por isso a divisão cronológica.
- **Descoberta = primeiros 2/3 do tempo** (por época) · **Confirmação = último 1/3**. Primeiras 250 velas só aquecem indicadores. Entradas só dentro de cada período.
- Estatística por candidato: série diária (UTC, pelo dia de saída) = soma do R líquido das operações fechadas nesse dia / nº de símbolos do universo desse tempo gráfico (dias sem operações = 0). p-value unilateral (média > 0) com `expectancyPValue` sobre essa série diária — trata a correlação entre símbolos (que o p-value por operação ignoraria).

## 5. Regra de decisão (todas têm de se verificar; caso contrário NÃO se entrega estratégia)
1. **Descoberta:** Benjamini-Hochberg `q = 0,10` sobre os 17 p-values; o candidato tem de passar e ter média diária > 0.
2. **Confirmação:** média diária > 0 e p < 0,05 / k (k = nº de sobreviventes da regra 1; Bonferroni).
3. **Consistência por blocos:** período inteiro dividido em blocos de 30 dias: ≥ 60 % dos blocos com média diária > 0 **e** o último bloco (30 d mais recentes) > 0.
4. **Largura:** ≥ 60 % dos símbolos com R médio por operação > 0 no período inteiro, e R médio por operação (período inteiro, custo primário) > 0.
5. **Robustez ao custo:** R médio por operação > 0 também a 0,15 %.
6. Se passar, a porta existente (`evaluateCandleGate` / livro) ainda tem de abrir com os mesmos limites; a porta nunca é afrouxada. Só então haveria implementação como preset opt-in (PAPER), com testes e CI verde.

Resultado esperado a priori: provável que nada passe; isso é um resultado válido e será reportado tal como é.
