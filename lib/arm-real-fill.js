// Cloud arm REAL: mede o custo real (taxa + derrapagem vs preço do sinal) da ordem acabada de aceitar e guarda no job.
// Só leitura/medição: qualquer falha só acrescenta uma linha ao log do job e NUNCA altera nem bloqueia a ordem já colocada.

import { addRealFill } from "./nl-cloud.mjs";
import { measureOrderFill } from "./bybit-place.js";

function appendEvent(job, text) {
  const events = [...(job.events || []), { type: "text", at: Date.now(), text }];
  return { ...job, events: events.length > 80 ? events.slice(-80) : events };
}

/**
 * @param {object} job job do arm (REAL)
 * @param {{ ok: boolean, body: any }} res devolução de placeLinearMarketOrder
 * @param {{ side: "BUY"|"SELL", price?: number, key: string, action: "open"|"close", orderLinkId?: string }} ctx
 * @returns {Promise<object>} job (com realFills e uma linha de log) — nunca lança
 */
export async function recordRealFill(job, res, ctx, env = process.env, fetchImpl = fetch, tools = {}) {
  try {
    const m = await measureOrderFill(
      res,
      { symbol: job.symbol, side: ctx.side, signalPrice: ctx.price, key: ctx.key, action: ctx.action, orderLinkId: ctx.orderLinkId, at: Date.now() },
      env,
      fetchImpl,
      tools,
    );
    if (!m.ok) return appendEvent(job, `REAL custo não medido (${ctx.action}): ${m.error}`);
    const f = m.fill;
    return appendEvent(
      addRealFill(job, f),
      `REAL custo ${ctx.action}: taxa ${(f.feeFrac * 100).toFixed(3)}% + derrapagem ${(f.slipFrac * 100).toFixed(3)}% vs sinal`,
    );
  } catch (e) {
    return appendEvent(job, `REAL custo não medido (${ctx.action}): ${e && e.message ? e.message : "erro"}`);
  }
}
