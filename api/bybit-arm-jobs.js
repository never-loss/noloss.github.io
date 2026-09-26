// Cloud timed PAPER arm jobs — create / list / status / cancel.
// PAPER only (v1). Advance is lazy on read (deterministic replay from Bybit klines).

import {
  createCloudArmJob,
  advanceCloudArmJob,
  cancelCloudArmJob,
  publicCloudArmJob,
  CLOUD_ARM_WARMUP,
} from "./_lib/nl-cloud.mjs";
import { saveArmJob, getArmJob, listArmJobs, armStoreInfo } from "./_lib/arm-store.js";
import { fetchArmCandleHistory } from "./_lib/arm-klines.js";

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

async function advanceAndSave(job) {
  const candles = await fetchArmCandleHistory(job.symbol, job.granularity, CLOUD_ARM_WARMUP);
  const next = advanceCloudArmJob(job, candles, Date.now());
  await saveArmJob(next);
  return next;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const store = armStoreInfo();
  const url = new URL(req.url, "http://localhost");

  try {
    if (req.method === "POST") {
      const body = await readBody(req);
      // Force PAPER — ignore any mode field from client.
      const job = createCloudArmJob({
        symbol: body.symbol,
        strategyPreset: body.strategyPreset || body.strategy,
        stake: body.stake,
        leverage: body.leverage ?? 1,
        granularity: body.granularity ?? 300,
        durationMinutes: body.durationMinutes ?? body.minutes,
        clientId: body.clientId,
      });
      let advanced;
      try {
        advanced = await advanceAndSave(job);
      } catch (e) {
        // Persist even if first kline fetch fails — tick/status can retry.
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
