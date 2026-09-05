import type { Manifest, ManifestTask } from "./manifest.ts";
import { assertSchedule, nextRunAt } from "./schedule.ts";
import type { Store } from "./store.ts";
import { type RunResult, runTarget } from "./targets.ts";
import {
  DEFAULT_TIMEOUT_MS,
  type Run,
  type Schedule,
  type Task,
  type TaskCreate,
  type TaskPatch,
  type TaskState,
  effectiveEnabled,
  effectiveSchedule,
} from "./types.ts";

/**
 * Scheduler engine.
 *
 * One timer, aimed at the earliest due task and clamped to MAX_TIMER_DELAY_MS so
 * the loop recovers quickly after a suspend or clock jump. A tick launches due
 * tasks up to the concurrency limit without awaiting them; each finished run
 * applies its result and re-ticks so waiting tasks get the freed slot.
 *
 * Rules:
 * - a task never overlaps itself (runningAt marker);
 * - every run has a hard timeout (AbortSignal);
 * - errors back off 30s → 1m → 5m → 15m → 60m, reset on success;
 * - a tick with nothing due only fills in missing nextRunAt values, it never
 *   advances a past-due one (that would silently skip a run);
 * - stale running markers are cleared on start and after STUCK_RUN_MS.
 */

const MAX_TIMER_DELAY_MS = 60_000;
const STUCK_RUN_MS = 2 * 3_600_000;
const ERROR_BACKOFF_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type Runner = (task: Task, ctx: { appDir?: string; env?: Record<string, string>; signal: AbortSignal }) => Promise<RunResult>;

export type SchedulerOptions = {
  store: Store;
  now?: () => number;
  runner?: Runner;
  maxConcurrency?: number;
  log?: (message: string) => void;
  /** Extra environment for an app's command/agent runs, e.g. the variables storage provisioned. */
  envFor?: (app: string) => Promise<Record<string, string>>;
  /** Called after every run is recorded, with the task's updated state and the state before the run. */
  onFinish?: (event: { task: Task; run: Run; before: TaskState }) => void;
};

export type SyncSummary = { app: string; created: string[]; updated: string[]; orphaned: string[] };

export class Scheduler {
  private readonly store: Store;
  private readonly now: () => number;
  private readonly runner: Runner;
  private readonly maxConcurrency: number;
  private readonly log: (message: string) => void;
  private readonly envFor?: (app: string) => Promise<Record<string, string>>;
  private readonly onFinish?: SchedulerOptions["onFinish"];
  private readonly appDirs = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ticking = false;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.runner = opts.runner ?? ((task, ctx) => runTarget(task.target, ctx));
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 2);
    this.log = opts.log ?? ((m) => console.log(`[scheduler] ${m}`));
    this.envFor = opts.envFor;
    this.onFinish = opts.onFinish;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const now = this.now();
    let stale = 0;
    for (const task of this.store.listTasks()) {
      let changed = false;
      if (task.state.runningAt !== undefined) {
        task.state.runningAt = undefined;
        stale++;
        changed = true;
      }
      if (this.fillNextRun(task, now)) changed = true;
      if (changed) this.store.saveState(task.id, task.state, now);
    }
    if (stale) this.log(`cleared ${stale} stale running marker(s) left by a previous process`);
    const tasks = this.store.listTasks();
    this.log(`started with ${tasks.length} task(s), ${tasks.filter(effectiveEnabled).length} enabled`);
    await this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves once no run is in flight. Mostly for tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight.values()]);
  }

  appDir(app: string): string | undefined {
    return this.appDirs.get(app);
  }

  /** Every app a manifest sync has registered, sorted. */
  apps(): string[] {
    return [...this.appDirs.keys()].sort();
  }

  /**
   * Drop an app whose directory is gone: its manifest tasks become orphaned (kept in
   * the store with their run history) and the per-app sync route stops knowing it.
   */
  forget(app: string): SyncSummary | undefined {
    const dir = this.appDirs.get(app);
    if (dir === undefined) return undefined;
    const summary = this.syncManifest({ app, dir, spec: 1, status: "archived", agents: [], widgets: [], tasks: [] });
    this.appDirs.delete(app);
    return summary;
  }

  // ---------------------------------------------------------------- tick

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const tasks = this.store.listTasks();
      let changed = false;
      for (const task of tasks) {
        if (task.state.runningAt !== undefined && !this.inflight.has(task.id) && now - task.state.runningAt > STUCK_RUN_MS) {
          this.log(`task ${task.app}/${task.name}: clearing stuck running marker`);
          task.state.runningAt = undefined;
          changed = true;
        }
        if (this.fillNextRun(task, now)) changed = true;
        if (changed) this.store.saveState(task.id, task.state, now);
        changed = false;
      }

      const due = tasks
        .filter((t) => effectiveEnabled(t) && t.state.runningAt === undefined && t.state.nextRunAt !== undefined && t.state.nextRunAt <= now)
        .sort((a, b) => (a.state.nextRunAt ?? 0) - (b.state.nextRunAt ?? 0));
      const slots = this.maxConcurrency - this.inflight.size;
      for (const task of due.slice(0, Math.max(0, slots))) this.launch(task, "due");
    } finally {
      this.ticking = false;
      this.armTimer();
    }
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const now = this.now();
    let nextAt: number | undefined;
    for (const t of this.store.listTasks()) {
      if (!effectiveEnabled(t) || t.state.runningAt !== undefined || t.state.nextRunAt === undefined) continue;
      if (nextAt === undefined || t.state.nextRunAt < nextAt) nextAt = t.state.nextRunAt;
    }
    if (nextAt === undefined) return;
    const delay = Math.min(Math.max(nextAt - now, 0), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => void this.tick().catch((e) => this.log(`tick failed: ${String(e)}`)), delay);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  /** Give an enabled task a nextRunAt if it has none. Never moves an existing one. */
  private fillNextRun(task: Task, now: number): boolean {
    if (!effectiveEnabled(task)) {
      if (task.state.nextRunAt !== undefined) {
        task.state.nextRunAt = undefined;
        return true;
      }
      return false;
    }
    if (task.state.nextRunAt !== undefined) return false;
    // A task that has never run (or was just re-enabled) is due right away for
    // interval schedules; cron and one-shot wait for their natural moment.
    const schedule = effectiveSchedule(task);
    const next = schedule.kind === "every" && task.state.lastRunAt === undefined ? now : nextRunAt(schedule, now);
    if (next === undefined) return false;
    task.state.nextRunAt = next;
    return true;
  }

  // ---------------------------------------------------------------- execution

  private launch(task: Task, reason: string): void {
    const startedAt = this.now();
    task.state.runningAt = startedAt;
    task.state.lastError = undefined;
    this.store.saveState(task.id, task.state, startedAt);
    this.log(`task ${task.app}/${task.name}: started (${reason})`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), task.timeoutMs);
    const env = this.envFor ? this.envFor(task.app) : Promise.resolve(undefined);
    const p = env
      .then((extra) => this.runner(task, { appDir: this.appDirs.get(task.app), env: extra, signal: controller.signal }))
      .catch((e): RunResult => ({ status: "error", error: (e as Error).message ?? String(e) }))
      .then((result) => {
        clearTimeout(timeout);
        this.finish(task.id, startedAt, result);
      })
      .finally(() => {
        this.inflight.delete(task.id);
        void this.tick().catch((e) => this.log(`tick failed: ${String(e)}`));
      });
    this.inflight.set(task.id, p);
  }

  private finish(taskId: string, startedAt: number, result: RunResult): void {
    const endedAt = this.now();
    const task = this.store.getTask(taskId);
    if (!task) return; // deleted while running
    const before = { ...task.state };
    const s = task.state;
    s.runningAt = undefined;
    s.lastRunAt = startedAt;
    s.lastStatus = result.status;
    s.lastError = result.error;
    s.lastDurationMs = Math.max(0, endedAt - startedAt);
    s.consecutiveErrors = result.status === "error" ? s.consecutiveErrors + 1 : 0;

    const schedule = effectiveSchedule(task);
    const natural = effectiveEnabled(task) ? nextRunAt(schedule, endedAt) : undefined;
    if (result.status === "error" && natural !== undefined) {
      const backoff = ERROR_BACKOFF_MS[Math.min(s.consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)] ?? 0;
      s.nextRunAt = Math.max(natural, endedAt + backoff);
    } else {
      s.nextRunAt = natural;
    }

    this.store.saveState(task.id, s, endedAt);
    const run = this.store.addRun({ taskId: task.id, startedAt, endedAt, status: result.status, error: result.error, output: result.output });
    const summary = result.status === "ok" ? "ok" : `${result.status}: ${result.error ?? ""}`;
    this.log(`task ${task.app}/${task.name}: ${summary} in ${s.lastDurationMs}ms`);
    if (this.onFinish) {
      try {
        this.onFinish({ task, run, before });
      } catch (e) {
        this.log(`onFinish hook failed: ${(e as Error).message ?? String(e)}`);
      }
    }
  }

  /** Force a run now. Returns false when the task is already running. */
  runNow(id: string): boolean {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    if (task.state.runningAt !== undefined || this.inflight.has(id)) return false;
    this.launch(task, "manual");
    return true;
  }

  // ---------------------------------------------------------------- CRUD

  addTask(input: TaskCreate): Task {
    assertSchedule(input.schedule);
    if (this.store.findTask(input.app, input.name)) throw new Error(`task ${input.app}/${input.name} already exists`);
    const now = this.now();
    const task: Task = {
      id: crypto.randomUUID(),
      app: input.app,
      name: input.name,
      description: input.description,
      schedule: withAnchor(input.schedule, now),
      target: input.target,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      enabled: input.enabled ?? true,
      overrides: {},
      source: input.source ?? "api",
      orphaned: false,
      ...(input.notify ? { notify: input.notify } : {}),
      state: { consecutiveErrors: 0 },
      createdAt: now,
      updatedAt: now,
    };
    this.fillNextRun(task, now);
    this.store.saveTask(task);
    this.armTimer();
    return task;
  }

  /**
   * Operator patch. Manifest tasks keep the manifest as their base and record
   * the patch as an override (null clears it); API tasks are edited in place.
   */
  patchTask(id: string, patch: TaskPatch): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    const now = this.now();
    const before = JSON.stringify(effectiveSchedule(task));
    if (patch.schedule) assertSchedule(patch.schedule);

    if (task.source === "manifest") {
      if (patch.enabled === null) delete task.overrides.enabled;
      else if (patch.enabled !== undefined) task.overrides.enabled = patch.enabled;
      if (patch.schedule === null) delete task.overrides.schedule;
      else if (patch.schedule) task.overrides.schedule = withAnchor(patch.schedule, now);
    } else {
      if (typeof patch.enabled === "boolean") task.enabled = patch.enabled;
      if (patch.schedule) task.schedule = withAnchor(patch.schedule, now);
    }

    if (JSON.stringify(effectiveSchedule(task)) !== before) task.state.nextRunAt = undefined;
    this.fillNextRun(task, now);
    task.updatedAt = now;
    this.store.saveTask(task);
    this.armTimer();
    return task;
  }

  removeTask(id: string): boolean {
    const task = this.store.getTask(id);
    if (!task) return false;
    if (task.source === "manifest" && !task.orphaned) {
      throw new Error("manifest tasks are removed by deleting them from space.yaml and re-syncing");
    }
    const removed = this.store.deleteTask(id);
    this.armTimer();
    return removed;
  }

  // ---------------------------------------------------------------- manifest sync

  /**
   * What the scheduler should see of a manifest: a paused or archived app keeps its
   * storage and stays registered, but its tasks stop (they become orphaned on sync).
   */
  static schedulable(manifest: Manifest): Manifest {
    return manifest.status === "active" ? manifest : { ...manifest, tasks: [] };
  }

  /**
   * Idempotent upsert of an app's manifest tasks; unlisted manifest tasks become orphaned.
   * `extra` are tasks other services contribute for the app (the backup task); they are
   * treated exactly like manifest tasks.
   */
  syncManifest(manifest: Manifest, extra: ManifestTask[] = []): SyncSummary {
    const now = this.now();
    this.appDirs.set(manifest.app, manifest.dir);
    const summary: SyncSummary = { app: manifest.app, created: [], updated: [], orphaned: [] };
    const seen = new Set<string>();

    for (const mt of [...manifest.tasks, ...extra]) {
      if (seen.has(mt.name)) throw new Error(`: task  is declared twice`);
      seen.add(mt.name);
      const existing = this.store.findTask(manifest.app, mt.name);
      if (!existing) {
        this.addTask({ app: manifest.app, name: mt.name, description: mt.description, schedule: mt.schedule, target: mt.target, timeoutMs: mt.timeoutMs, enabled: mt.enabled, source: "manifest", notify: mt.notify });
        summary.created.push(mt.name);
        continue;
      }
      const scheduleChanged = JSON.stringify(stripAnchor(existing.schedule)) !== JSON.stringify(stripAnchor(mt.schedule));
      const changed =
        scheduleChanged ||
        existing.orphaned ||
        existing.source !== "manifest" ||
        existing.description !== mt.description ||
        existing.enabled !== mt.enabled ||
        existing.timeoutMs !== mt.timeoutMs ||
        JSON.stringify(existing.target) !== JSON.stringify(mt.target) ||
        JSON.stringify(existing.notify ?? null) !== JSON.stringify(mt.notify ?? null);
      if (!changed) continue;
      existing.description = mt.description;
      existing.target = mt.target;
      existing.timeoutMs = mt.timeoutMs;
      existing.notify = mt.notify;
      existing.enabled = mt.enabled;
      existing.source = "manifest";
      existing.orphaned = false;
      if (scheduleChanged) {
        existing.schedule = withAnchor(mt.schedule, now);
        if (!existing.overrides.schedule) existing.state.nextRunAt = undefined;
      }
      this.fillNextRun(existing, now);
      existing.updatedAt = now;
      this.store.saveTask(existing);
      summary.updated.push(mt.name);
    }

    for (const t of this.store.listTasks()) {
      if (t.app !== manifest.app || t.source !== "manifest" || seen.has(t.name) || t.orphaned) continue;
      t.orphaned = true;
      t.state.nextRunAt = undefined;
      t.updatedAt = now;
      this.store.saveTask(t);
      summary.orphaned.push(t.name);
    }

    this.log(`synced ${manifest.app}: +${summary.created.length} ~${summary.updated.length} -${summary.orphaned.length}`);
    this.armTimer();
    return summary;
  }
}

function withAnchor(schedule: Schedule, now: number): Schedule {
  return schedule.kind === "every" ? { ...schedule, anchorMs: schedule.anchorMs ?? now } : schedule;
}

function stripAnchor(schedule: Schedule): Schedule {
  if (schedule.kind !== "every") return schedule;
  const { anchorMs: _, ...rest } = schedule;
  return rest;
}
