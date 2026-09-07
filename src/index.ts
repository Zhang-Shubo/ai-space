import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { NotifyService, NotifyStore, createNotifyRoutes, createTaskNotifier, loadChannels, parseNotifySpec } from "./space/notify/index.ts";
import { SessionStore, createAgentRoutes } from "./space/agents/index.ts";
import { AppRegistry, HealthProbe, LayoutStore, WidgetFeed, createPanelRoutes, runStopCommand } from "./space/panel/index.ts";
import { PeerHub, PeerStore, createPeerRoutes, createPeerServeRoutes, loadPeers } from "./space/peers/index.ts";
import { type Manifest, Scheduler, Store, createRoutes, effectiveEnabled, loadManifest } from "./space/scheduler/index.ts";
import { type S3Config, StorageService, createStorageRoutes, openDatabase, parseStorageSpec, sqliteUrl } from "./space/storage/index.ts";
import {
  BACKUP_COMMANDS,
  BACKUP_TASK,
  type BackupCommand,
  BackupStore,
  type BackupTarget,
  SPACE_APP,
  type TaskDefaults,
  backupCli,
  backupTask,
  createBackupRoutes,
  missingArchiveTools,
  openBackupTarget,
  parseBackupSpec,
  spaceManifest,
} from "./space/storage/backup/index.ts";
import { type Workspace, discoverApps, ensureWorkspace, loadWorkspaceEnv, resolveHome } from "./space/workspace.ts";
import { SetupAborted, realDeps, runSetup, terminalIO } from "./space/setup.ts";
import { createWebRoutes } from "./web/routes.ts";

/**
 * ai-space entry point.
 *
 *   bun src/index.ts                     boot: ensure the workspace, sync app manifests, serve the Space API
 *   bun src/index.ts init                create the workspace (~/.ai-space by default) and exit
 *   bun src/index.ts env <app>           print the variables storage provisioned for an app, in `export` form
 *   bun src/index.ts notify [opts] text  send a notification through the running ai-space (see `notifyCommand`)
 *   bun src/index.ts setup               interactive first-install walk-through that fills <workspace>/.env (see `src/space/setup.ts`)
 *   bun src/index.ts backup <app>        snapshot one app's data to the backup target (see `src/space/storage/backup/cli.ts`)
 *   bun src/index.ts backup-verify        open the newest snapshot of every app
 *   bun src/index.ts backups [<app>]      list snapshots
 *   bun src/index.ts restore <app> …      unpack a snapshot (--to <dir> or --in-place)
 *
 * Configuration comes from the environment, then from `<workspace>/.env`
 * (process values win). See `.env.example`, `docs/scheduler.md`, `docs/storage.md`
 * `docs/notify.md`, `docs/panel.md` and `docs/peers.md`.
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
  /** Command that stops an app's service when the panel uninstalls it (SPACE_SERVICE_STOP), `{app}` = name; empty = services are not stopped. */
  serviceStop: string;
  /** What this space calls itself towards a hub (SPACE_NAME); default: the hostname. */
  name: string;
  /** Token a hub must present on `/api/peer/*` (SPACE_HUB_TOKEN); empty = those routes are absent. */
  hubToken: string;
  /** Where snapshots go (SPACE_BACKUP_URL); default s3://<SPACE_S3_BUCKET>/backups/<SPACE_NAME>/ when S3 is configured; empty = backup tasks fail until set. */
  backupUrl: string;
  /** Cron for the per-app backup tasks (SPACE_BACKUP_SCHEDULE); each app gets its own minute. */
  backupSchedule: string;
  /** Cron for the weekly verification (SPACE_BACKUP_VERIFY_SCHEDULE). */
  backupVerifySchedule: string;
  /** A newest successful snapshot older than this fails verification and shows stale (SPACE_BACKUP_MAX_AGE_HOURS). */
  backupMaxAgeMs: number;
  /** Timeout of one backup run (SPACE_BACKUP_TIMEOUT_MIN). */
  backupTimeoutMs: number;
};

export function loadConfig(ws: Workspace, env: Record<string, string | undefined> = process.env): Config {
  const s3Bucket = env.SPACE_S3_BUCKET?.trim() ?? "";
  const s3Configured = Boolean(env.SPACE_S3_ACCESS_KEY_ID?.trim() && env.SPACE_S3_SECRET_ACCESS_KEY?.trim());
  const name = env.SPACE_NAME?.trim() || hostname();
  return {
    // One prefix per machine: several spaces sharing a bucket must not mix their `space/` (and same-named apps') snapshots.
    backupUrl: env.SPACE_BACKUP_URL?.trim() || (s3Configured && s3Bucket ? `s3://${s3Bucket}/backups/${name}/` : ""),
    backupSchedule: env.SPACE_BACKUP_SCHEDULE?.trim() || "0 3 * * *",
    backupVerifySchedule: env.SPACE_BACKUP_VERIFY_SCHEDULE?.trim() || "0 5 * * 1",
    backupMaxAgeMs: Math.max(1, Number(env.SPACE_BACKUP_MAX_AGE_HOURS ?? 48) || 48) * 3600_000,
    backupTimeoutMs: Math.max(1, Number(env.SPACE_BACKUP_TIMEOUT_MIN ?? 30) || 30) * 60_000,
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
    serviceStop: env.SPACE_SERVICE_STOP?.trim() ?? "",
    name,
    hubToken: env.SPACE_HUB_TOKEN?.trim() ?? "",
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

/** What the backup tasks need to spawn `bun src/index.ts backup <app>` from the scheduler. */
export function backupTaskDefaults(ws: Workspace, config: Config): TaskDefaults {
  return {
    schedule: config.backupSchedule,
    verifySchedule: config.backupVerifySchedule,
    timeoutMs: config.backupTimeoutMs,
    bun: process.execPath,
    entry: import.meta.path,
    spaceRoot: resolve(import.meta.dir, ".."),
    home: ws.home,
  };
}

/** Open the backup index and target. A target that cannot be opened is reported, not fatal: the tasks fail visibly instead. */
export async function openBackups(config: Config, log: (m: string) => void = (m) => console.error(m)) {
  const db = await openDatabase(sqliteUrl(config.dbPath));
  const store = await BackupStore.open(db);
  let target: BackupTarget | undefined;
  if (!config.backupUrl) log("[backup] SPACE_BACKUP_URL is not set; backup tasks will fail until it is (docs/backup.md)");
  else {
    try {
      target = openBackupTarget(config.backupUrl, config.s3);
      if (target.kind === "file") log(`[backup] target ${target.url} is on this machine; a copy on the same disk is not a backup`);
    } catch (e) {
      log(`[backup] ${(e as Error).message}`);
    }
  }
  const tools = missingArchiveTools();
  if (tools.length) log(`[backup] ${tools.join(" and ")} not on PATH; backup tasks will fail until installed`);
  return { db, store, target };
}

export async function boot(ws: Workspace, config: Config, env: Record<string, string | undefined> = process.env) {
  const store = new Store(config.dbPath);
  const storage = await openStorage(ws, config);
  const backups = await openBackups(config);
  const taskDefaults = backupTaskDefaults(ws, config);
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
  const { peers: peerConfigs, errors: peerErrors } = loadPeers(env);
  for (const [name, reason] of peerErrors) console.error(`[peers] ${name}: ${reason}`);
  const peers = new PeerHub(peerConfigs, { store: new PeerStore(store.db) });

  // Storage first, so a command task started right after sync already sees its DATABASE_URL.
  // Returns the tasks the services contribute for the app: its backup task, unless the manifest opts out.
  const provision = async (manifest: Manifest) => {
    if (manifest.app === SPACE_APP) throw new Error(`the app name "${SPACE_APP}" is reserved for ai-space itself`);
    const result = await storage.syncApp(manifest.app, parseStorageSpec(manifest.storage));
    for (const p of result.created) console.log(`[storage] ${manifest.app}: created ${p}`);
    for (const n of result.orphaned) console.log(`[storage] ${manifest.app}: ${n} left the manifest, kept as orphaned`);
    notify.syncApp(manifest.app, parseNotifySpec(manifest.notify, { title: manifest.title }));
    await registry.set(manifest);
    const backup = backupTask(manifest.app, parseBackupSpec(manifest.backup), taskDefaults);
    if (backup && manifest.tasks.some((t) => t.name === BACKUP_TASK)) throw new Error(`task name "${BACKUP_TASK}" is reserved for ai-space's backup task; rename it, or set backup: false to bring your own`);
    return backup ? [backup] : [];
  };

  const syncDir = async (dir: string) => {
    const manifest = await loadManifest(dir);
    const extra = await provision(manifest);
    scheduler.syncManifest(Scheduler.schedulable(manifest), extra);
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
  // A peer named like a local app would make `<name>/` ambiguous on the panel.
  for (const p of peerConfigs) {
    if (registry.get(p.name)) {
      console.error(`[peers] peer "${p.name}" has the name of a local app; rename one of them`);
      process.exit(1);
    }
  }
  // ai-space's own tasks: the space.db snapshot and the weekly verification of every app's newest snapshot.
  scheduler.syncBuiltin(spaceManifest(taskDefaults));
  notify.start();
  await scheduler.start();
  peers.start();

  const panelRoutes = createPanelRoutes({
    ws,
    registry,
    layout,
    widgets,
    health,
    peers,
    onCreate: syncDir,
    onRemove: async (app) => {
      scheduler.forget(app);
    },
    ...(config.serviceStop ? { stopService: (app: string) => runStopCommand(config.serviceStop, app) } : {}),
  });
  const agentRoutes = createAgentRoutes({ ws, registry, layout, sessions, defaultModel: config.chatModel, extraArgs: config.chatArgs, envFor: (app) => storage.envFor(app), peers });

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Bun closes a connection idle for 10 s by default, which cuts a chat stream during a long tool
    // call; 255 s is the maximum, and the chat heartbeat (20 s) keeps proxies in between alive.
    idleTimeout: 255,
    // The web UI is bundled once at boot; SPACE_DEV=1 turns on Bun's dev server (hot reload) instead.
    development: process.env.SPACE_DEV === "1",
    routes: {
      ...createRoutes({
        scheduler,
        store,
        token: config.apiToken,
        onManifest: provision,
        discover,
        onGone: async (app) => {
          registry.remove(app);
          console.log(`[space] ${app}: directory gone, deregistered`);
        },
        appForToken: (t) => storage.appForToken(t),
      }),
      ...createStorageRoutes({ storage, token: config.apiToken }),
      ...createBackupRoutes({
        store: backups.store,
        target: backups.target,
        token: config.apiToken,
        maxAgeMs: config.backupMaxAgeMs,
        taskFor: (app) => {
          const t = store.findTask(app, BACKUP_TASK);
          return t ? { id: t.id, nextRunAt: t.state.nextRunAt, enabled: effectiveEnabled(t) } : undefined;
        },
        runNow: (id) => scheduler.runNow(id),
        apps: () => scheduler.apps().filter((app) => store.findTask(app, BACKUP_TASK)?.orphaned === false),
      }),
      ...createNotifyRoutes({ notify, store: notifyStore, token: config.apiToken, appForToken: (t) => storage.appForToken(t) }),
      ...panelRoutes,
      ...agentRoutes,
      ...createPeerRoutes({ hub: peers, layout, registry }),
      ...createPeerServeRoutes({ token: config.hubToken, name: config.name, panel: panelRoutes, agents: agentRoutes }),
      ...createWebRoutes(),
    },
    fetch: () => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }),
  });
  console.log(`[space] listening on http://${config.host}:${server.port} · workspace ${ws.home} · apps ${registry.list().length}${peers.names().length ? ` · peers ${peers.names().join(", ")}` : ""}${config.hubToken ? " · serving /api/peer as " + config.name : ""}`);

  const shutdown = async () => {
    console.log("[space] shutting down");
    scheduler.stop();
    notify.stop();
    peers.stop();
    server.stop();
    await scheduler.idle();
    await notify.idle();
    store.close();
    notifyStore.close();
    await backups.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return { store, storage, scheduler, notify, notifyStore, registry, peers, server, backups };
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
  if ((BACKUP_COMMANDS as readonly string[]).includes(command)) {
    const storage = await openStorage(ws, config, () => {});
    const code = await backupCli(command as BackupCommand, process.argv.slice(3), {
      ws,
      dbPath: config.dbPath,
      s3: config.s3,
      backupUrl: config.backupUrl,
      backupMaxAgeMs: config.backupMaxAgeMs,
      serviceStop: config.serviceStop,
      appDirs: async () => [...(await discoverApps(ws)), ...config.extraAppDirs],
      storage,
    });
    process.exit(code);
  }
  if (command === "setup") {
    try {
      await runSetup(realDeps(terminalIO(), ws));
    } catch (e) {
      if (!(e instanceof SetupAborted)) throw e;
      console.error("\n[space] setup: input closed before the end; nothing written");
      process.exit(1);
    }
    process.exit(0);
  }
  if (command !== "start") {
    console.error(`[space] unknown command: ${command} (expected start, init, env, notify, setup, backup, backup-verify, backups or restore)`);
    process.exit(2);
  }
  await boot(ws, config);
}

function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
