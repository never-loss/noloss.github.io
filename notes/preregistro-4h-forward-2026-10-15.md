# Pré-registo: teste 4 h (só seguimento de tendência) + teste PAPER ao vivo (2026-10-15)

**Escrito e commitado ANTES de descarregar qualquer dado novo.** Nada aqui promete lucro. Não muda o custo por omissão (0,1 %),
nenhuma porta nem preset existente; o teste ao vivo é só PAPER e não pode colocar ordens reais.

Contexto: `pesquisa-htf-custos-2026-10-10.md` — candidatos 4 h de tendência tiveram R/op líquido positivo mas **sem significância** depois do FDR
(27 testes no total). É uma pista gerada pelos dados; precisa de dados novos.

## 1. Candidatos (5, fixos — exactamente os mesmos parâmetros de 2026-10-10)
| id | regra (velas de 4 h) |
|---|---|
| A3 | Donchian 20: fecho > máximo das 20 velas anteriores → compra; < mínimo → venda |
| A4 | Donchian 55 |
| B2 | cruzamento EMA 20/50 (`emaCross`) |
| C2 | A3 só se ATR14/fecho > mediana das 200 velas anteriores |
| D2 | sinal do retorno das últimas 90 velas (momentum de série temporal) |

Execução (motor `runCandleBacktest`): sinal na vela fechada → entrada na abertura seguinte; compra e venda; uma posição por símbolo e candidato;
stop 3 × ATR14; alvo 2R (6 ATR); saída por tempo 60 velas (10 d); sinais com stop > 8 % do preço descartados; 250 velas de aquecimento.

## 2. Custos
- **Primário: 0,13 % ida e volta** = taker 0,055 % × 2 (tabela oficial Bybit VIP 0) + **derrapagem SUPOSTA** 0,01 % por lado (igual ao `ASSUMED_SLIPPAGE_PER_SIDE` do bot; não medida).
- Robustez: 0,17 % (derrapagem suposta 0,03 %/lado). Funding ignorado (limitação).

## 3. Backtest em dados reais (proxy do projecto) — janela e independência
- **Não existe janela histórica 4 h Bybit linear que não tenha sido usada**: 2021-02→2023-12 e 2023-12→2026-10 já foram vistos para estes candidatos (e antes de 2021 quase não há pares). Por isso o backtest usa **instrumentos novos** na mesma época:
- Universo B (20 símbolos que NÃO estavam nos 30 anteriores): 1000PEPE WIF SHIB1000 1000BONK TIA SEI WLD FET ORDI LDO IMX GALA SAND MANA AXS EOS KAS MKR ONDO ENA (todos `…USDT`).
- Janela de avaliação: **2024-06-01 → última vela 4 h fechada no download**. Um símbolo entra se tiver velas desde ≤ 2024-04-20 (aquecimento) até ao fim; exclusões reportadas.
- **Limitação honesta**: a época sobrepõe-se à dos estudos anteriores e as criptos são muito correlacionadas → isto **não** é evidência independente. É uma verificação de generalização a outros instrumentos. A única evidência realmente nova é o teste ao vivo (secção 5).

## 4. Regras de decisão do backtest (todas obrigatórias)
Série diária (UTC, dia de saída) = soma do R líquido das operações fechadas nesse dia / nº de símbolos; p unilateral (`expectancyPValue`).
1. BH q = 0,10 sobre os **5** p-values; passa e média diária > 0.
2. ≥ 60 % dos blocos de 30 d (a contar do fim) com média > 0 **e** último bloco > 0.
3. ≥ 60 % dos símbolos com R médio > 0 e R/op médio > 0 a 0,13 %.
4. R/op médio > 0 também a 0,17 %.
Mesmo que passe: **nada vai para REAL**; serve só para decidir se vale a pena continuar.

## 5. Teste PAPER ao vivo (forward test) — protocolo fixado agora
- Os 5 candidatos correm em PAPER sobre os **30 símbolos do estudo anterior** (BTC ETH SOL XRP DOGE BNB ADA AVAX LINK LTC DOT TRX BCH ATOM NEAR APT ARB OP SUI INJ FIL ETC UNI AAVE XLM HBAR ICP ALGO RUNE CRV), velas 4 h reais da Bybit, mesmas regras e custo primário 0,13 %.
- Início: a primeira vela 4 h que **abre depois** de o teste ser iniciado no servidor (data gravada em Redis e mostrada no painel). Só contam entradas com sinal em velas fechadas a partir do início. Sem reinícios: o início fica fixo.
- **Duração: 90 dias** a partir do início. Sem decisões antes (sem paragem antecipada; o painel mostra números intermédios rotulados "sem evidência ainda").
- Cada operação é gravada (Upstash, arm store) com a hora em que foi vista pela primeira vez.
- **Critério de sucesso ao dia 90 (por candidato):** ≥ 50 operações fechadas; R/op líquido médio > 0 a 0,13 %; p unilateral da série diária com BH (q = 0,10, m = 5) ≤ 0,10.
- Se nenhum passar: o registo fica como "sem evidência" e não se faz nada. Se algum passar: só então se discute (outro PR) suportar a porta em 4 h — nunca REAL automático, e a porta não é afrouxada.
