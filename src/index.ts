import { join, resolve } from "node:path";
import { Scheduler, Store, createRoutes, loadManifest } from "./space/scheduler/index.ts";
import { type Workspace, discoverApps, ensureWorkspace, loadWorkspaceEnv, resolveHome } from "./space/workspace.ts";

/**
 * ai-space entry point.
 *
 *   bun src/index.ts        boot: ensure the workspace, sync app manifests, serve the Space API
 *   bun src/index.ts init   create the workspace (~/.ai-space by default) and exit
 *
 * Configuration comes from the environment, then from `<workspace>/.env`
 * (process values win). See `.env.example` and `docs/scheduler.md`.
 */

export type Config = {
  host: string;
  port: number;
  dbPath: string;
  /** Extra app directories (comma-separated SPACE_APPS) synced in addition to <workspace>/apps/*. */
  extraAppDirs: string[];
  apiToken: string;
  maxConcurrency: number;
};

export function loadConfig(ws: Workspace, env: Record<string, string | undefined> = process.env): Config {
  return {
    host: env.SPACE_HOST?.trim() || "127.0.0.1",
    port: Number(env.SPACE_PORT ?? 8700),
    dbPath: resolve(env.SPACE_DB?.trim() || join(ws.data, "space.db")),
    extraAppDirs: (env.SPACE_APPS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))),
    apiToken: env.SPACE_API_TOKEN?.trim() ?? "",
    maxConcurrency: Math.max(1, Number(env.SPACE_MAX_CONCURRENCY ?? 2) || 2),
  };
}

export async function boot(ws: Workspace, config: Config) {
  const store = new Store(config.dbPath);
  const scheduler = new Scheduler({ store, maxConcurrency: config.maxConcurrency });

  const appDirs = [...(await discoverApps(ws)), ...config.extraAppDirs];
  for (const dir of appDirs) {
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
  console.log(`[space] listening on http://${config.host}:${server.port} · workspace ${ws.home} · apps ${appDirs.length}`);

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
  const command = process.argv[2] ?? "start";
  const { ws, created } = await ensureWorkspace(resolveHome());
  for (const p of created) console.log(`[space] created ${p}`);
  if (command === "init") {
    console.log(`[space] workspace ready at ${ws.home}`);
    process.exit(0);
  }
  if (command !== "start") {
    console.error(`[space] unknown command: ${command} (expected start or init)`);
    process.exit(2);
  }
  await loadWorkspaceEnv(ws);
  await boot(ws, loadConfig(ws));
}
