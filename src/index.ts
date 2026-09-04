import { join, resolve } from "node:path";
import { NotifyService, NotifyStore, createNotifyRoutes, createTaskNotifier, loadChannels, parseNotifySpec } from "./space/notify/index.ts";
import { SessionStore, createAgentRoutes } from "./space/agents/index.ts";
import { AppRegistry, HealthProbe, LayoutStore, WidgetFeed, createPanelRoutes } from "./space/panel/index.ts";
import { type Manifest, Scheduler, Store, createRoutes, loadManifest } from "./space/scheduler/index.ts";
import { type S3Config, StorageService, createStorageRoutes, openDatabase, parseStorageSpec, sqliteUrl } from "./space/storage/index.ts";
import { type Workspace, discoverApps, ensureWorkspace, loadWorkspaceEnv, resolveHome } from "./space/workspace.ts";
import { createWebRoutes } from "./web/routes.ts";

/**
 * ai-space entry point.
 *
 *   bun src/index.ts                     boot: ensure the workspace, sync app manifests, serve the Space API
 *   bun src/index.ts init                create the workspace (~/.ai-space by default) and exit
 *   bun src/index.ts env <app>           print the variables storage provisioned for an app, in `export` form
 *   bun src/index.ts notify [opts] text  send a notification through the running ai-space (see `notifyCommand`)
 *
 * Configuration comes from the environment, then from `<workspace>/.env`
 * (process values win). See `.env.example`, `docs/scheduler.md`, `docs/storage.md`
 * `docs/notify.md` and `docs/panel.md`.
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
  /** Channel the scheduler reports failing tasks to (SPACE_NOTIFY_TASKS); empty disables it. */
  notifyTasks: string;
  /** Chat model when neither the request nor the manifest names one (SPACE_CHAT_MODEL). */
  chatModel: string;
  /** Extra arguments for the chat runtime (SPACE_CHAT_ARGS), e.g. a permission wrapper. */
  chatArgs: string[];
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
    notifyTasks: env.SPACE_NOTIFY_TASKS?.trim() ?? "",
    chatModel: env.SPACE_CHAT_MODEL?.trim() ?? "sonnet",
    chatArgs: (env.SPACE_CHAT_ARGS ?? "").split(/\s+/).filter(Boolean),
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

export async function boot(ws: Workspace, config: Config, env: Record<string, string | undefined> = process.env) {
  const store = new Store(config.dbPath);
  const storage = await openStorage(ws, config);
  const { channels, errors: channelErrors } = loadChannels(env);
  const notifyStore = new NotifyStore(config.dbPath);
  const notify = new NotifyService({
    store: notifyStore,
    channels,
    channelErrors,
    imageDir: (app) => join(storage.appDataDir(app), "notify"),
  });
  const scheduler = new Scheduler({
    store,
    maxConcurrency: config.maxConcurrency,
    envFor: (app) => storage.envFor(app),
    onFinish: createTaskNotifier({ notify, tasksChannel: config.notifyTasks }),
  });
  const registry = new AppRegistry();
  const layout = new LayoutStore(store.db);
  const sessions = new SessionStore(store.db);
  const health = new HealthProbe();
  const widgets = new WidgetFeed(registry);

  // Storage first, so a command task started right after sync already sees its DATABASE_URL.
  const provision = async (manifest: Manifest) => {
    const result = await storage.syncApp(manifest.app, parseStorageSpec(manifest.storage));
    for (const p of result.created) console.log(`[storage] ${manifest.app}: created ${p}`);
    for (const n of result.orphaned) console.log(`[storage] ${manifest.app}: ${n} left the manifest, kept as orphaned`);
    notify.syncApp(manifest.app, parseNotifySpec(manifest.notify, { title: manifest.title }));
    await registry.set(manifest);
  };

  const syncDir = async (dir: string) => {
    const manifest = await loadManifest(dir);
    await provision(manifest);
    scheduler.syncManifest(Scheduler.schedulable(manifest));
  };

  // Everything under apps/ plus SPACE_APPS; read again by `POST /api/apps/sync`.
  const discover = async () => [...(await discoverApps(ws)), ...config.extraAppDirs];
  for (const dir of await discover()) {
    try {
      await syncDir(dir);
    } catch (e) {
      console.error(`[space] skipping ${dir}: ${(e as Error).message}`);
    }
  }
  notify.start();
  await scheduler.start();

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // The web UI is bundled once at boot; SPACE_DEV=1 turns on Bun's dev server (hot reload) instead.
    development: process.env.SPACE_DEV === "1",
    routes: {
      ...createRoutes({ scheduler, store, token: config.apiToken, onManifest: provision, discover }),
      ...createStorageRoutes({ storage, token: config.apiToken }),
      ...createNotifyRoutes({ notify, store: notifyStore, token: config.apiToken, appForToken: (t) => storage.appForToken(t) }),
      ...createPanelRoutes({
        ws,
        registry,
        layout,
        widgets,
        health,
        onCreate: syncDir,
        onRemove: async (app) => {
          scheduler.syncManifest({ app, dir: join(ws.apps, app), spec: 1, status: "archived", agents: [], widgets: [], tasks: [] });
        },
      }),
      ...createAgentRoutes({ ws, registry, layout, sessions, defaultModel: config.chatModel, extraArgs: config.chatArgs, envFor: (app) => storage.envFor(app) }),
      ...createWebRoutes(),
    },
    fetch: () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }),
  });
  console.log(`[space] listening on http://${config.host}:${server.port} · workspace ${ws.home} · apps ${registry.list().length}`);

  const shutdown = async () => {
    console.log("[space] shutting down");
    scheduler.stop();
    notify.stop();
    server.stop();
    await scheduler.idle();
    await notify.idle();
    store.close();
    notifyStore.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return { store, storage, scheduler, notify, notifyStore, registry, server };
}

/**
 * `notify` subcommand: post a notification to the running ai-space over loopback.
 *
 *   bun src/index.ts notify [--app <name>] [--level info|success|warn|alert|report]
 *                           [--title <t>] [--url <u>] [--channel <c>] [--key <k>] [--wait] <text…>
 *
 * The app defaults to `SPACE_APP` (set for command tasks). The call uses the
 * operator token; when ai-space is not reachable the message goes to stderr
 * and the exit code is 1, so a script notices.
 */
export function parseNotifyArgs(argv: string[], env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const text: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--app") body.app = value();
    else if (a === "--level") body.level = value();
    else if (a === "--title") body.title = value();
    else if (a === "--url") body.url = value();
    else if (a === "--channel") body.channels = [value()];
    else if (a === "--key") body.key = value();
    else if (a === "--window") body.window = value();
    else if (a === "--wait") body.wait = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else text.push(a);
  }
  body.app ??= env.SPACE_APP;
  if (!body.app) throw new Error("--app is required (or set SPACE_APP)");
  if (text.length === 0) throw new Error("text is required");
  body.text = text.join(" ");
  return body;
}

export async function notifyCommand(argv: string[], config: Config, env: Record<string, string | undefined> = process.env): Promise<number> {
  let body: Record<string, unknown>;
  try {
    body = parseNotifyArgs(argv, env);
  } catch (e) {
    console.error(`[space] notify: ${(e as Error).message}`);
    return 2;
  }
  const url = `http://${config.host}:${config.port}/api/notify`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.apiToken ? { authorization: `Bearer ${config.apiToken}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(body.wait ? 90_000 : 10_000),
    });
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; notification?: { id?: string; deliveries?: { channel: string; status: string; error?: string }[] } };
    if (!res.ok || !out.ok) {
      console.error(`[space] notify: ${res.status} ${out.error ?? ""}`.trim());
      return 1;
    }
    const d = out.notification?.deliveries ?? [];
    console.error(`[space] notify: ${out.notification?.id} ${d.map((x) => `${x.channel}=${x.status}${x.error ? ` (${x.error})` : ""}`).join(" ")}`);
    return body.wait && d.some((x) => x.status === "error") ? 1 : 0;
  } catch (e) {
    console.error(`[space] notify: ai-space not reachable at ${url}: ${(e as Error).message}`);
    console.error(`[space] notify: undelivered message from ${String(body.app)}: ${String(body.title ?? "")} ${String(body.text)}`.trim());
    return 1;
  }
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
  if (command === "notify") process.exit(await notifyCommand(process.argv.slice(3), config));
  if (command !== "start") {
    console.error(`[space] unknown command: ${command} (expected start, init, env or notify)`);
    process.exit(2);
  }
  await boot(ws, config);
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
