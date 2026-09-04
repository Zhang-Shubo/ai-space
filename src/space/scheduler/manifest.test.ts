import { describe, expect, test } from "bun:test";
import { parseManifest } from "./manifest.ts";

const GOOD = `
name: demo
tasks:
  - name: market
    every: 30m
    run:
      http: { method: POST, url: "http://127.0.0.1:8799/space/run", headers: { x-write-token: "\${TOKEN:-none}" }, body: { task: market } }
  - name: daily
    schedule: "30 14 * * *"
    timezone: Asia/Seoul
    timeout: 40m
    enabled: false
    description: daily digest
    run:
      agent: { prompt: scripts/daily.md, model: sonnet }
  - name: backup
    at: "2030-01-01T00:00:00Z"
    run:
      command: bun scripts/backup.ts
`;

describe("parseManifest", () => {
  test("parses all three schedule forms and target kinds", () => {
    const m = parseManifest(GOOD, "/apps/demo");
    expect(m.app).toBe("demo");
    expect(m.tasks).toHaveLength(3);

    const [market, daily, backup] = m.tasks;
    expect(market?.schedule).toEqual({ kind: "every", everyMs: 30 * 60_000 });
    expect(market?.target).toEqual({
      kind: "http",
      method: "POST",
      url: "http://127.0.0.1:8799/space/run",
      headers: { "x-write-token": "${TOKEN:-none}" },
      body: { task: "market" },
    });
    expect(market?.enabled).toBe(true);
    expect(market?.timeoutMs).toBe(10 * 60_000);

    expect(daily?.schedule).toEqual({ kind: "cron", expr: "30 14 * * *", tz: "Asia/Seoul" });
    expect(daily?.target).toEqual({ kind: "agent", runtime: "claude", prompt: "scripts/daily.md", model: "sonnet" });
    expect(daily?.enabled).toBe(false);
    expect(daily?.timeoutMs).toBe(40 * 60_000);
    expect(daily?.description).toBe("daily digest");

    expect(backup?.schedule).toEqual({ kind: "at", at: "2030-01-01T00:00:00Z" });
    expect(backup?.target).toEqual({ kind: "command", command: "bun scripts/backup.ts" });
  });

  test("app name falls back to the directory name", () => {
    expect(parseManifest("tasks: []", "/apps/my-app").app).toBe("my-app");
  });

  test("rejects the whole manifest on any bad task", () => {
    expect(() => parseManifest("tasks:\n  - name: a\n    run: { command: x }", "/d")).toThrow(/exactly one of at/);
    expect(() => parseManifest("tasks:\n  - name: a\n    every: 1m\n    every2: 1m\n    run: {}", "/d")).toThrow(/exactly one of http/);
    expect(() => parseManifest("tasks:\n  - name: a\n    every: 1m\n    run: { command: x, http: { url: u } }", "/d")).toThrow(/exactly one of http/);
    expect(() => parseManifest("tasks:\n  - name: a\n    schedule: 'bad cron'\n    run: { command: x }", "/d")).toThrow(/invalid cron/);
    expect(() => parseManifest("tasks:\n  - name: a\n    every: 1m\n    run: { command: x }\n  - name: a\n    every: 1m\n    run: { command: y }", "/d")).toThrow(/duplicate/);
    expect(() => parseManifest("tasks:\n  - name: 'bad name'\n    every: 1m\n    run: { command: x }", "/d")).toThrow(/invalid or missing name/);
    expect(() => parseManifest("tasks:\n  - name: a\n    every: 1m\n    run: { agent: { prompt: p, runtime: gpt } }", "/d")).toThrow(/runtime/);
    expect(() => parseManifest("tasks: {}", "/d")).toThrow(/tasks must be a list/);
    expect(() => parseManifest("- not a mapping", "/d")).toThrow(/mapping/);
  });
});
