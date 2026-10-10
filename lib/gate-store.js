// Cache durável da porta (Upstash Redis REST) com recurso a memória quando não há Redis.
// Chaves (todas com versão v1):
//   nl:gate:v1:{SYM}:{gran}      HASH: meta, ledgers, tail   (registo completo; só lido ao actualizar)
//   nl:gate:v1:sum:{gran}        HASH: SYM -> resumo (meta + veredictos)  (radar = 1 comando HGETALL)
//   nl:gate:v1:lock:{SYM}:{gran} SET NX EX (bloqueio de actualização)
//   nl:gate:v1:budget:{tipo}:{hora}  INCR com EXPIRE (limite global de pedidos à Bybit)
//   nl:gate:v1:neg:{SYM}         símbolo inválido (cache negativa)
//   nl:gate:v1:cursor / :top     progresso do backfill / lista dos símbolos mais líquidos
// Escritas em lote via /pipeline (1 pedido HTTP, vários comandos). Sem segredos aqui: credenciais só por env.

const P = "nl:gate:v1:";
export const GATE_ENTRY_TTL_SEC = 14 * 86400;
export const GATE_SUMMARY_FIELD_TTL_NOTE = "campos do resumo não expiram sozinhos; são substituídos em cada actualização";

const memory = {
  hashes: new Map(), // key -> Map(field -> string)
  kv: new Map(), // key -> { v, exp }
};

export function gateRedisCreds(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || "";
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || "";
  return url && token ? { url, token } : null;
}

export function gateStoreInfo(env = process.env) {
  return gateRedisCreds(env)
    ? { backend: "upstash", durable: true }
    : { backend: "memory", durable: false };
}

export const entryKey = (sym, gran) => `${P}${sym}:${gran}`;
export const summaryKey = (gran) => `${P}sum:${gran}`;
export const lockKey = (sym, gran) => `${P}lock:${sym}:${gran}`;
export const negKey = (sym) => `${P}neg:${sym}`;
export const budgetKey = (kind, hour) => `${P}budget:${kind}:${hour}`;
export const CURSOR_KEY = `${P}cursor`;
export const TOP_KEY = `${P}top`;

/** Executa vários comandos num só pedido HTTP (/pipeline). Devolve a lista de resultados (lança se algum falhar). */
export async function pipeline(cmds, env = process.env, fetchImpl = globalThis.fetch) {
  const creds = gateRedisCreds(env);
  if (!creds) throw new Error("upstash_not_configured");
  const res = await fetchImpl(`${creds.url.replace(/\/+$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data)) {
    throw new Error(`upstash_http_${res.status}`);
  }
  return data.map((r) => {
    if (r && r.error) throw new Error(`upstash:${r.error}`);
    return r ? r.result : null;
  });
}

function memGet(key) {
  const x = memory.kv.get(key);
  if (!x) return null;
  if (x.exp && x.exp < Date.now()) {
    memory.kv.delete(key);
    return null;
  }
  return x.v;
}

function memHash(key) {
  let h = memory.hashes.get(key);
  if (!h) {
    h = new Map();
    memory.hashes.set(key, h);
  }
  return h;
}

const j = (x) => (x === undefined ? null : JSON.stringify(x));
const parse = (raw) => {
  if (raw == null) return null;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Registo completo (meta/ledgers/tail) ou null. */
export async function readGateEntry(sym, gran, env = process.env, fetchImpl) {
  if (gateRedisCreds(env)) {
    const [arr] = await pipeline([["HMGET", entryKey(sym, gran), "meta", "ledgers", "tail"]], env, fetchImpl);
    if (!arr || arr[0] == null) return null;
    const meta = parse(arr[0]);
    if (!meta) return null;
    return { ...meta, ledgers: parse(arr[1]) || {}, tail: parse(arr[2]) || [] };
  }
  const h = memory.hashes.get(entryKey(sym, gran));
  if (!h || !h.has("meta")) return null;
  return { ...parse(h.get("meta")), ledgers: parse(h.get("ledgers")) || {}, tail: parse(h.get("tail")) || [] };
}

/** Grava registo completo + resumo, em lote. `entry` = GateEntry; `summary` = GateSummary. */
export async function writeGateEntry(entry, summary, env = process.env, fetchImpl) {
  const { ledgers, tail, ...meta } = entry;
  const k = entryKey(entry.symbol, entry.gran);
  const sk = summaryKey(entry.gran);
  if (gateRedisCreds(env)) {
    await pipeline(
      [
        ["HSET", k, "meta", j(meta), "ledgers", j(ledgers), "tail", j(tail)],
        ["EXPIRE", k, String(GATE_ENTRY_TTL_SEC)],
        ["HSET", sk, entry.symbol, j(summary)],
      ],
      env,
      fetchImpl,
    );
    return;
  }
  const h = memHash(k);
  h.set("meta", j(meta));
  h.set("ledgers", j(ledgers));
  h.set("tail", j(tail));
  memHash(sk).set(entry.symbol, j(summary));
}

/** Resumo de um símbolo (1 comando). */
export async function readGateSummary(sym, gran, env = process.env, fetchImpl) {
  if (gateRedisCreds(env)) {
    const [raw] = await pipeline([["HGET", summaryKey(gran), sym]], env, fetchImpl);
    return parse(raw);
  }
  const h = memory.hashes.get(summaryKey(gran));
  return h ? parse(h.get(sym)) : null;
}

/** Todos os resumos (radar): 1 comando HGETALL → { SYM: resumo }. */
export async function readAllGateSummaries(gran, env = process.env, fetchImpl) {
  const out = {};
  if (gateRedisCreds(env)) {
    const [flat] = await pipeline([["HGETALL", summaryKey(gran)]], env, fetchImpl);
    if (Array.isArray(flat)) {
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const v = parse(flat[i + 1]);
        if (v) out[flat[i]] = v;
      }
    } else if (flat && typeof flat === "object") {
      for (const [s, raw] of Object.entries(flat)) {
        const v = parse(raw);
        if (v) out[s] = v;
      }
    }
    return out;
  }
  const h = memory.hashes.get(summaryKey(gran));
  if (h) for (const [s, raw] of h) out[s] = parse(raw);
  return out;
}

/** SET NX EX: true se obteve o bloqueio. */
export async function acquireLock(key, ttlSec, env = process.env, fetchImpl) {
  if (gateRedisCreds(env)) {
    const [r] = await pipeline([["SET", key, "1", "NX", "EX", String(ttlSec)]], env, fetchImpl);
    return r === "OK";
  }
  if (memGet(key)) return false;
  memory.kv.set(key, { v: "1", exp: Date.now() + ttlSec * 1000 });
  return true;
}

export async function releaseLock(key, env = process.env, fetchImpl) {
  if (gateRedisCreds(env)) {
    await pipeline([["DEL", key]], env, fetchImpl);
    return;
  }
  memory.kv.delete(key);
}

/** Contador com expiração (limite global). Devolve o valor depois de incrementar. */
export async function bumpBudget(key, ttlSec, env = process.env, fetchImpl) {
  if (gateRedisCreds(env)) {
    const [n] = await pipeline([["INCR", key], ["EXPIRE", key, String(ttlSec), "NX"]], env, fetchImpl);
    return Number(n);
  }
  const cur = Number(memGet(key) || 0) + 1;
  const prev = memory.kv.get(key);
  memory.kv.set(key, { v: String(cur), exp: prev && prev.exp ? prev.exp : Date.now() + ttlSec * 1000 });
  return cur;
}

export async function setJson(key, value, ttlSec, env = process.env, fetchImpl) {
  if (gateRedisCreds(env)) {
    await pipeline([ttlSec ? ["SET", key, j(value), "EX", String(ttlSec)] : ["SET", key, j(value)]], env, fetchImpl);
    return;
  }
  memory.kv.set(key, { v: j(value), exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
}

export async function getJson(key, env = process.env, fetchImpl) {
  if (gateRedisCreds(env)) {
    const [raw] = await pipeline([["GET", key]], env, fetchImpl);
    return parse(raw);
  }
  return parse(memGet(key));
}

/** Só para testes. */
export function _resetGateMemory() {
  memory.hashes.clear();
  memory.kv.clear();
}
