// Advance all RUNNING cloud arm jobs (cron or external scheduler).
// Hobby: vercel.json may only fire daily — use external cron (e.g. cron-job.org) every 1–5 min,
// or rely on lazy advance when the user opens /bybit (GET jobs).
// Optional CRON_SECRET: require ?secret= or Authorization: Bearer.

import { advanceCloudArmJob, publicCloudArmJob, CLOUD_ARM_WARMUP } from "./_lib/nl-cloud.mjs";
import { listArmJobs, saveArmJob, armStoreInfo } from "./_lib/arm-store.js";
import { fetchArmCandleHistory } from "./_lib/arm-klines.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
}

function authorized(req) {
  const secret = process.env.CRON_SECRET || process.env.ARM_CRON_SECRET;
  if (!secret) return true; // open tick when no secret configured (Hobby bootstrap)
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams.get("secret");
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const vercelCron = req.headers["x-vercel-cron"];
  if (vercelCron) return true;
  return q === secret || bearer === secret;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!authorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const store = armStoreInfo();
  const jobs = await listArmJobs("");
  const running = jobs.filter((j) => j.status === "RUNNING");
  const results = [];
  for (const job of running) {
    try {
      const candles = await fetchArmCandleHistory(job.symbol, job.granularity, CLOUD_ARM_WARMUP);
      const next = advanceCloudArmJob(job, candles, Date.now());
      await saveArmJob(next);
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
    jobs: running.length ? undefined : [],
    hint:
      store.backend === "memory"
        ? "Configure UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN for durable multi-instance jobs."
        : "Lazy advance also runs on GET /api/bybit-arm-jobs when the user returns.",
  });
}
