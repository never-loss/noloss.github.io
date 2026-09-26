// Cloud timed PAPER arm — single Hobby-safe endpoint (create/list/status/cancel/tick).
// POST body → create | GET ?id= / ?clientId= → status/list | DELETE ?id= → cancel | GET/POST ?tick=1 → tick all.
// PAPER only. Lazy advance on read. Optional CRON_SECRET for tick.

import {
  createCloudArmJob,
  advanceCloudArmJob,
  cancelCloudArmJob,
  publicCloudArmJob,
  CLOUD_ARM_WARMUP,
} from "../lib/nl-cloud.mjs";
import { saveArmJob, getArmJob, listArmJobs, armStoreInfo } from "../lib/arm-store.js";
import { fetchArmCandleHistory } from "../lib/arm-klines.js";

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

async function advanceAndSave(job) {
  const candles = await fetchArmCandleHistory(job.symbol, job.granularity, CLOUD_ARM_WARMUP);
  const next = advanceCloudArmJob(job, candles, Date.now());
  await saveArmJob(next);
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
      results.push({ id: next.id, status: next.status, stopReason: next.stopReason, ok: true });
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
        : "Lazy advance also runs on GET when the user returns.",
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
