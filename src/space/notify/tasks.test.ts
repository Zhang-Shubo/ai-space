import { describe, expect, test } from "bun:test";
import type { Run, Task, TaskState } from "../scheduler/types.ts";
import type { NotifyService, SendOptions } from "./engine.ts";
import { createTaskNotifier } from "./tasks.ts";
import type { NotificationInput } from "./types.ts";

type Sent = { app: string; input: NotificationInput; opts: SendOptions };

function fakeNotify(): { notify: NotifyService; sent: Sent[] } {
  const sent: Sent[] = [];
  const notify = {
    send: async (app: string, input: NotificationInput, opts: SendOptions = {}) => {
      sent.push({ app, input, opts });
      return { notification: { id: "n", app, level: "info", text: "", createdAt: 0 }, deliveries: [] };
    },
  } as unknown as NotifyService;
  return { notify, sent };
}

function task(overrides: Partial<Task> = {}, state: Partial<TaskState> = {}): Task {
  return {
    id: "t1",
    app: "my-app",
    name: "refresh",
    schedule: { kind: "every", everyMs: 60_000 },
    target: { kind: "command", command: "true" },
    timeoutMs: 1000,
    enabled: true,
    overrides: {},
    source: "manifest",
    orphaned: false,
    state: { consecutiveErrors: 0, ...state },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const run = (status: Run["status"], error?: string): Run => ({ id: 1, taskId: "t1", startedAt: 1000, endedAt: 3500, status, error, trigger: "schedule" });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("workspace-level task reports", () => {
  test("alerts on the third consecutive failure and once on recovery, as ai-space", async () => {
    const { notify, sent } = fakeNotify();
    const on = createTaskNotifier({ notify, tasksChannel: "default", log: () => {} });
    on({ task: task({}, { consecutiveErrors: 1 }), run: run("error", "boom"), before: { consecutiveErrors: 0 } });
    on({ task: task({}, { consecutiveErrors: 2 }), run: run("error", "boom"), before: { consecutiveErrors: 1 } });
    on({ task: task({}, { consecutiveErrors: 3 }), run: run("error", "boom"), before: { consecutiveErrors: 2 } });
    on({ task: task({}, { consecutiveErrors: 4 }), run: run("error", "boom"), before: { consecutiveErrors: 3 } });
    on({ task: task({}, { consecutiveErrors: 0 }), run: run("ok"), before: { consecutiveErrors: 4 } });
    on({ task: task({}, { consecutiveErrors: 0 }), run: run("ok"), before: { consecutiveErrors: 0 } });
    await flush();
    expect(sent).toEqual([
      { app: "my-app", opts: { internal: true }, input: expect.objectContaining({ level: "alert", title: "task refresh failed 3 times", text: "boom", channels: ["default"], key: "task:t1:streak" }) },
      { app: "my-app", opts: { internal: true }, input: expect.objectContaining({ level: "success", title: "task refresh recovered", text: "Succeeded after 4 failures.", channels: ["default"] }) },
    ]);
  });

  test("does nothing without a tasks channel", async () => {
    const { notify, sent } = fakeNotify();
    const on = createTaskNotifier({ notify, tasksChannel: "", log: () => {} });
    on({ task: task({}, { consecutiveErrors: 3 }), run: run("error", "boom"), before: { consecutiveErrors: 2 } });
    await flush();
    expect(sent).toEqual([]);
  });
});

describe("task-level notify", () => {
  test("error: first failure always, later ones keyed with an hour window", async () => {
    const { notify, sent } = fakeNotify();
    const on = createTaskNotifier({ notify, log: () => {} });
    const t = task({ notify: { when: ["error"], channel: "ops" } });
    on({ task: { ...t, state: { consecutiveErrors: 1 } }, run: run("error", "x".repeat(600)), before: { consecutiveErrors: 0 } });
    on({ task: { ...t, state: { consecutiveErrors: 2 } }, run: run("error", "again"), before: { consecutiveErrors: 1 } });
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.opts).toEqual({ internal: false });
    expect(sent[0]!.input).toMatchObject({ level: "alert", title: "task refresh failed", channels: ["ops"], key: "task:t1:error", windowMs: 1 });
    expect(sent[0]!.input.text).toHaveLength(500);
    expect(sent[1]!.input).toMatchObject({ title: "task refresh still failing (2 in a row)", key: "task:t1:error", windowMs: 3_600_000 });
  });

  test("ok, recover and skipped fire on their statuses, on the app's default channel when none is named", async () => {
    const { notify, sent } = fakeNotify();
    const on = createTaskNotifier({ notify, log: () => {} });
    const t = task({ notify: { when: ["ok", "recover", "skipped"] } });
    on({ task: t, run: run("ok"), before: { consecutiveErrors: 2 } });
    on({ task: t, run: run("skipped", "switched off"), before: { consecutiveErrors: 0 } });
    on({ task: t, run: run("error", "e"), before: { consecutiveErrors: 0 } });
    await flush();
    expect(sent.map((s) => s.input.title)).toEqual(["task refresh recovered", "task refresh ok", "task refresh skipped"]);
    expect(sent[1]!.input).toMatchObject({ level: "success", text: "Finished in 3s." });
    expect(sent[2]!.input).toMatchObject({ level: "info", text: "switched off" });
    expect(sent.every((s) => s.input.channels === undefined)).toBe(true);
  });

  test("a rejected send is logged, never thrown", async () => {
    const logs: string[] = [];
    const notify = { send: async () => Promise.reject(new Error("channel \"x\" is not in the app's notify.channels")) } as unknown as NotifyService;
    const on = createTaskNotifier({ notify, log: (m) => logs.push(m) });
    expect(() => on({ task: task({ notify: { when: ["ok"] } }), run: run("ok"), before: { consecutiveErrors: 0 } })).not.toThrow();
    await flush();
    expect(logs).toEqual([expect.stringContaining("task notification rejected")]);
  });
});
