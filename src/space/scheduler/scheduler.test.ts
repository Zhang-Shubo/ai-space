import { describe, expect, test } from "bun:test";
import type { Manifest } from "./manifest.ts";
import { type Runner, Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import type { Task } from "./types.ts";

/** Fake clock plus a scripted runner; ticks are driven by hand. */
function harness(opts: { runner?: Runner; maxConcurrency?: number } = {}) {
  let t = Date.parse("2026-09-04T00:00:00Z");
  const calls: string[] = [];
  const runner: Runner = opts.runner ?? (async (task) => {
    calls.push(task.name);
    return { status: "ok", output: "fine" };
  });
  const store = new Store(":memory:");
  const s = new Scheduler({ store, now: () => t, runner, maxConcurrency: opts.maxConcurrency, log: () => {} });
  return {
    s,
    store,
    calls,
    at: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    manifest: (tasks: Manifest["tasks"], app = "demo"): Manifest => ({ app, dir: "/apps/" + app, spec: 1, status: "active", agents: [], widgets: [], tasks }),
  };
}

const every = (ms: number) => ({ kind: "every", everyMs: ms }) as const;
const cmd = (command: string) => ({ kind: "command", command }) as const;
const mt = (name: string, over: Partial<Manifest["tasks"][number]> = {}): Manifest["tasks"][number] => ({
  name,
  schedule: every(60_000),
  target: cmd("true"),
  timeoutMs: 1000,
  enabled: true,
  ...over,
});

describe("manifest sync", () => {
  test("creates, updates, orphans and revives tasks idempotently", () => {
    const h = harness();
    let r = h.s.syncManifest(h.manifest([mt("a"), mt("b")]));
    expect(r.created).toEqual(["a", "b"]);
    r = h.s.syncManifest(h.manifest([mt("a"), mt("b")]));
    expect(r).toEqual({ app: "demo", created: [], updated: [], orphaned: [] });

    r = h.s.syncManifest(h.manifest([mt("a", { description: "changed" })]));
    expect(r.updated).toEqual(["a"]);
    expect(r.orphaned).toEqual(["b"]);
    const b = h.store.findTask("demo", "b")!;
    expect(b.orphaned).toBe(true);
    expect(b.state.nextRunAt).toBeUndefined();

    r = h.s.syncManifest(h.manifest([mt("a", { description: "changed" }), mt("b")]));
    expect(r.updated).toEqual(["b"]);
    expect(h.store.findTask("demo", "b")!.orphaned).toBe(false);
  });

  test("operator overrides survive re-sync; schedule change resets nextRunAt", () => {
    const h = harness();
    h.s.syncManifest(h.manifest([mt("a")]));
    const a = h.store.findTask("demo", "a")!;
    h.s.patchTask(a.id, { enabled: false });
    h.s.syncManifest(h.manifest([mt("a", { timeoutMs: 5000 })]));
    const after = h.store.getTask(a.id)!;
    expect(after.timeoutMs).toBe(5000);
    expect(after.overrides.enabled).toBe(false);
    expect(after.enabled).toBe(true);
    expect(after.state.nextRunAt).toBeUndefined();

    h.s.patchTask(a.id, { enabled: null });
    expect(h.store.getTask(a.id)!.state.nextRunAt).toBe(h.at());

    h.advance(10_000);
    h.s.syncManifest(h.manifest([mt("a", { schedule: every(5_000), timeoutMs: 5000 })]));
    const rescheduled = h.store.getTask(a.id)!;
    expect(rescheduled.schedule).toEqual({ kind: "every", everyMs: 5_000, anchorMs: h.at() });
    expect(rescheduled.state.nextRunAt).toBe(h.at());
  });
});

describe("tick and run", () => {
  test("interval task runs immediately on first sync, then on its interval", async () => {
    const h = harness();
    h.s.syncManifest(h.manifest([mt("a")]));
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual(["a"]);
    const t1 = h.store.findTask("demo", "a")!;
    expect(t1.state.lastStatus).toBe("ok");
    expect(t1.state.nextRunAt).toBe(h.at() + 60_000);
    expect(h.store.listRuns(t1.id)).toHaveLength(1);

    h.advance(30_000);
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual(["a"]);

    h.advance(30_000);
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual(["a", "a"]);
  });

  test("cron task waits for its natural moment", async () => {
    const h = harness();
    h.s.syncManifest(h.manifest([mt("c", { schedule: { kind: "cron", expr: "30 0 * * *" } })]));
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual([]);
    h.advance(30 * 60_000);
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual(["c"]);
    expect(h.store.findTask("demo", "c")!.state.nextRunAt).toBe(h.at() + 24 * 3_600_000);
  });

  test("errors back off and reset on success", async () => {
    let fail = true;
    const h = harness({
      runner: async () => (fail ? { status: "error", error: "boom" } : { status: "ok" }),
    });
    h.s.syncManifest(h.manifest([mt("e", { schedule: every(1000) })]));
    await h.s.tick();
    await h.s.idle();
    let e = h.store.findTask("demo", "e")!;
    expect(e.state.consecutiveErrors).toBe(1);
    expect(e.state.lastError).toBe("boom");
    expect(e.state.nextRunAt).toBe(h.at() + 30_000);

    h.advance(30_000);
    await h.s.tick();
    await h.s.idle();
    e = h.store.findTask("demo", "e")!;
    expect(e.state.consecutiveErrors).toBe(2);
    expect(e.state.nextRunAt).toBe(h.at() + 60_000);

    fail = false;
    h.advance(60_000);
    await h.s.tick();
    await h.s.idle();
    e = h.store.findTask("demo", "e")!;
    expect(e.state.consecutiveErrors).toBe(0);
    expect(e.state.lastStatus).toBe("ok");
    expect(e.state.nextRunAt).toBe(h.at() + 1000);
    expect(h.store.listRuns(e.id).map((r) => r.status)).toEqual(["ok", "error", "error"]);
  });

  test("a running task is never launched twice and the concurrency limit holds", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const started: string[] = [];
    const h = harness({
      maxConcurrency: 1,
      runner: async (task) => {
        started.push(task.name);
        await gate;
        return { status: "ok" };
      },
    });
    h.s.syncManifest(h.manifest([mt("x", { schedule: every(1000) }), mt("y", { schedule: every(1000) })]));
    await h.s.tick();
    expect(started).toEqual(["x"]);
    await h.s.tick();
    await h.s.tick();
    expect(started).toEqual(["x"]);
    expect(h.s.runNow(h.store.findTask("demo", "x")!.id)).toBe(false);

    release();
    await h.s.idle();
    // finishing x re-ticks and picks up y with the freed slot
    expect(started).toEqual(["x", "y"]);
  });

  test("timeout aborts the run and records an error", async () => {
    const h = harness({
      runner: (_task, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve({ status: "error", error: "timed out" }));
        }),
    });
    h.s.syncManifest(h.manifest([mt("slow", { timeoutMs: 20 })]));
    await h.s.tick();
    await h.s.idle();
    const slow = h.store.findTask("demo", "slow")!;
    expect(slow.state.lastStatus).toBe("error");
    expect(slow.state.lastError).toBe("timed out");
  });

  test("runNow forces a disabled task and start clears stale markers", async () => {
    const h = harness();
    h.s.syncManifest(h.manifest([mt("d", { enabled: false })]));
    const d = h.store.findTask("demo", "d")!;
    expect(d.state.nextRunAt).toBeUndefined();
    expect(h.s.runNow(d.id)).toBe(true);
    await h.s.idle();
    expect(h.calls).toEqual(["d"]);

    // simulate a crash mid-run
    const crashed = h.store.getTask(d.id)!;
    crashed.state.runningAt = h.at();
    h.store.saveState(crashed.id, crashed.state, h.at());
    const s2 = new Scheduler({ store: h.store, now: h.at, runner: async () => ({ status: "ok" }), log: () => {} });
    await s2.start();
    expect(h.store.getTask(d.id)!.state.runningAt).toBeUndefined();
    s2.stop();
  });

  test("one-shot task runs once and then has no next run", async () => {
    const h = harness();
    const at = new Date(h.at() + 5000).toISOString();
    const task = h.s.addTask({ app: "demo", name: "once", schedule: { kind: "at", at }, target: cmd("true") });
    expect(task.source).toBe("api");
    expect(task.state.nextRunAt).toBe(h.at() + 5000);
    h.advance(5000);
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual(["once"]);
    expect(h.store.getTask(task.id)!.state.nextRunAt).toBeUndefined();
    expect(h.s.removeTask(task.id)).toBe(true);
  });

  test("manifest tasks cannot be removed through the API unless orphaned", () => {
    const h = harness();
    h.s.syncManifest(h.manifest([mt("m")]));
    const m = h.store.findTask("demo", "m")!;
    expect(() => h.s.removeTask(m.id)).toThrow(/space.yaml/);
    h.s.syncManifest(h.manifest([]));
    expect(h.s.removeTask(m.id)).toBe(true);
  });

  test("runner exceptions become error runs", async () => {
    const h = harness({
      runner: async () => {
        throw new Error("kaboom");
      },
    });
    h.s.syncManifest(h.manifest([mt("k")]));
    await h.s.tick();
    await h.s.idle();
    const k: Task = h.store.findTask("demo", "k")!;
    expect(k.state.lastStatus).toBe("error");
    expect(k.state.lastError).toBe("kaboom");
  });
});

describe("events", () => {
  const manual = { kind: "manual" } as const;
  const trig = (event: string, over: Partial<{ debounceMs: number; filter: Record<string, string | string[]> }> = {}) => ({ event, ...over });

  test("a trigger-only task has no clock and runs when a matching event is published", async () => {
    const seen: { name: string; trigger?: string; events?: string[] }[] = [];
    const h = harness({
      runner: async (task, ctx) => {
        seen.push({ name: task.name, trigger: ctx.trigger, events: ctx.events?.map((e) => e.name) });
        return { status: "ok" };
      },
    });
    h.s.syncManifest(h.manifest([mt("curate", { schedule: manual, triggers: [trig("feed/item.added", { filter: { channel: ["a", "b"] } })] })]));
    const task = h.store.findTask("demo", "curate")!;
    expect(task.state.nextRunAt).toBeUndefined();
    expect(task.triggers).toEqual([{ event: "feed/item.added", filter: { channel: ["a", "b"] } }]);

    expect(h.s.publish({ app: "feed", name: "item.added", data: { channel: "z" } }).matched).toEqual([]);
    expect(h.s.publish({ app: "other", name: "item.added", data: { channel: "a" } }).matched).toEqual([]);
    const { event, matched } = h.s.publish({ app: "feed", name: "item.added", data: { channel: "a" } });
    expect(matched.map((t) => t.name)).toEqual(["curate"]);
    await h.s.idle();
    expect(seen).toEqual([{ name: "curate", trigger: "event", events: ["feed/item.added"] }]);
    const run = h.store.listRuns(task.id)[0]!;
    expect(run.trigger).toBe("event");
    expect(run.eventIds).toEqual([event.id]);
    expect(h.store.getTask(task.id)!.state.pending).toBeUndefined();
    expect(h.store.getTask(task.id)!.state.nextRunAt).toBeUndefined();
  });

  test("debounce coalesces a burst into one run after the quiet period", async () => {
    const h = harness();
    h.s.syncManifest(h.manifest([mt("t", { schedule: manual, triggers: [trig("feed/*", { debounceMs: 5000 })] })]));
    h.s.publish({ app: "feed", name: "a" });
    h.advance(3000);
    h.s.publish({ app: "feed", name: "b" });
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual([]);
    const pending = h.store.findTask("demo", "t")!.state.pending!;
    expect(pending.eventIds).toHaveLength(2);
    expect(pending.dueAt).toBe(h.at() + 5000);
    h.advance(5000);
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual(["t"]);
    expect(h.store.listRuns(h.store.findTask("demo", "t")!.id)[0]!.eventIds).toHaveLength(2);
  });

  test("events during a run queue one more run, and a clock run takes pending events along", async () => {
    let release: () => void = () => {};
    let gate = new Promise<void>((r) => (release = r));
    const runs: { trigger?: string; n: number }[] = [];
    const h = harness({
      runner: async (_task, ctx) => {
        runs.push({ trigger: ctx.trigger, n: ctx.events?.length ?? 0 });
        await gate;
        return { status: "ok" };
      },
    });
    // A long debounce: events alone would not start a run before the clock does.
    h.s.syncManifest(h.manifest([mt("t", { schedule: every(60_000), triggers: [trig("feed/*", { debounceMs: 120_000 })] })]));
    await h.s.tick(); // first interval run, right away
    expect(runs).toEqual([{ trigger: "schedule", n: 0 }]);
    h.s.publish({ app: "feed", name: "a" });
    h.s.publish({ app: "feed", name: "b" });
    await h.s.tick();
    expect(runs).toHaveLength(1); // still running: not launched again
    release();
    await h.s.idle();
    expect(runs).toHaveLength(1); // the events wait for their quiet period
    h.advance(120_000);
    gate = new Promise<void>((r) => (release = r));
    await h.s.tick();
    expect(runs).toHaveLength(2); // the interval is due too; the run is the clock's and carries both events
    expect(runs[1]).toEqual({ trigger: "schedule", n: 2 });
    release();
    await h.s.idle();
    expect(h.store.listRuns(h.store.findTask("demo", "t")!.id)[0]).toMatchObject({ trigger: "schedule", eventIds: [expect.any(Number), expect.any(Number)] });

    // Neither due: an event inside its quiet period, the interval half way. Nothing starts.
    h.s.publish({ app: "feed", name: "c" });
    h.advance(30_000);
    await h.s.tick();
    await h.s.idle();
    expect(runs).toHaveLength(2);
    expect(h.store.findTask("demo", "t")!.state.pending?.eventIds).toHaveLength(1);
  });

  test("disabled and orphaned tasks are not queued; disabling drops pending events", async () => {
    const h = harness();
    h.s.syncManifest(h.manifest([mt("t", { schedule: manual, triggers: [trig("feed/*", { debounceMs: 1000 })] })]));
    const id = h.store.findTask("demo", "t")!.id;
    h.s.publish({ app: "feed", name: "a" });
    expect(h.store.getTask(id)!.state.pending?.eventIds).toHaveLength(1);
    h.s.patchTask(id, { enabled: false });
    expect(h.store.getTask(id)!.state.pending).toBeUndefined();
    expect(h.s.publish({ app: "feed", name: "b" }).matched).toEqual([]);
    h.s.patchTask(id, { enabled: null });
    h.s.syncManifest(h.manifest([]));
    expect(h.s.publish({ app: "feed", name: "c" }).matched).toEqual([]);
    h.advance(2000);
    await h.s.tick();
    await h.s.idle();
    expect(h.calls).toEqual([]);
  });

  test("manifest sync updates triggers and rejects a task with neither clock nor triggers", () => {
    const h = harness();
    h.s.syncManifest(h.manifest([mt("t", { schedule: manual, triggers: [trig("feed/a")] })]));
    const r = h.s.syncManifest(h.manifest([mt("t", { schedule: manual, triggers: [trig("feed/b")] })]));
    expect(r.updated).toEqual(["t"]);
    expect(h.store.findTask("demo", "t")!.triggers).toEqual([{ event: "feed/b" }]);
    expect(() => h.s.syncManifest(h.manifest([mt("u", { schedule: manual })]))).toThrow(/neither a schedule nor triggers/);
    expect(() => h.s.addTask({ app: "demo", name: "v", schedule: manual, target: cmd("true"), triggers: [{ event: "bad" }] })).toThrow(/expected <app>\/<event>/);
  });
});

describe("built-in apps", () => {
  test("forget leaves a built-in app's tasks alone", () => {
    const h = harness();
    h.s.syncBuiltin(h.manifest([{ name: "backup", schedule: every(60_000), target: cmd("true"), timeoutMs: 1000, enabled: true }], "space"));
    h.s.syncManifest(h.manifest([{ name: "job", schedule: every(60_000), target: cmd("true"), timeoutMs: 1000, enabled: true }]));
    expect(h.s.forget("space")).toBeUndefined();
    expect(h.s.forget("demo")?.orphaned).toEqual(["job"]);
    expect(h.store.findTask("space", "backup")?.orphaned).toBe(false);
    expect(h.s.apps()).toEqual(["space"]);
    expect(h.s.isBuiltin("space")).toBe(true);
  });
});
