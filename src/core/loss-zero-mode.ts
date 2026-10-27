/**
 * Modo do cartão "Loss zero" em /bybit: "padrão" (preset loss_zero, porta 1000 OOS) ou "Giro Diário"
 * (preset giro_diario, porta PRÓPRIA 100 OOS com p < 0,01, 5m por omissão / 1m opcional, para no dia a +3R / −3R).
 * Só mapeia o modo para um preset JÁ existente — não cria nem altera portas, presets ou custo.
 */
import { oosMinForPreset, GIRO_DIARIO_TARGET_R, GIRO_DIARIO_LOSS_R, GIRO_DIARIO_DISCLAIMER } from "./strategies.ts";
import { GATE_ALPHA } from "./gate.ts";

export type LossZeroCardMode = "padrao" | "giro_diario";

export interface LossZeroModeSpec {
  mode: LossZeroCardMode;
  preset: "loss_zero" | "giro_diario";
  label: string;
  minOos: number;
  alpha: number;
  granularities: readonly number[] | null;
  dailyTargetR: number | null;
  dailyLossR: number | null;
  chips: string[];
  disclaimer: string | null;
}

export function lossZeroModeSpec(mode: LossZeroCardMode): LossZeroModeSpec {
  if (mode === "giro_diario") {
    return {
      mode, preset: "giro_diario", label: "Giro Diário",
      minOos: oosMinForPreset("giro_diario"), alpha: GATE_ALPHA, granularities: [300, 60],
      dailyTargetR: GIRO_DIARIO_TARGET_R, dailyLossR: GIRO_DIARIO_LOSS_R,
      chips: ["5m/1m", "porta 100 · p<0,01", "meta +" + GIRO_DIARIO_TARGET_R + "R", "limite −" + GIRO_DIARIO_LOSS_R + "R"],
      disclaimer: GIRO_DIARIO_DISCLAIMER,
    };
  }
  return {
    mode: "padrao", preset: "loss_zero", label: "Loss zero padrão",
    minOos: oosMinForPreset("loss_zero"), alpha: GATE_ALPHA, granularities: null,
    dailyTargetR: null, dailyLossR: null, chips: ["porta " + oosMinForPreset("loss_zero")], disclaimer: null,
  };
}

/** Modo do cartão a partir do preset escolhido (null se o preset não pertence ao cartão Loss zero). */
export function lossZeroModeForPreset(preset: string | null | undefined): LossZeroCardMode | null {
  if (preset === "loss_zero") return "padrao";
  if (preset === "giro_diario") return "giro_diario";
  return null;
}

/** Mudar de modo só com tudo parado (STOP), como a mudança de estratégia. */
export function canSwitchLossZeroMode(s: { running?: boolean; paused?: boolean; cloudRunning?: boolean; cloudScheduled?: boolean }): boolean {
  return !(s.running || s.paused || s.cloudRunning || s.cloudScheduled);
}

export interface GiroDailyProgress {
  netR: number;
  targetR: number;
  lossR: number;
  targetPct: number;
  lossPct: number;
  stop: "daily_target" | "daily_loss_limit" | null;
  stopText: string | null;
}

export const GIRO_STOP_LABELS = {
  daily_target: "Meta +" + GIRO_DIARIO_TARGET_R + "R atingida",
  daily_loss_limit: "Limite de perda −" + GIRO_DIARIO_LOSS_R + "R atingido",
} as const;

/** Progresso do dia para a meta (+3R) e o limite (−3R); o que vier primeiro para (mesma regra de candle-paper). */
export function giroDailyProgress(netR: number, stopReason?: string | null): GiroDailyProgress {
  const r = Number.isFinite(netR) ? netR : 0;
  const t = GIRO_DIARIO_TARGET_R, l = GIRO_DIARIO_LOSS_R;
  const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));
  let stop: GiroDailyProgress["stop"] = null;
  if (stopReason === "daily_target" || stopReason === "daily_loss_limit") stop = stopReason;
  else if (r <= -l) stop = "daily_loss_limit";
  else if (r >= t) stop = "daily_target";
  return {
    netR: r, targetR: t, lossR: l,
    targetPct: clamp((Math.max(0, r) / t) * 100),
    lossPct: clamp((Math.max(0, -r) / l) * 100),
    stop, stopText: stop ? GIRO_STOP_LABELS[stop] : null,
  };
}
