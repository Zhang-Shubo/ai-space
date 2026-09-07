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

test("the storage section is passed through raw for the storage service", () => {
  const m = parseManifest("name: demo\nstorage:\n  databases: [news, { name: cache }]\ntasks: []\n", "/x");
  expect(m.storage).toEqual({ databases: ["news", { name: "cache" }] });
  expect("storage" in parseManifest("name: demo\ntasks: []\n", "/x")).toBe(false);
});

describe("parseManifest top level", () => {
  const FULL = `
spec: 1
name: notes
title: Notes
description: Personal notes.
icon: icon.svg
url: https://notes.example.com
status: paused
repo: https://github.com/example/notes.git
service:
  command: bun src/index.ts
  port: 8710
  health: /healthz
  env: { LOG_LEVEL: info }
agents:
  - name: librarian
    description: Files notes.
    prompt: agents/librarian.md
    tools: [Read, "Bash(bun *)"]
    skills: [./skills, space:keep]
widgets:
  - name: recent
    title: Notes · Recent
    source: /api/widget/recent
    link: /#recent
    size: 2x1
    refresh: 2m
  - name: board
    kind: embed
    source: https://127.0.0.1:8710/board
`;

  test("parses identity, service, agents and widgets with defaults", () => {
    const m = parseManifest(FULL, "/apps/notes");
    expect(m).toMatchObject({ app: "notes", spec: 1, title: "Notes", url: "https://notes.example.com", status: "paused", repo: "https://github.com/example/notes.git" });
    expect(m.service).toEqual({ command: "bun src/index.ts", port: 8710, health: "/healthz", env: { LOG_LEVEL: "info" } });
    expect(m.agents[0]).toEqual({ name: "librarian", title: "librarian", description: "Files notes.", runtime: "claude", prompt: "agents/librarian.md", cwd: ".", tools: ["Read", "Bash(bun *)"], skills: ["./skills", "space:keep"], memory: "shared" });
    expect(m.widgets[0]).toEqual({ name: "recent", title: "Notes · Recent", kind: "items", source: "/api/widget/recent", link: "/#recent", size: "2x1", refreshMs: 120_000 });
    expect(m.widgets[1]).toMatchObject({ kind: "embed", size: "1x1", refreshMs: 60_000 });
  });

  test("parses i18n by language tag and only for declared names", () => {
    const base = "name: notes\ntitle: Notes\nagents:\n  - name: librarian\nwidgets:\n  - name: recent\n    source: /w\n";
    const m = parseManifest(`${base}i18n:\n  zh:\n    title: 笔记\n    description: 个人笔记。\n    agents:\n      librarian: { title: 图书管理员, description: 归档笔记。 }\n    widgets:\n      recent: { title: 最近 }\n  zh-Hant:\n    title: 筆記\n`, "/apps/notes");
    expect(m.i18n).toEqual({
      zh: { title: "笔记", description: "个人笔记。", agents: { librarian: { title: "图书管理员", description: "归档笔记。" } }, widgets: { recent: { title: "最近" } } },
      "zh-Hant": { title: "筆記" },
    });
    // Empty entries are dropped rather than kept as empty mappings.
    expect("i18n" in parseManifest(`${base}i18n:\n  zh: {}\n`, "/apps/notes")).toBe(false);
    expect(() => parseManifest(`${base}i18n: zh\n`, "/d")).toThrow(/i18n must map/);
    expect(() => parseManifest(`${base}i18n:\n  Chinese: { title: x }\n`, "/d")).toThrow(/not a language tag/);
    expect(() => parseManifest(`${base}i18n:\n  zh: { name: x }\n`, "/d")).toThrow(/unknown key "name"/);
    expect(() => parseManifest(`${base}i18n:\n  zh: { title: "" }\n`, "/d")).toThrow(/i18n.zh.title must be/);
    expect(() => parseManifest(`${base}i18n:\n  zh:\n    agents: { nobody: { title: x } }\n`, "/d")).toThrow(/no agent named "nobody"/);
    expect(() => parseManifest(`${base}i18n:\n  zh:\n    widgets: { recent: { description: x } }\n`, "/d")).toThrow(/unknown key "description"/);
  });

  test("parses event triggers; a task may have triggers, a schedule, or both", () => {
    const m = parseManifest(
      "name: demo\ntasks:\n  - name: a\n    triggers: feed/item.added\n    run: { command: x }\n  - name: b\n    every: 1h\n    triggers:\n      - feed/*\n      - { event: other/done, filter: { channel: [x, y], n: 3 }, debounce: 5m }\n    run: { command: x }\n",
      "/apps/demo",
    );
    expect(m.tasks[0]).toMatchObject({ name: "a", schedule: { kind: "manual" }, triggers: [{ event: "feed/item.added" }] });
    expect(m.tasks[1]).toMatchObject({
      name: "b",
      schedule: { kind: "every", everyMs: 3_600_000 },
      triggers: [{ event: "feed/*" }, { event: "other/done", filter: { channel: ["x", "y"], n: "3" }, debounceMs: 300_000 }],
    });
    expect("triggers" in parseManifest("name: demo\ntasks:\n  - name: a\n    every: 1h\n    run: { command: x }\n", "/d").tasks[0]!).toBe(false);
    const bad = (tasks: string) => () => parseManifest(`name: demo\ntasks:\n  - name: a\n${tasks}    run: { command: x }\n`, "/d");
    expect(bad("")).toThrow(/exactly one of at \/ every \/ schedule, or triggers/);
    expect(bad("    triggers: []\n")).toThrow(/at least one event/);
    expect(bad("    triggers: item.added\n")).toThrow(/expected <app>\/<event>/);
    expect(bad("    triggers: [{ event: feed/a, on: x }]\n")).toThrow(/unknown key/);
    expect(bad("    triggers: [{ event: feed/a, filter: { k: {} } }]\n")).toThrow(/filter.k must be/);
    expect(bad("    triggers: [{ event: feed/a, debounce: soon }]\n")).toThrow(/invalid duration/);
    expect(bad("    at: 2030-01-01T00:00:00Z\n    every: 1h\n    triggers: feed/a\n")).toThrow(/or none, with triggers/);
  });

  test("applies defaults on an empty manifest", () => {
    const m = parseManifest("", "/apps/bare");
    expect(m).toMatchObject({ app: "bare", spec: 1, status: "active", agents: [], widgets: [], tasks: [] });
    expect("title" in m).toBe(false);
  });

  test("rejects unknown keys, bad values and duplicates", () => {
    expect(() => parseManifest("nme: x", "/d")).toThrow(/unknown top-level key "nme"/);
    expect(() => parseManifest("spec: 2", "/d")).toThrow(/unsupported spec version/);
    expect(() => parseManifest("status: gone", "/d")).toThrow(/status must be/);
    expect(() => parseManifest("url: notes.example.com", "/d")).toThrow(/url must start/);
    expect(() => parseManifest("service: { command: x }", "/d")).toThrow(/service.port/);
    expect(() => parseManifest("service: { command: x, port: 80, health: healthz }", "/d")).toThrow(/service.health/);
    expect(() => parseManifest("agents:\n  - name: A", "/d")).toThrow(/invalid or missing name/);
    expect(() => parseManifest("agents:\n  - name: a\n    runtime: gpt", "/d")).toThrow(/runtime must be/);
    expect(() => parseManifest("agents:\n  - name: a\n  - name: a", "/d")).toThrow(/duplicate agents name/);
    expect(() => parseManifest("widgets:\n  - name: w", "/d")).toThrow(/source is required/);
    expect(() => parseManifest("widgets:\n  - name: w\n    source: api/w", "/d")).toThrow(/source must be/);
    expect(() => parseManifest("widgets:\n  - name: w\n    source: /w\n    refresh: 5s", "/d")).toThrow(/at least 15s/);
    expect(() => parseManifest("widgets:\n  - name: w\n    source: /w\n    size: 3x3", "/d")).toThrow(/size must be/);
  });
});
