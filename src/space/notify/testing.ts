import type { Fetch } from "./transports.ts";

/**
 * Test helper: a scripted `fetch`. Each call is recorded (url, method, headers,
 * parsed body) and answered by the next queued response, or by 200 `{}` when
 * the queue is empty.
 */

export type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown; form?: FormData };

export type Scripted = {
  fetch: Fetch;
  calls: Recorded[];
  /** Queue a response: status plus JSON body, or a raw Response, or an Error to throw. */
  reply: (...responses: (Response | Error | { status: number; body?: unknown; headers?: Record<string, string> })[]) => void;
};

export function scriptedFetch(): Scripted {
  const calls: Recorded[] = [];
  const queue: (Response | Error | { status: number; body?: unknown; headers?: Record<string, string> })[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = init?.body;
    let form: FormData | undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body instanceof FormData) {
      form = init.body;
      body = Object.fromEntries(
        [...init.body.entries()].map(([k, v]) => {
          const file = v as unknown as { name?: string; size?: number };
          return [k, typeof v === "string" ? v : `<file ${file.name} ${file.size}b>`];
        }),
      );
    }
    calls.push({ url, method: init?.method ?? "GET", headers, body, ...(form ? { form } : {}) });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    const status = next?.status ?? 200;
    return new Response(JSON.stringify(next?.body ?? {}), { status, headers: { "content-type": "application/json", ...(next?.headers ?? {}) } });
  }) as Fetch;
  return { fetch: fetchImpl, calls, reply: (...r) => queue.push(...r) };
}

/** A sleep that records the requested delays and resolves immediately. */
export function instantSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}
