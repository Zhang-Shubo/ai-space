import type { BackupStore, BackupSummary } from "./store.ts";
import type { BackupTarget } from "./target.ts";

/**
 * HTTP surface for backups, merged into the Space API routes.
 *
 *   GET  /api/backups                every app: last snapshot, last ok, last verified, next run
 *   GET  /api/apps/:app/backups      one app's snapshots, newest first
 *   POST /api/apps/:app/backups      run the app's backup task now
 *
 * The POST requires `Authorization: Bearer <token>` when a token is configured.
 */

export type BackupApiOptions = {
  store: BackupStore;
  target?: BackupTarget;
  token?: string;
  /** A last successful snapshot older than this is reported `stale`. */
  maxAgeMs: number;
  /** The app's backup task, when the scheduler has one. */
  taskFor: (app: string) => { id: string; nextRunAt?: number; enabled: boolean } | undefined;
  runNow: (taskId: string) => boolean;
  /** Every app that has a backup task, so apps without a snapshot yet still appear. */
  apps: () => string[];
  now?: () => number;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

export type BackupView = BackupSummary & {
  stale: boolean;
  taskId?: string;
  nextRunAt?: number;
  enabled?: boolean;
};

export function createBackupRoutes(opts: BackupApiOptions): Routes {
  const token = opts.token?.trim() ?? "";
  const guard =
    (h: Handler): Handler =>
    async (req) => {
      if (token && req.headers.get("authorization") !== `Bearer ${token}`) return error(401, "unauthorized");
      try {
        return await h(req);
      } catch (e) {
        return error(400, (e as Error).message ?? String(e));
      }
    };

  const overview = async (): Promise<BackupView[]> => {
    const now = (opts.now ?? Date.now)();
    const byApp = new Map((await opts.store.summary()).map((s) => [s.app, s]));
    const apps = new Set([...byApp.keys(), ...opts.apps()]);
    return [...apps].sort().map((app) => {
      const s = byApp.get(app) ?? { app, count: 0 };
      const task = opts.taskFor(app);
      return {
        ...s,
        stale: s.lastOkAt === undefined || now - s.lastOkAt > opts.maxAgeMs,
        ...(task ? { taskId: task.id, nextRunAt: task.nextRunAt, enabled: task.enabled } : {}),
      };
    });
  };

  return {
    "/api/backups": {
      GET: async () => json({ ok: true, target: opts.target?.url ?? null, maxAgeHours: Math.round(opts.maxAgeMs / 3600_000), backups: await overview(), asOf: new Date().toISOString() }),
    },
    "/api/apps/:app/backups": {
      GET: async (req) => {
        const app = req.params.app ?? "";
        const task = opts.taskFor(app);
        return json({ ok: true, app, ...(task ? { taskId: task.id, nextRunAt: task.nextRunAt, enabled: task.enabled } : {}), snapshots: await opts.store.list(app) });
      },
      POST: guard(async (req) => {
        const app = req.params.app ?? "";
        const task = opts.taskFor(app);
        if (!task) return error(404, `${app} has no backup task`);
        if (!opts.runNow(task.id)) return error(409, "backup already running");
        return json({ ok: true, taskId: task.id, started: true }, 202);
      }),
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
