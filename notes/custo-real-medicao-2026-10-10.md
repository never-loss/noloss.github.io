# Medição do custo real por operação (2026-10-10)

Só medição e rótulos. **Não muda** entradas, saídas, R, a porta, o custo por omissão (0,1 %) nem o PAPER por omissão. Nada promete lucro.

## O que é medido

| onde | o quê | origem | rótulo na UI |
|---|---|---|---|
| PAPER (browser e arm na nuvem) | custo **modelado** por operação: taxas (taker 0,055 % na entrada; saída taker 0,055 % em stop/tempo, maker 0,02 % no alvo) + derrapagem **SUPOSTA** de 0,01 % por lado a mercado | `src/core/trade-cost.ts`, evento `trade_closed.fill` | "Custo modelado (taxas oficiais + derrapagem SUPOSTA, não medida): X % · n = N · assumido 0,10 %" |
| REAL (arm na nuvem) | taxa paga (`execFee`) e derrapagem (preço médio executado vs preço do sinal) por ordem | `GET /v5/execution/list` (assinado) após `order/create`; guardado em `job.realFills` (Redis/arm store, máx. 60) | "Custo real médio: X % por operação (taxas + derrapagem) · n = N operações · assumido 0,10 %" |
| REAL (caminho manual `/api/bybit-order`) | idem | a resposta passa a trazer o campo extra `nlExecution` (ou `nlExecutionError`); o painel guarda em `localStorage` (`nl.bybit.realFills.v1`, máx. 100) | idem |

Constantes configuráveis: `BYBIT_TAKER_FEE = 0.00055`, `BYBIT_MAKER_FEE = 0.0002` (VIP 0, Help Center Bybit "Trading Fee Structure"), `ASSUMED_SLIPPAGE_PER_SIDE = 0.0001` (**suposição**, não medida) e `fillModel` opcional em `CandlePaperConfig`. A conta real pode ter outro escalão: o custo REAL medido é o que conta.

Campos por operação PAPER: preço de entrada/saída simulados e com derrapagem suposta, preço do stop, fecho da vela de saída, `gapVsStopFrac` (saída pior que o stop por salto), taxas, derrapagem suposta, custo modelado em fração e em R, e o custo assumido (0,1 %) em fração e em R.

Campos por execução REAL: `signalPrice`, `avgPrice` (média ponderada das execuções `Trade`; ignora Funding/ADL), `qty`, `execFee` (negativo = rebate), `feeFrac`, `slipFrac` (positivo = pior para nós), `costFrac`, nº de execuções e quantas foram maker.

## Salvaguardas
- A leitura é **depois** da ordem aceite, só leitura (GET), com repetições limitadas (3 tentativas, 400 ms) e nunca lança. Em falha: o arm só acrescenta uma linha ao log do job ("REAL custo não medido…") e o caminho manual devolve exactamente o corpo da Bybit (+ `nlExecutionError`). A ordem, os markers de de-dupe e o estado `realOpenQty/Side` não são tocados.
- Sem `signalPrice` ou sem chaves não há nenhuma chamada extra.
- A UI só mostra cada linha com n > 0; escondidas por omissão.

## Limitações honestas
- O "preço do sinal" é a entrada/saída da simulação (abertura/stop/alvo da vela). A derrapagem real inclui por isso também a **latência** entre a vela e o tick da nuvem, não só o impacto de mercado.
- Fecho por flatten de cancelamento não é medido (não tem preço de sinal).
- Funding não entra.
- Antes de haver trades REAIS (n = 0) só a linha modelada (PAPER) aparece, e é uma suposição rotulada como tal.
