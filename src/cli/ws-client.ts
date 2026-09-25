// Cliente WebSocket mínimo para o WS público da Deriv (req_id + timeout).
export const PUBLIC_WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

export type WsRequest = (payload: Record<string, unknown>) => Promise<string>;

export interface PublicWs {
  requestRaw: WsRequest;
  close: () => void;
  ready: Promise<void>;
}

export function connectPublicWs(url: string = PUBLIC_WS_URL, timeoutMs = 30_000): PublicWs {
  const ws = new WebSocket(url);
  let nextId = 1;
  const waiting = new Map<number, (raw: string) => void>();

  ws.onmessage = (event: MessageEvent) => {
    const raw = String(event.data);
    try {
      const id = (JSON.parse(raw) as { req_id?: unknown }).req_id;
      if (typeof id === "number" && waiting.has(id)) {
        const done = waiting.get(id)!;
        waiting.delete(id);
        done(raw);
      }
    } catch {
      // ignora mensagens que não são JSON
    }
  };

  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Erro de ligação ao WebSocket"));
  });

  function requestRaw(payload: Record<string, unknown>): Promise<string> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("Sem resposta da Deriv em 30 segundos"));
      }, timeoutMs);
      waiting.set(id, (raw) => {
        clearTimeout(timer);
        resolve(raw);
      });
      ws.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  return {
    requestRaw,
    ready,
    close: () => ws.close(),
  };
}

/** Executa tarefas com limite de concorrência (ordem de resultados = ordem de entradas). */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}
