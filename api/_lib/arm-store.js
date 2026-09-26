// Durable store for cloud arm jobs.
// Prefer Upstash Redis REST (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
// Without those env vars: in-memory Map (ephemeral — fine for tests / single warm instance).
// File storage is NOT used (serverless multi-instance unsafe).

const PREFIX = "nl:arm:";
const INDEX = "nl:arm:index";
const memory = new Map();

function redisConfigured(env = process.env) {
  return !!(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

export function armStoreInfo(env = process.env) {
  if (redisConfigured(env)) {
    return { backend: "upstash", durable: true };
  }
  return {
    backend: "memory",
    durable: false,
    warning:
      "Sem UPSTASH_REDIS_REST_URL/TOKEN — jobs só vivem na instância quente. Para produção na Vercel, configura Upstash Redis (free tier).",
  };
}

async function redisCommand(args, env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("upstash_not_configured");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`upstash_http_${res.status}:${data.error || res.statusText}`);
  }
  if (data.error) throw new Error(`upstash:${data.error}`);
  return data.result;
}

export async function saveArmJob(job, env = process.env) {
  const key = PREFIX + job.id;
  const payload = JSON.stringify(job);
  if (redisConfigured(env)) {
    // TTL: endsAt + 7d keep for history after stop
    const ttlSec = Math.max(3600, Math.ceil((job.endsAt + 7 * 86400000 - Date.now()) / 1000));
    await redisCommand(["SET", key, payload, "EX", String(ttlSec)], env);
    await redisCommand(["SADD", INDEX, job.id], env);
    return;
  }
  memory.set(job.id, job);
}

export async function getArmJob(id, env = process.env) {
  if (redisConfigured(env)) {
    const raw = await redisCommand(["GET", PREFIX + id], env);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  return memory.get(id) || null;
}

export async function listArmJobs(clientId, env = process.env) {
  let ids = [];
  if (redisConfigured(env)) {
    ids = (await redisCommand(["SMEMBERS", INDEX], env)) || [];
  } else {
    ids = [...memory.keys()];
  }
  const out = [];
  for (const id of ids) {
    const job = await getArmJob(id, env);
    if (!job) continue;
    if (clientId && job.clientId !== clientId) continue;
    out.push(job);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export async function deleteArmJob(id, env = process.env) {
  if (redisConfigured(env)) {
    await redisCommand(["DEL", PREFIX + id], env);
    await redisCommand(["SREM", INDEX, id], env);
    return;
  }
  memory.delete(id);
}

/** Test-only helper */
export function _resetMemoryStore() {
  memory.clear();
}
