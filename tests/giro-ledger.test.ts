import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gateSetup, GATE_PRESET_IDS } from "../src/core/gate-service.ts";
import { ledgerAsOf } from "../src/core/ledger-gate-controller.ts";
import { GIRO_DIARIO_SELECTION_WINDOW } from "../src/core/strategies.ts";
import { cloudArmLedgerEligible } from "../src/core/cloud-arm.ts";
import type { GateLedger, LedgerFold } from "../src/core/gate-ledger.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Giro Diário: entra no livro-razão (5m), porta inalterada (PRELIMINARY = 100 OOS, custo 0,1 %)", () => {
  assert.ok((GATE_PRESET_IDS as readonly string[]).includes("giro_diario"));
  const s = gateSetup("giro_diario");
  assert.equal(s.minLabel, "PRELIMINARY");
  assert.equal(s.params.costFraction, 0.001);
  assert.equal(s.params.slAtr, 1.2);
  assert.equal(s.params.tpR, 1.5);
  assert.equal(s.params.maxBars, 12);
  assert.equal(s.strategies.length, 4);
  assert.ok(cloudArmLedgerEligible("giro_diario", 300));
  assert.ok(!cloudArmLedgerEligible("giro_diario", 60)); // 1m continua no walk-forward local
  for (const id of ["lucro_rapido", "loss_zero", "blitz_zero"] as const) assert.equal(gateSetup(id).exclude, null);
});

test("Giro Diário: janela de selecção bate com a corrida registada (dias 60→30) e os blocos que a tocam são excluídos", () => {
  const sel = JSON.parse(readFileSync(join(root, "notes/data/giro-select-2026-10-27.json"), "utf8"));
  const at = Date.parse(sel.at) / 1000;
  const w = GIRO_DIARIO_SELECTION_WINDOW;
  assert.ok(w.start <= at - 60 * 86400, "início cobre o início da selecção");
  assert.ok(w.end >= at - 30 * 86400 + 12 * 300, "fim cobre o fim da selecção + operações abertas");
  assert.deepEqual(gateSetup("giro_diario").exclude, w);
  const B = 150000;
  const fold = (start: number): LedgerFold => ({ block: start / B, start, end: start + B, nCandles: 500, chosen: "x", trainTrades: 1, trainNetR: 0, n: 1, sumR: 1, sumR2: 1, wins: 1, r: [1] } as unknown as LedgerFold);
  const starts: number[] = [];
  for (let t = Math.floor((w.start - 5 * B) / B) * B; t < w.end + 5 * B; t += B) starts.push(t);
  const L = { version: 1, paramsHash: "h", params: {} as never, folds: starts.map(fold) } as GateLedger;
  const kept = ledgerAsOf(L, Number.POSITIVE_INFINITY, 1000, w).folds;
  assert.ok(kept.length > 0 && kept.length < L.folds.length);
  for (const f of kept) assert.ok(f.end <= w.start || f.start >= w.end, "nenhum bloco mantido toca a janela");
  assert.equal(ledgerAsOf(L, Number.POSITIVE_INFINITY, 1000).folds.length, L.folds.length); // sem exclusão → igual a antes
});
