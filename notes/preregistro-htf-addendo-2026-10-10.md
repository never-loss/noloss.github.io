# Adendo ao pré-registo: confirmação em dados anteriores (4 h) — escrito ANTES de descarregar esses dados

Contexto: o estudo principal (`preregistro-htf-2026-10-10.md`, 17 testes) foi corrido e **nenhum candidato passou** as regras. Os resultados mostraram, porém,
que os candidatos em 4 h (A3, A4, B2, C2, D2) tinham R bruto e líquido médio positivos (≈ +0,06 a +0,16 R por operação, a 0,11 %), sem significância depois do FDR.
Isto é uma **hipótese gerada pelos dados** (selecção a posteriori), por isso só pode ser testada em dados que não participaram na selecção.

## Teste de confirmação (exploratório, rotulado como tal)
- Dados: klines **reais** 4 h da Bybit linear via proxy, **anteriores** à janela do estudo principal (que começava em 2023-12-06).
- Símbolos: os do mesmo universo de 30 que tenham velas 4 h desde ≤ 2021-03-01 (nº e exclusões reportados). Janela de avaliação: de (início comum + 250 velas) até 2023-12-05 (exclusive).
- 5 candidatos, exactamente os mesmos parâmetros do estudo principal: A3, A4, B2, C2, D2. Mesma execução (stop 3 ATR, alvo 2R, 60 velas, stop ≤ 8 %), custo primário 0,11 %, mesma série diária.
- Divisão: descoberta = 2/3 iniciais, confirmação = 1/3 final (só para manter o mesmo procedimento; aqui toda a janela é fora da amostra da selecção).
- Regras 1–5 do pré-registo principal, aplicadas sem alterações, com m = 5 neste teste. **Contagem total de testes do estudo (principal + adendo) = 17 + 5 = 22**; o p-value ajustado do adendo é reportado também com m = 22 (BH sobre os 22 p-values de descoberta).
- Se nenhum passar: não se entrega estratégia. Se algum passar, ainda teria de passar pela porta e exigiria suporte de porta a 4 h (hoje o livro/porta e a cache são só 5 min) — seria outro PR, não este.
