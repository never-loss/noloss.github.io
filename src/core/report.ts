// Texto legível para os eventos e o resumo de uma sessão de paper trading.
import type { DigitContract } from "./stats.ts";
import type { PaperEvent, PaperSummary, StopReason } from "./paper.ts";

const REASONS: Record<StopReason, string> = {
  manual: "parada manualmente",
  max_loss: "perda máxima atingida",
  max_trades: "número máximo de operações atingido",
  max_duration: "duração máxima atingida",
  max_consecutive_losses: "perdas seguidas máximas atingidas",
  max_drawdown: "queda máxima atingida",
};

export function describeContract(c: DigitContract): string {
  switch (c.type) {
    case "match":
      return `match ${c.digit}`;
    case "differs":
      return `differs ${c.digit}`;
    case "over":
      return `over ${c.barrier}`;
    case "under":
      return `under ${c.barrier}`;
    case "even":
      return "par";
    case "odd":
      return "ímpar";
  }
}

const time = (ms: number): string => new Date(ms).toISOString().slice(11, 19);
const signed = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

export function formatEvent(e: PaperEvent): string {
  switch (e.type) {
    case "started":
      return `${time(e.at)}  PLAY  sessão iniciada`;
    case "paused":
      return `${time(e.at)}  PAUSE  novas operações bloqueadas`;
    case "stopped":
      return `${time(e.at)}  STOP  ${REASONS[e.reason]}`;
    case "trade_opened":
      return `${time(e.at)}  ABRE   ${describeContract(e.contract)} | stake ${e.stake} | ${e.rule}`;
    case "trade_closed":
      return `${time(e.at)}  FECHA  dígito ${e.digit} -> ${e.won ? "GANHOU" : "PERDEU"} ${signed(e.pnl)} | total ${signed(e.totalPnl)}`;
  }
}

export function formatSummary(s: PaperSummary): string {
  const m = s.metrics;
  const lines = [
    "=== RESUMO (paper trading, dados reais, sem dinheiro) ===",
    `Estado: ${s.status}${s.stopReason ? ` (${REASONS[s.stopReason]})` : ""}`,
    `Operações: ${s.closed} fechadas de ${s.opened} abertas | stake fixa ${s.stake}`,
  ];
  if (s.closed === 0) {
    lines.push("Sem operações: o bot ficou em NO TRADE (nenhuma condição da regra se verificou).");
  } else {
    lines.push(`Wins: ${m.wins} | Perdas: ${m.losses} | taxa ${(m.winRate * 100).toFixed(1)}%`);
    lines.push(`Resultado simulado: ${signed(s.totalPnl)} | pior queda: ${s.maxDrawdown.toFixed(2)} | maior sequência de perdas: ${m.longestLosingStreak}`);
  }
  lines.push("Aviso: poucas operações não provam nada. Resultado simulado não garante resultado futuro.");
  return lines.join("\n");
                     }
