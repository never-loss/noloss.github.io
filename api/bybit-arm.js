// Cloud timed PAPER|REAL arm — single Hobby-safe endpoint (create/list/status/cancel/tick).
// POST body → create | GET ?id= / ?clientId= → status/list | DELETE ?id= → cancel | GET/POST ?tick=1 → tick all.
// REAL: after advance, pendingRealMirrors → placeLinearMarketOrder (de-duped via realAppliedEventKeys).
// Optional CRON_SECRET for tick. Upstash Redis when UPSTASH_* set.

import {
  createCloudArmJob,
  advanceCloudArmJob,
  cancelCloudArmJob,
  publicCloudArmJob,
  pendingRealMirrors,
  markRealMirrorsApplied,
  CLOUD_ARM_WARMUP,
} from "../lib/nl-cloud.mjs";
import { saveArmJob, getArmJob, listArmJobs, armStoreInfo } from "../lib/arm-store.js";
import { fetchArmCandleHistory } from "../lib/arm-klines.js";
import {
  hasBybitKeys,
  placeLinearMarketOrder,
  quantityFromFixedStake,
} from "../lib/bybit-place.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") {
      resolve(req.body);
      return;
    }
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error("body_too_large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function tickAuthorized(req) {
  const secret = process.env.CRON_SECRET || process.env.ARM_CRON_SECRET;
  if (!secret) return true;
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams.get("secret");
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (req.headers["x-vercel-cron"]) return true;
  return q === secret || bearer === secret;
}

function appendJobEvent(job, text, type = "text") {
  const events = [
    ...(job.events || []),
    { type, at: Date.now(), text },
  ];
  const max = 80;
  return { ...job, events: events.length > max ? events.slice(-max) : events };
}

/**
 * Place Bybit orders for new paper trade_opened/trade_closed since last mirror markers.
 * Marks keys applied even on failure to avoid duplicate spam on re-tick.
 */
async function mirrorRealIfNeeded(jobBefore, jobAfter) {
  if (!jobAfter || jobAfter.mode !== "REAL") return jobAfter;
  const pending = pendingRealMirrors(jobBefore, jobAfter);
  if (!pending.length) {
    // Still try flatten if cancel requested an open position close.
    const flat = await maybeFlattenReal(jobAfter);
    if (flat !== jobAfter) await saveArmJob(flat);
    return flat;
  }
  if (!hasBybitKeys()) {
    let j = appendJobEvent(
      jobAfter,
      "REAL mirror skipped: BYBIT_API_KEY/SECRET em falta no servidor",
      "text",
    );
    j = markRealMirrorsApplied(j, pending.map((p) => p.key));
    await saveArmJob(j);
    return j;
  }

  let j = jobAfter;
  let openQty = j.realOpenQty;
  let openSide = j.realOpenSide;

  for (const m of pending) {
    try {
      if (m.action === "open") {
        if (m.entry == null || !Number.isFinite(Number(m.entry))) {
          j = appendJobEvent(j, `REAL mirror open FALHA: entry em falta (${m.key})`, "text");
          j = markRealMirrorsApplied(j, [m.key], { qty: openQty, side: openSide });
          continue;
        }
        const qty = quantityFromFixedStake(j.stake, m.entry);
        const res = await placeLinearMarketOrder({
          symbol: j.symbol,
          side: m.side,
          quantity: qty,
          orderLinkId: `nl_${j.id}_${m.key}`.slice(0, 36),
        });
        if (!res.ok) {
          j = appendJobEvent(
            j,
            `REAL Bybit FALHA open ${m.side}: ${res.error || res.status}`,
            "text",
          );
          j = markRealMirrorsApplied(j, [m.key], { qty: openQty, side: openSide });
        } else {
          openQty = qty;
          openSide = m.side;
          j = appendJobEvent(j, `REAL Bybit MARKET ${m.side} qty=${qty}`, "text");
          j = markRealMirrorsApplied(j, [m.key], { qty: openQty, side: openSide });
        }
      } else {
        // close
        const qty = openQty;
        const side = m.side;
        if (!qty) {
          j = appendJobEvent(j, `REAL mirror close skip: sem qty aberta (${m.key})`, "text");
          j = markRealMirrorsApplied(j, [m.key], { qty: null, side: null });
          continue;
        }
        const res = await placeLinearMarketOrder({
          symbol: j.symbol,
          side,
          quantity: qty,
          reduceOnly: true,
          orderLinkId: `nl_${j.id}_${m.key}`.slice(0, 36),
        });
        if (!res.ok) {
          j = appendJobEvent(
            j,
            `REAL Bybit FALHA close ${side}: ${res.error || res.status}`,
            "text",
          );
          // Keep open markers so cancel flatten can retry; still mark event key to avoid re-fire.
          j = markRealMirrorsApplied(j, [m.key], { qty: openQty, side: openSide });
        } else {
          openQty = null;
          openSide = null;
          j = appendJobEvent(j, `REAL Bybit FECHA ${side} qty=${qty} (reduceOnly)`, "text");
          j = markRealMirrorsApplied(j, [m.key], { qty: null, side: null });
        }
      }
    } catch (e) {
      j = appendJobEvent(
        j,
        `REAL mirror erro: ${e && e.message ? e.message : String(e)}`,
        "text",
      );
      j = markRealMirrorsApplied(j, [m.key], { qty: openQty, side: openSide });
    }
  }

  j = await maybeFlattenReal(j);
  await saveArmJob(j);
  return j;
}

/** Best-effort reduceOnly close when cancel left needsRealFlatten. */
async function maybeFlattenReal(job) {
  if (!job || job.mode !== "REAL" || !job.needsRealFlatten) return job;
  if (!(job.realOpenQty && job.realOpenSide)) {
    return { ...job, needsRealFlatten: false };
  }
  if (!hasBybitKeys()) {
    return appendJobEvent(job, "REAL flatten skip: keys_missing", "text");
  }
  const closeSide = job.realOpenSide === "BUY" ? "SELL" : "BUY";
  const qty = job.realOpenQty;
  try {
    const res = await placeLinearMarketOrder({
      symbol: job.symbol,
      side: closeSide,
      quantity: qty,
      reduceOnly: true,
      orderLinkId: `nl_${job.id}_flat`.slice(0, 36),
    });
    if (!res.ok) {
      return appendJobEvent(
        job,
        `REAL flatten FALHA ${closeSide}: ${res.error || res.status}`,
        "text",
      );
    }
    return {
      ...appendJobEvent(job, `REAL flatten OK ${closeSide} qty=${qty}`, "text"),
      realOpenQty: null,
      realOpenSide: null,
      needsRealFlatten: false,
    };
  } catch (e) {
    return appendJobEvent(
      job,
      `REAL flatten erro: ${e && e.message ? e.message : String(e)}`,
      "text",
    );
  }
}

async function advanceAndSave(job) {
  const before = job;
  const candles = await fetchArmCandleHistory(job.symbol, job.granularity, CLOUD_ARM_WARMUP);
  let next = advanceCloudArmJob(job, candles, Date.now());
  await saveArmJob(next);
  if (next.mode === "REAL") {
    next = await mirrorRealIfNeeded(before, next);
  }
  return next;
}

async function handleTick(req, res, store) {
  if (!tickAuthorized(req)) return res.status(401).json({ error: "unauthorized", store });
  const jobs = await listArmJobs("");
  const running = jobs.filter((j) => j.status === "RUNNING");
  const results = [];
  for (const job of running) {
    try {
      const next = await advanceAndSave(job);
      results.push({
        id: next.id,
        status: next.status,
        stopReason: next.stopReason,
        mode: next.mode,
        ok: true,
      });
    } catch (e) {
      results.push({ id: job.id, ok: false, error: e.message || String(e) });
    }
  }
  return res.status(200).json({
    ok: true,
    store,
    ticked: results.length,
    results,
    hint:
      store.backend === "memory"
        ? "Configure UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN for durable multi-instance jobs."
        : "Lazy advance also runs on GET when the user returns. Cron ticks advance with page closed.",
  });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const store = armStoreInfo();
  const url = new URL(req.url, "http://localhost");
  const isTick = url.searchParams.get("tick") === "1" || url.pathname.endsWith("/tick");

  try {
    if (isTick && (req.method === "GET" || req.method === "POST")) {
      return handleTick(req, res, store);
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const modeRaw = String(body.mode || "PAPER").trim().toUpperCase();
      const mode = modeRaw === "REAL" ? "REAL" : modeRaw === "PAPER" ? "PAPER" : null;
      if (!mode) {
        return res.status(400).json({ error: "mode inválido (PAPER|REAL)", store });
      }
      if (mode === "REAL") {
        if (!hasBybitKeys()) {
          return res.status(503).json({
            error: "keys_missing",
            error_description:
              "Modo REAL na nuvem indisponível: configura BYBIT_API_KEY e BYBIT_API_SECRET no servidor (Vercel env).",
            store,
          });
        }
        if (body.confirmReal !== true) {
          return res.status(400).json({
            error: "confirm_real_required",
            error_description: "REAL na nuvem exige confirmReal: true (confirmação UI).",
            store,
          });
        }
      }
      const job = createCloudArmJob({
        symbol: body.symbol,
        strategyPreset: body.strategyPreset || body.strategy,
        stake: body.stake,
        leverage: body.leverage ?? 1,
        granularity: body.granularity ?? 300,
        durationMinutes: body.durationMinutes ?? body.minutes,
        clientId: body.clientId,
        mode,
      });
      let advanced;
      try {
        advanced = await advanceAndSave(job);
      } catch (e) {
        await saveArmJob(job);
        advanced = job;
        return res.status(201).json({
          ok: true,
          job: publicCloudArmJob(advanced),
          store,
          warning: "arm_created_klines_pending:" + (e.message || String(e)),
        });
      }
      return res.status(201).json({ ok: true, job: publicCloudArmJob(advanced), store });
    }

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      const clientId = url.searchParams.get("clientId") || "";
      if (id) {
        let job = await getArmJob(id);
        if (!job) return res.status(404).json({ error: "not_found", store });
        if (clientId && job.clientId !== clientId) {
          return res.status(404).json({ error: "not_found", store });
        }
        if (job.status === "RUNNING") {
          try {
            job = await advanceAndSave(job);
          } catch (e) {
            return res.status(200).json({
              ok: true,
              job: publicCloudArmJob(job),
              store,
              warning: "advance_failed:" + (e.message || String(e)),
            });
          }
        }
        return res.status(200).json({ ok: true, job: publicCloudArmJob(job), store });
      }
      if (!clientId) {
        return res.status(400).json({ error: "clientId_required", store });
      }
      const jobs = await listArmJobs(clientId);
      const out = [];
      for (const j of jobs.slice(0, 20)) {
        let job = j;
        if (job.status === "RUNNING") {
          try {
            job = await advanceAndSave(job);
          } catch (_e) {
            /* keep stale */
          }
        }
        out.push(publicCloudArmJob(job));
      }
      return res.status(200).json({ ok: true, jobs: out, store });
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      const clientId = url.searchParams.get("clientId") || "";
      if (!id) return res.status(400).json({ error: "id_required", store });
      let job = await getArmJob(id);
      if (!job) return res.status(404).json({ error: "not_found", store });
      if (clientId && job.clientId !== clientId) {
        return res.status(404).json({ error: "not_found", store });
      }
      job = cancelCloudArmJob(job, Date.now());
      if (job.mode === "REAL" && job.needsRealFlatten) {
        job = await maybeFlattenReal(job);
      }
      await saveArmJob(job);
      return res.status(200).json({ ok: true, job: publicCloudArmJob(job), store });
    }

    res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const status = /inválid|invalid|mínima|máxima|desconhecido/i.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg, store });
  }
}
