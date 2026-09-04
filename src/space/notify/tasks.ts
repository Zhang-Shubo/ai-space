import type { Run, Task, TaskState } from "../scheduler/types.ts";
import type { NotifyService } from "./engine.ts";
import type { NotificationInput } from "./types.ts";

/**
 * Task notifications: turns the scheduler's run results into messages.
 *
 * Two hooks, both optional:
 *
 * - Workspace level (`SPACE_NOTIFY_TASKS=<channel>`): after three consecutive
 *   failures one alert goes out, and one success message when the task next
 *   succeeds. One failure is noise; three matches the backoff table.
 * - Task level (`tasks[].notify: { when: [...], channel }`): `error` fires on
 *   the first failure of a streak and then at most once per hour while the
 *   streak continues; `recover` on the first success after failures; `ok` and
 *   `skipped` on every run with that status.
 *
 * Task-level messages are sent as the app, so the app's channel allow-list
 * applies. Workspace-level messages are ai-space's own and bypass it.
 */

export const STREAK_ALERT_AT = 3;
const ERROR_REPEAT_MS = 60 * 60_000;
const ERROR_TEXT_MAX = 500;

export type TaskEvent = { task: Task; run: Run; before: TaskState };

export type TaskNotifierOptions = {
  notify: NotifyService;
  /** Channel for workspace-level task reports; empty disables them. */
  tasksChannel?: string;
  log?: (message: string) => void;
};

export function createTaskNotifier(opts: TaskNotifierOptions): (event: TaskEvent) => void {
  const log = opts.log ?? ((m) => console.log(`[notify] ${m}`));
  const tasksChannel = opts.tasksChannel?.trim();

  return ({ task, run, before }) => {
    const label = `task ${task.name}`;
    const errors = task.state.consecutiveErrors;
    const send = (input: NotificationInput, internal: boolean) =>
      opts.notify.send(task.app, input, { internal }).catch((e) => log(`${task.app}/${task.name}: task notification rejected: ${(e as Error).message}`));

    if (tasksChannel) {
      if (run.status === "error" && errors === STREAK_ALERT_AT) {
        void send(
          { level: "alert", title: `${label} failed ${errors} times`, text: errorText(run), channels: [tasksChannel], key: `task:${task.id}:streak`, windowMs: ERROR_REPEAT_MS },
          true,
        );
      } else if (run.status === "ok" && before.consecutiveErrors >= STREAK_ALERT_AT) {
        void send({ level: "success", title: `${label} recovered`, text: `Succeeded after ${before.consecutiveErrors} failures.`, channels: [tasksChannel] }, true);
      }
    }

    const wanted = task.notify;
    if (!wanted) return;
    const channels = wanted.channel ? [wanted.channel] : undefined;
    if (run.status === "error" && wanted.when.includes("error")) {
      const first = before.consecutiveErrors === 0;
      void send(
        { level: "alert", title: first ? `${label} failed` : `${label} still failing (${errors} in a row)`, text: errorText(run), channels, key: `task:${task.id}:error`, windowMs: first ? 1 : ERROR_REPEAT_MS },
        false,
      );
    }
    if (run.status === "ok" && wanted.when.includes("recover") && before.consecutiveErrors > 0) {
      void send({ level: "success", title: `${label} recovered`, text: `Succeeded after ${before.consecutiveErrors} failure(s).`, channels }, false);
    }
    if (run.status === "ok" && wanted.when.includes("ok")) {
      void send({ level: "success", title: `${label} ok`, text: `Finished in ${Math.round((run.endedAt - run.startedAt) / 1000)}s.`, channels }, false);
    }
    if (run.status === "skipped" && wanted.when.includes("skipped")) {
      void send({ level: "info", title: `${label} skipped`, text: run.error ?? "The task reported skipped.", channels }, false);
    }
  };
}

function errorText(run: Run): string {
  const text = (run.error ?? "no error text").trim();
  return text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX - 1)}…` : text;
}
