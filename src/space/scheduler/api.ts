import { join } from "node:path";
import { type Manifest, loadManifest } from "./manifest.ts";
import { Scheduler, type SyncSummary } from "./scheduler.ts";
import type { Store } from "./store.ts";
import { type Schedule, type Task, type TaskCreate, type TaskPatch, effectiveEnabled, effectiveSchedule } from "./types.ts";

/**
 * HTTP surface for the scheduler, shaped as a Bun.serve `routes` table.
 *
 *   GET    /healthz
 *   GET    /api/tasks                 list (effective view + state)
 *   POST   /api/tasks                 create an API task
 *   GET    /api/tasks/:id
 *   PATCH  /api/tasks/:id             { enabled?, schedule? } (null clears a manifest override)
 *   DELETE /api/tasks/:id
 *   POST   /api/tasks/:id/run         force a run now
 *   GET    /api/tasks/:id/runs?limit  run history, newest first
 *   POST   /api/apps/sync             discover every app directory and re-read each space.yaml; forget the ones that left
 *   POST   /api/apps/:app/sync        re-read the app's space.yaml
 *
 * Mutating routes require `Authorization: Bearer <token>` when a token is configured.
 */

export type ApiOptions = {
  scheduler: Scheduler;
  store: Store;
  /** Bearer token for mutating routes; empty disables the check (rely on 127.0.0.1). */
  token?: string;
  /** Called with a freshly loaded manifest before the scheduler syncs it (storage provisioning). */
  onManifest?: (manifest: Manifest) => Promise<void>;
  /** Every app directory the workspace holds right now; `POST /api/apps/sync` re-reads them all. */
  discover?: () => Promise<string[]>;
  /** Called when a workspace sync finds a registered app's directory gone (panel deregistration). */
  onGone?: (app: string) => Promise<void>;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", Handler>>>;

export function createRoutes(opts: ApiOptions): Routes {
  const { scheduler, store } = opts;
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

  const withTask = (req: { params: Record<string, string> }): Task => {
    const task = store.getTask(req.params.id ?? "");
    if (!task) throw new NotFound(`unknown task: ${req.params.id}`);
    return task;
  };

  // Load, provision and register one app directory. Shared by both sync routes.
  const syncDir = async (dir: string): Promise<SyncSummary> => {
    const manifest = await loadManifest(dir);
    if (opts.onManifest) await opts.onManifest(manifest);
    return scheduler.syncManifest(Scheduler.schedulable(manifest));
  };

  return {
    "/healthz": () => json({ ok: true }),

    "/api/tasks": {
      GET: () => json({ ok: true, tasks: store.listTasks().map(view) }),
      POST: guard(async (req) => {
        const body = (await req.json()) as Partial<TaskCreate>;
        const input = parseCreate(body);
        return json({ ok: true, task: view(scheduler.addTask(input)) }, 201);
      }),
    },

    "/api/tasks/:id": {
      GET: (req) => safe(() => json({ ok: true, task: view(withTask(req)) })),
      PATCH: guard(async (req) => {
        const task = withTask(req);
        const body = (await req.json()) as Record<string, unknown>;
        return json({ ok: true, task: view(scheduler.patchTask(task.id, parsePatch(body))) });
      }),
      DELETE: guard((req) => {
        const task = withTask(req);
        scheduler.removeTask(task.id);
        return json({ ok: true });
      }),
    },

    "/api/tasks/:id/run": {
      POST: guard((req) => {
        const task = withTask(req);
        const started = scheduler.runNow(task.id);
        return json({ ok: true, started, task: view(store.getTask(task.id) ?? task) }, started ? 202 : 409);
      }),
    },

    "/api/tasks/:id/runs": {
      GET: (req) =>
        safe(() => {
          const task = withTask(req);
          const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
          return json({ ok: true, runs: store.listRuns(task.id, Number.isFinite(limit) ? limit : 50) });
        }),
    },

    // The workspace-wide sync: what boot does, on demand. A directory that appeared after
    // boot is registered here; one whose manifest fails is reported and skipped, the rest
    // still sync; one that disappeared is forgotten and reported under `gone`. Only apps the scheduler already knows can use the per-app route below.
    "/api/apps/sync": {
      POST: guard(async () => {
        const dirs = opts.discover ? await opts.discover() : [];
        const synced: SyncSummary[] = [];
        const skipped: { dir: string; error: string }[] = [];
        for (const dir of dirs) {
          try {
            synced.push(await syncDir(dir));
          } catch (e) {
            skipped.push({ dir, error: (e as Error).message ?? String(e) });
          }
        }
        // An app the scheduler knows but discovery no longer lists has left the workspace
        // (directory or symlink removed). Its manifest must really be missing: a directory
        // whose manifest merely failed to parse is reported in `skipped` and stays registered.
        const gone: SyncSummary[] = [];
        if (opts.discover) {
          const seen = new Set(synced.map((s) => s.app));
          const skippedDirs = new Set(skipped.map((s) => s.dir));
          for (const app of scheduler.apps()) {
            const dir = scheduler.appDir(app);
            if (seen.has(app) || !dir || skippedDirs.has(dir) || (await Bun.file(join(dir, "space.yaml")).exists())) continue;
            const summary = scheduler.forget(app);
            if (!summary) continue;
            if (opts.onGone) await opts.onGone(app);
            gone.push(summary);
          }
        }
        return json({ ok: true, synced, skipped, gone });
      }),
    },

    "/api/apps/:app/sync": {
      POST: guard(async (req) => {
        const app = req.params.app ?? "";
        const dir = scheduler.appDir(app);
        if (!dir) return error(404, `unknown app: ${app}; POST /api/apps/sync registers new directories`);
        const manifest = await loadManifest(dir);
        if (manifest.app !== app) return error(400, `manifest in ${dir} names app "${manifest.app}", expected "${app}"`);
        if (opts.onManifest) await opts.onManifest(manifest);
        return json({ ok: true, sync: scheduler.syncManifest(Scheduler.schedulable(manifest)) });
      }),
    },
  };
}

// ---------------------------------------------------------------- helpers

class NotFound extends Error {}

function safe(fn: () => Response): Response {
  try {
    return fn();
  } catch (e) {
    return e instanceof NotFound ? error(404, e.message) : error(400, (e as Error).message ?? String(e));
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}

/** What the API shows: base fields, effective values, and state. */
export function view(task: Task) {
  return {
    id: task.id,
    app: task.app,
    name: task.name,
    description: task.description,
    source: task.source,
    orphaned: task.orphaned,
    enabled: effectiveEnabled(task),
    schedule: effectiveSchedule(task),
    target: task.target,
    timeoutMs: task.timeoutMs,
    notify: task.notify,
    overrides: task.overrides,
    base: { enabled: task.enabled, schedule: task.schedule },
    state: {
      ...task.state,
      nextRunAt: iso(task.state.nextRunAt),
      runningAt: iso(task.state.runningAt),
      lastRunAt: iso(task.state.lastRunAt),
    },
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  };
}

function iso(ms?: number): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function parseSchedule(raw: unknown): Schedule {
  if (typeof raw !== "object" || raw === null) throw new Error("schedule must be an object");
  const s = raw as Record<string, unknown>;
  switch (s.kind) {
    case "at":
      if (typeof s.at !== "string") throw new Error("schedule.at must be a string");
      return { kind: "at", at: s.at };
    case "every":
      if (typeof s.everyMs !== "number") throw new Error("schedule.everyMs must be a number");
      return { kind: "every", everyMs: s.everyMs };
    case "cron":
      if (typeof s.expr !== "string") throw new Error("schedule.expr must be a string");
      if (s.tz !== undefined && typeof s.tz !== "string") throw new Error("schedule.tz must be a string");
      return { kind: "cron", expr: s.expr, ...(s.tz ? { tz: s.tz } : {}) };
    default:
      throw new Error("schedule.kind must be at, every or cron");
  }
}

function parseCreate(body: Partial<TaskCreate>): TaskCreate {
  if (typeof body.app !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(body.app)) throw new Error("app is required");
  if (typeof body.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(body.name)) throw new Error("name is required");
  if (typeof body.target !== "object" || body.target === null || !("kind" in body.target)) throw new Error("target is required");
  const target = body.target;
  if (target.kind !== "http" && target.kind !== "command" && target.kind !== "agent") throw new Error("target.kind must be http, command or agent");
  return {
    app: body.app,
    name: body.name,
    description: typeof body.description === "string" ? body.description : undefined,
    schedule: parseSchedule(body.schedule),
    target,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    source: "api",
  };
}

function parsePatch(body: Record<string, unknown>): TaskPatch {
  const patch: TaskPatch = {};
  if ("enabled" in body) {
    if (body.enabled !== null && typeof body.enabled !== "boolean") throw new Error("enabled must be boolean or null");
    patch.enabled = body.enabled as boolean | null;
  }
  if ("schedule" in body) patch.schedule = body.schedule === null ? null : parseSchedule(body.schedule);
  return patch;
}
