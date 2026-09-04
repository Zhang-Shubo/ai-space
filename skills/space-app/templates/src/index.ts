/**
 * Minimal ai-space app service. Contract (docs/app-spec.md, "service"):
 * read PORT, bind 127.0.0.1 only, answer GET /healthz with 200, log to stdout,
 * exit on SIGTERM within 10 seconds. Replace the handlers, keep the contract.
 */

const port = Number(process.env.PORT ?? 8710);
const publicBase = (process.env.PUBLIC_BASE ?? "").replace(/\/$/, "");

type WidgetItem = { text: string; url?: string; time?: string };

/** Widget feed: at most twenty items, newest first. Return { ok: false, error } when the data is unavailable. */
async function widget(): Promise<{ ok: true; items: WidgetItem[] } | { ok: false; error: string }> {
  return { ok: true, items: [{ text: "Hello from my-app", url: publicBase || undefined, time: new Date().toISOString() }] };
}

/** One round of work for the `refresh` task. Report honestly; the scheduler records the verdict. */
async function refresh(): Promise<{ status: "ok" | "error" | "skipped"; error?: string }> {
  return { status: "ok" };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/healthz": () => new Response("ok"),
    "/api/widget": async () => json(await widget()),
    "/jobs/refresh": { POST: async () => json(await refresh()) },
  },
  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`[my-app] listening on http://127.0.0.1:${server.port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[my-app] ${signal}, shutting down`);
    server.stop();
    setTimeout(() => process.exit(0), 8_000).unref();
  });
}
