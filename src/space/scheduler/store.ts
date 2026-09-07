import { Database } from "bun:sqlite";
import type { EventInput, Run, RunStatus, RunTrigger, SpaceEvent, Task, TaskState } from "./types.ts";

/**
 * SQLite persistence for tasks, their run history and the events apps publish.
 *
 * Tasks are stored as a few indexed columns plus JSON blobs for the parts that
 * vary by kind (schedule, target, overrides, state). Migrations follow the
 * "only add nullable columns" rule: extend ADDED_COLUMNS, never rewrite tables.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  app           TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  schedule      TEXT NOT NULL,
  target        TEXT NOT NULL,
  timeout_ms    INTEGER NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  overrides     TEXT NOT NULL DEFAULT '{}',
  source        TEXT NOT NULL,
  orphaned      INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(app, name)
);
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  output      TEXT
);
CREATE INDEX IF NOT EXISTS runs_task_started ON runs(task_id, started_at DESC);
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  app    TEXT NOT NULL,
  data   TEXT NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events(at DESC);
`;

/** Columns added after the initial schema; applied on open if missing. */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "tasks", column: "notify", ddl: "TEXT" },
  { table: "tasks", column: "triggers", ddl: "TEXT" },
  { table: "runs", column: "trigger", ddl: "TEXT" },
  { table: "runs", column: "events", ddl: "TEXT" },
];

type TaskRow = {
  id: string;
  app: string;
  name: string;
  description: string | null;
  schedule: string;
  target: string;
  timeout_ms: number;
  enabled: number;
  overrides: string;
  source: string;
  orphaned: number;
  notify: string | null;
  triggers: string | null;
  state: string;
  created_at: number;
  updated_at: number;
};

type RunRow = {
  id: number;
  task_id: string;
  started_at: number;
  ended_at: number;
  status: string;
  error: string | null;
  output: string | null;
  trigger: string | null;
  events: string | null;
};

type EventRow = { id: number; name: string; app: string; data: string; at: number };

const MAX_RUNS_PER_TASK = 500;
/** Events kept for history and late delivery; older rows are dropped on insert. */
const MAX_EVENTS = 2000;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    for (const { table, column, ddl } of ADDED_COLUMNS) {
      const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- tasks

  listTasks(): Task[] {
    return this.db
      .query<TaskRow, []>("SELECT * FROM tasks ORDER BY app, name")
      .all()
      .map(rowToTask);
  }

  getTask(id: string): Task | undefined {
    const row = this.db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? rowToTask(row) : undefined;
  }

  findTask(app: string, name: string): Task | undefined {
    const row = this.db
      .query<TaskRow, [string, string]>("SELECT * FROM tasks WHERE app = ? AND name = ?")
      .get(app, name);
    return row ? rowToTask(row) : undefined;
  }

  /** Insert or fully replace a task row. Callers own the id and timestamps. */
  saveTask(task: Task): void {
    this.db
      .query(
        `INSERT INTO tasks (id, app, name, description, schedule, target, timeout_ms, enabled, overrides, source, orphaned, notify, triggers, state, created_at, updated_at)
         VALUES ($id, $app, $name, $description, $schedule, $target, $timeout_ms, $enabled, $overrides, $source, $orphaned, $notify, $triggers, $state, $created_at, $updated_at)
         ON CONFLICT(id) DO UPDATE SET
           app = excluded.app, name = excluded.name, description = excluded.description,
           schedule = excluded.schedule, target = excluded.target, timeout_ms = excluded.timeout_ms,
           enabled = excluded.enabled, overrides = excluded.overrides, source = excluded.source,
           orphaned = excluded.orphaned, notify = excluded.notify, triggers = excluded.triggers, state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run({
        $notify: task.notify ? JSON.stringify(task.notify) : null,
        $triggers: task.triggers?.length ? JSON.stringify(task.triggers) : null,
        $id: task.id,
        $app: task.app,
        $name: task.name,
        $description: task.description ?? null,
        $schedule: JSON.stringify(task.schedule),
        $target: JSON.stringify(task.target),
        $timeout_ms: task.timeoutMs,
        $enabled: task.enabled ? 1 : 0,
        $overrides: JSON.stringify(task.overrides),
        $source: task.source,
        $orphaned: task.orphaned ? 1 : 0,
        $state: JSON.stringify(task.state),
        $created_at: task.createdAt,
        $updated_at: task.updatedAt,
      });
  }

  /** Persist only the state blob; used on every tick so it stays cheap. */
  saveState(id: string, state: TaskState, updatedAt: number): void {
    this.db
      .query("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(state), updatedAt, id);
  }

  deleteTask(id: string): boolean {
    const r = this.db.query("DELETE FROM tasks WHERE id = ?").run(id);
    this.db.query("DELETE FROM runs WHERE task_id = ?").run(id);
    return r.changes > 0;
  }

  // ---------------------------------------------------------------- runs

  addRun(run: Omit<Run, "id">): Run {
    const r = this.db
      .query("INSERT INTO runs (task_id, started_at, ended_at, status, error, output, trigger, events) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.taskId, run.startedAt, run.endedAt, run.status, run.error ?? null, run.output ?? null, run.trigger, run.eventIds?.length ? JSON.stringify(run.eventIds) : null);
    this.db
      .query(
        `DELETE FROM runs WHERE task_id = ? AND id NOT IN (
           SELECT id FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT ?)`,
      )
      .run(run.taskId, run.taskId, MAX_RUNS_PER_TASK);
    return { id: Number(r.lastInsertRowid), ...run };
  }

  listRuns(taskId: string, limit = 50): Run[] {
    return this.db
      .query<RunRow, [string, number]>(
        "SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
      )
      .all(taskId, Math.max(1, Math.min(limit, MAX_RUNS_PER_TASK)))
      .map((r) => ({
        id: r.id,
        taskId: r.task_id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        status: r.status as RunStatus,
        error: r.error ?? undefined,
        output: r.output ?? undefined,
        // Runs recorded before triggers existed were started by the clock.
        trigger: (r.trigger as RunTrigger | null) ?? "schedule",
        ...(r.events ? { eventIds: JSON.parse(r.events) as number[] } : {}),
      }));
  }

  // ---------------------------------------------------------------- events

  addEvent(input: EventInput, at: number): SpaceEvent {
    const name = `${input.app}/${input.name}`;
    const data = input.data ?? {};
    const r = this.db.query("INSERT INTO events (name, app, data, at) VALUES (?, ?, ?, ?)").run(name, input.app, JSON.stringify(data), at);
    this.db.query("DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?").run(MAX_EVENTS);
    return { id: Number(r.lastInsertRowid), name, app: input.app, data, at };
  }

  /** The events with these ids, oldest first; ids already pruned are silently missing. */
  getEvents(ids: number[]): SpaceEvent[] {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(", ");
    return this.db
      .query<EventRow, number[]>(`SELECT * FROM events WHERE id IN (${marks}) ORDER BY id`)
      .all(...ids)
      .map(rowToEvent);
  }

  /** Newest first, optionally one qualified name or one app's events. */
  listEvents(opts: { limit?: number; name?: string; app?: string } = {}): SpaceEvent[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, MAX_EVENTS));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.name) {
      where.push("name = ?");
      args.push(opts.name);
    }
    if (opts.app) {
      where.push("app = ?");
      args.push(opts.app);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.query<EventRow, (string | number)[]>(sql).all(...args, limit).map(rowToEvent);
  }
}

function rowToEvent(r: EventRow): SpaceEvent {
  return { id: r.id, name: r.name, app: r.app, data: JSON.parse(r.data), at: r.at };
}

function rowToTask(r: TaskRow): Task {
  const state = JSON.parse(r.state) as Partial<TaskState>;
  return {
    id: r.id,
    app: r.app,
    name: r.name,
    description: r.description ?? undefined,
    schedule: JSON.parse(r.schedule),
    target: JSON.parse(r.target),
    timeoutMs: r.timeout_ms,
    enabled: r.enabled === 1,
    overrides: JSON.parse(r.overrides),
    source: r.source as Task["source"],
    orphaned: r.orphaned === 1,
    ...(r.notify ? { notify: JSON.parse(r.notify) } : {}),
    ...(r.triggers ? { triggers: JSON.parse(r.triggers) } : {}),
    state: { consecutiveErrors: 0, ...state },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
