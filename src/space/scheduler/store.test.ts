import { describe, expect, test } from "bun:test";
import { Store } from "./store.ts";
import type { Task } from "./types.ts";

function sampleTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    app: "demo",
    name: "ping",
    schedule: { kind: "every", everyMs: 60_000, anchorMs: 0 },
    target: { kind: "command", command: "echo hi" },
    timeoutMs: 1000,
    enabled: true,
    overrides: {},
    source: "manifest",
    orphaned: false,
    state: { consecutiveErrors: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("Store", () => {
  test("task round-trips through SQLite", () => {
    const s = new Store(":memory:");
    const t = sampleTask({ description: "d", overrides: { enabled: false } });
    s.saveTask(t);
    expect(s.getTask("t1")).toEqual(t);
    expect(s.findTask("demo", "ping")?.id).toBe("t1");
    expect(s.listTasks()).toHaveLength(1);
    s.close();
  });

  test("saveTask upserts by id and enforces app+name uniqueness", () => {
    const s = new Store(":memory:");
    s.saveTask(sampleTask());
    s.saveTask(sampleTask({ description: "updated", updatedAt: 2 }));
    expect(s.listTasks()).toHaveLength(1);
    expect(s.getTask("t1")?.description).toBe("updated");
    expect(() => s.saveTask(sampleTask({ id: "t2" }))).toThrow();
    s.close();
  });

  test("saveState updates only the state blob", () => {
    const s = new Store(":memory:");
    s.saveTask(sampleTask());
    s.saveState("t1", { consecutiveErrors: 2, lastStatus: "error", lastError: "boom" }, 5);
    const t = s.getTask("t1")!;
    expect(t.state).toEqual({ consecutiveErrors: 2, lastStatus: "error", lastError: "boom" });
    expect(t.updatedAt).toBe(5);
    expect(t.description).toBeUndefined();
    s.close();
  });

  test("runs are listed newest first and pruned per task", () => {
    const s = new Store(":memory:");
    s.saveTask(sampleTask());
    for (let i = 0; i < 520; i++) {
      s.addRun({ taskId: "t1", startedAt: i, endedAt: i + 1, status: i % 2 ? "ok" : "error", error: i % 2 ? undefined : "e", trigger: "schedule" });
    }
    const runs = s.listRuns("t1", 1000);
    expect(runs).toHaveLength(500);
    expect(runs[0]?.startedAt).toBe(519);
    expect(s.listRuns("t1", 3)).toHaveLength(3);
    s.close();
  });

  test("deleteTask removes the task and its runs", () => {
    const s = new Store(":memory:");
    s.saveTask(sampleTask());
    s.addRun({ taskId: "t1", startedAt: 1, endedAt: 2, status: "ok", trigger: "manual" });
    expect(s.deleteTask("t1")).toBe(true);
    expect(s.getTask("t1")).toBeUndefined();
    expect(s.listRuns("t1")).toHaveLength(0);
    expect(s.deleteTask("t1")).toBe(false);
    s.close();
  });

  test("events are stored, fetched by id in order and pruned; runs keep trigger and event ids", () => {
    const s = new Store(":memory:");
    s.saveTask({ ...sampleTask(), triggers: [{ event: "feed/item.added", debounceMs: 5000 }] });
    expect(s.getTask("t1")?.triggers).toEqual([{ event: "feed/item.added", debounceMs: 5000 }]);
    const a = s.addEvent({ app: "feed", name: "item.added", data: { id: 1 } }, 100);
    const b = s.addEvent({ app: "feed", name: "item.added", data: { id: 2 } }, 200);
    const c = s.addEvent({ app: "other", name: "ping" }, 300);
    expect(a.name).toBe("feed/item.added");
    expect(s.getEvents([b.id, a.id]).map((e) => e.data)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(s.getEvents([]).length).toBe(0);
    expect(s.listEvents().map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    expect(s.listEvents({ name: "feed/item.added", limit: 1 }).map((e) => e.id)).toEqual([b.id]);
    expect(s.listEvents({ app: "other" }).map((e) => e.id)).toEqual([c.id]);
    const run = s.addRun({ taskId: "t1", startedAt: 1, endedAt: 2, status: "ok", trigger: "event", eventIds: [a.id, b.id] });
    expect(s.listRuns("t1")[0]).toMatchObject({ id: run.id, trigger: "event", eventIds: [a.id, b.id] });
    for (let i = 0; i < 2100; i++) s.addEvent({ app: "feed", name: "x" }, i);
    expect(s.listEvents({ limit: 5000 })).toHaveLength(2000);
    expect(s.getEvents([a.id])).toHaveLength(0);
    s.close();
  });
});
