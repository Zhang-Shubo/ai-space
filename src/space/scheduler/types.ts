/**
 * Scheduler data model.
 *
 * A task is "when" (schedule) + "what" (target) + bookkeeping (state).
 * Everything here is plain JSON so it can round-trip through SQLite and
 * the HTTP API unchanged.
 */

export type Schedule =
  /** One-shot at an absolute ISO timestamp. */
  | { kind: "at"; at: string }
  /** Fixed interval; runs at anchorMs + k * everyMs. */
  | { kind: "every"; everyMs: number; anchorMs?: number }
  /** 5- or 6-field cron expression with optional IANA timezone. */
  | { kind: "cron"; expr: string; tz?: string };

export type Target =
  /** HTTP request, typically to an app listening on 127.0.0.1. */
  | {
      kind: "http";
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
    }
  /** Shell command run inside the app directory with the app's .env loaded. */
  | { kind: "command"; command: string; cwd?: string; env?: Record<string, string> }
  /** Agent session (claude / codex) fed a prompt file, run inside the app directory. */
  | {
      kind: "agent";
      runtime: "claude" | "codex";
      /** Path to the prompt file, relative to cwd. */
      prompt: string;
      cwd?: string;
      model?: string;
    };

export type RunStatus = "ok" | "error" | "skipped";

export type TaskState = {
  nextRunAt?: number;
  runningAt?: number;
  lastRunAt?: number;
  lastStatus?: RunStatus;
  lastError?: string;
  lastDurationMs?: number;
  /** Consecutive failures, drives backoff; reset to 0 on success. */
  consecutiveErrors: number;
};

export type TaskSource = "manifest" | "api";

export const TASK_NOTIFY_EVENTS = ["error", "ok", "recover", "skipped"] as const;
export type TaskNotifyEvent = (typeof TASK_NOTIFY_EVENTS)[number];

/** `tasks[].notify`: which run outcomes the notify service reports (`when`), and where. */
export type TaskNotify = {
  when: TaskNotifyEvent[];
  /** Channel name; default: the app's default channel. */
  channel?: string;
};

export type Task = {
  id: string;
  /** Owning app; manifest tasks are keyed by app + name. */
  app: string;
  name: string;
  description?: string;
  schedule: Schedule;
  target: Target;
  timeoutMs: number;
  /** Base enabled flag (from the manifest or API create). */
  enabled: boolean;
  /** Operator overrides; survive manifest re-sync. */
  overrides: { enabled?: boolean; schedule?: Schedule };
  source: TaskSource;
  /** Manifest task that disappeared from its manifest; kept for history, never runs. */
  orphaned: boolean;
  notify?: TaskNotify;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
};

export type Run = {
  id: number;
  taskId: string;
  startedAt: number;
  endedAt: number;
  status: RunStatus;
  error?: string;
  /** Truncated stdout / response body for debugging. */
  output?: string;
};

export type TaskCreate = {
  app: string;
  name: string;
  description?: string;
  schedule: Schedule;
  target: Target;
  timeoutMs?: number;
  enabled?: boolean;
  source?: TaskSource;
  notify?: TaskNotify;
};

export type TaskPatch = {
  enabled?: boolean | null;
  schedule?: Schedule | null;
};

export function effectiveEnabled(task: Task): boolean {
  if (task.orphaned) return false;
  return task.overrides.enabled ?? task.enabled;
}

export function effectiveSchedule(task: Task): Schedule {
  return task.overrides.schedule ?? task.schedule;
}

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
