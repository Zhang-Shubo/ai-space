import { join, resolve } from "node:path";
import { type Manifest, Scheduler, Store, createRoutes, loadManifest } from "./space/scheduler/index.ts";
import { type S3Config, StorageService, createStorageRoutes, openDatabase, parseStorageSpec, sqliteUrl } from "./space/storage/index.ts";
import { type Workspace, discoverApps, ensureWorkspace, loadWorkspaceEnv, resolveHome } from "./space/workspace.ts";

/**
 * ai-space entry point.
 *
 *   bun src/index.ts             boot: ensure the workspace, sync app manifests, serve the Space API
 *   bun src/index.ts init        create the workspace (~/.ai-space by default) and exit
 *   bun src/index.ts env <app>   print the variables storage provisioned for an app, in `export` form
 *
 * Configuration comes from the environment, then from `<workspace>/.env`
 * (process values win). See `.env.example`, `docs/scheduler.md` and `docs/storage.md`.
 */

export type Config = {
  host: string;
  port: number;
  dbPath: string;
  /** Extra app directories (comma-separated SPACE_APPS) synced in addition to <workspace>/apps/*. */
  extraAppDirs: string[];
  apiToken: string;
  maxConcurrency: number;
  /** Superuser URL used only to create per-app postgres databases; empty disables postgres provisioning. */
  pgAdminUrl: string;
  /** Credentials for per-app s3 blob stores (SPACE_S3_*); undefined disables the s3 backend. */
  s3?: S3Config;
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
    pgAdminUrl: env.SPACE_PG_ADMIN_URL?.trim() ?? "",
    ...(env.SPACE_S3_ACCESS_KEY_ID?.trim() && env.SPACE_S3_SECRET_ACCESS_KEY?.trim()
      ? {
          s3: {
            accessKeyId: env.SPACE_S3_ACCESS_KEY_ID.trim(),
            secretAccessKey: env.SPACE_S3_SECRET_ACCESS_KEY.trim(),
            ...(env.SPACE_S3_ENDPOINT?.trim() ? { endpoint: env.SPACE_S3_ENDPOINT.trim() } : {}),
            ...(env.SPACE_S3_REGION?.trim() ? { region: env.SPACE_S3_REGION.trim() } : {}),
            ...(env.SPACE_S3_BUCKET?.trim() ? { bucket: env.SPACE_S3_BUCKET.trim() } : {}),
          },
        }
      : {}),
  };
}

/** Open the storage service on ai-space's own database. */
export async function openStorage(ws: Workspace, config: Config, log?: (m: string) => void): Promise<StorageService> {
  const db = await openDatabase(sqliteUrl(config.dbPath));
  return StorageService.open({ ws, db, pgAdminUrl: config.pgAdminUrl, s3: config.s3, log });
}

export async function boot(ws: Workspace, config: Config) {
  const store = new Store(config.dbPath);
  const storage = await openStorage(ws, config);
  const scheduler = new Scheduler({ store, maxConcurrency: config.maxConcurrency, envFor: (app) => storage.envFor(app) });

  // Storage first, so a command task started right after sync already sees its DATABASE_URL.
  const provision = async (manifest: Manifest) => {
    const result = await storage.syncApp(manifest.app, parseStorageSpec(manifest.storage));
    for (const p of result.created) console.log(`[storage] ${manifest.app}: created ${p}`);
    for (const n of result.orphaned) console.log(`[storage] ${manifest.app}: ${n} left the manifest, kept as orphaned`);
  };

  const appDirs = [...(await discoverApps(ws)), ...config.extraAppDirs];
  for (const dir of appDirs) {
    try {
      const manifest = await loadManifest(dir);
      await provision(manifest);
      scheduler.syncManifest(manifest);
    } catch (e) {
      console.error(`[space] skipping ${dir}: ${(e as Error).message}`);
    }
  }
  await scheduler.start();

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    routes: {
      ...createRoutes({ scheduler, store, token: config.apiToken, onManifest: provision }),
      ...createStorageRoutes({ storage, token: config.apiToken }),
    },
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

  return { store, storage, scheduler, server };
}

if (import.meta.main) {
  const command = process.argv[2] ?? "start";
  const { ws, created } = await ensureWorkspace(resolveHome());
  // stderr, so `eval "$(bun src/index.ts env <app>)"` only sees the variables.
  for (const p of created) console.error(`[space] created ${p}`);
  if (command === "init") {
    console.error(`[space] workspace ready at ${ws.home}`);
    process.exit(0);
  }
  await loadWorkspaceEnv(ws);
  const config = loadConfig(ws);
  if (command === "env") {
    const app = process.argv[3];
    if (!app) {
      console.error("[space] usage: bun src/index.ts env <app>");
      process.exit(2);
    }
    const storage = await openStorage(ws, config, () => {});
    for (const [k, v] of Object.entries(await storage.envFor(app))) console.log(`export ${k}=${shellQuote(v)}`);
    process.exit(0);
  }
  if (command !== "start") {
    console.error(`[space] unknown command: ${command} (expected start, init or env)`);
    process.exit(2);
  }
  await boot(ws, config);
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
