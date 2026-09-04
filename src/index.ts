import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Scheduler, Store, createRoutes, loadManifest } from "./space/scheduler/index.ts";

/**
 * ai-space entry point: boots the Space services and serves the Space API.
 * Only the scheduler exists so far. Configuration comes from the environment
 * (Bun loads `.env` automatically); see `.env.example`.
 */

export type Config = {
  host: string;
  port: number;
  dbPath: string;
  /** App directories that contain a space.yaml, synced on boot. */
  appDirs: string[];
  apiToken: string;
  maxConcurrency: number;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env.SPACE_HOST?.trim() || "127.0.0.1",
    port: Number(env.SPACE_PORT ?? 8700),
    dbPath: resolve(env.SPACE_DB?.trim() || "data/space.db"),
    appDirs: (env.SPACE_APPS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))),
    apiToken: env.SPACE_API_TOKEN?.trim() ?? "",
    maxConcurrency: Math.max(1, Number(env.SPACE_MAX_CONCURRENCY ?? 2) || 2),
  };
}

export async function boot(config: Config) {
  await mkdir(dirname(config.dbPath), { recursive: true });
  const store = new Store(config.dbPath);
  const scheduler = new Scheduler({ store, maxConcurrency: config.maxConcurrency });

  for (const dir of config.appDirs) {
    try {
      scheduler.syncManifest(await loadManifest(dir));
    } catch (e) {
      console.error(`[space] skipping ${dir}: ${(e as Error).message}`);
    }
  }
  await scheduler.start();

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    routes: createRoutes({ scheduler, store, token: config.apiToken }),
    fetch: () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }),
  });
  console.log(`[space] listening on http://${config.host}:${server.port} · db ${config.dbPath} · apps ${config.appDirs.length}`);

  const shutdown = async () => {
    console.log("[space] shutting down");
    scheduler.stop();
    server.stop();
    await scheduler.idle();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return { store, scheduler, server };
}

if (import.meta.main) {
  await boot(loadConfig());
}
