import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpolate, loadAppEnv, runTarget } from "./targets.ts";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let appDir = "";

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/ok") {
        const body = await req.text();
        return Response.json({ got: body, auth: req.headers.get("authorization") });
      }
      if (url.pathname === "/echo") return Response.json({ body: await req.text(), trigger: req.headers.get("x-space-trigger") });
      if (url.pathname === "/fail") return new Response("nope", { status: 500 });
      if (url.pathname === "/verdict") return Response.json({ status: "skipped", error: "already running" });
      if (url.pathname === "/slow") {
        await Bun.sleep(2000);
        return new Response("late");
      }
      return new Response("404", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  appDir = await mkdtemp(join(tmpdir(), "space-targets-"));
  await writeFile(join(appDir, ".env"), 'GREETING="from dotenv"\n# comment\nexport OTHER=1\n');
  await writeFile(join(appDir, "prompt.md"), "hello agent");
});

afterAll(() => server.stop(true));

const ctx = (timeoutMs = 1000) => ({ appDir, signal: AbortSignal.timeout(timeoutMs) });

describe("http target", () => {
  test("posts JSON body with interpolated headers", async () => {
    process.env.T_TOKEN = "secret";
    const r = await runTarget(
      { kind: "http", method: "POST", url: `${base}/ok`, headers: { authorization: "Bearer ${T_TOKEN}" }, body: { task: "x" } },
      ctx(),
    );
    expect(r.status).toBe("ok");
    expect(JSON.parse(r.output!)).toEqual({ got: '{"task":"x"}', auth: "Bearer secret" });
  });

  test("a 2xx JSON body can carry its own verdict", async () => {
    const r = await runTarget({ kind: "http", method: "POST", url: `${base}/verdict` }, ctx());
    expect(r.status).toBe("skipped");
    expect(r.error).toBe("already running");
  });

  test("non-2xx is an error with the body kept", async () => {
    const r = await runTarget({ kind: "http", method: "GET", url: `${base}/fail` }, ctx());
    expect(r).toEqual({ status: "error", error: "HTTP 500", output: "nope" });
  });

  test("timeout aborts the request", async () => {
    const r = await runTarget({ kind: "http", method: "GET", url: `${base}/slow` }, ctx(200));
    expect(r.status).toBe("error");
    expect(r.error).toBe("timed out");
  });

  test("missing env var in url fails cleanly", async () => {
    const r = await runTarget({ kind: "http", method: "GET", url: "http://${NOPE_MISSING}/x" }, ctx());
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/NOPE_MISSING/);
  });
});

describe("command target", () => {
  test("runs in the app dir with .env loaded", async () => {
    const r = await runTarget({ kind: "command", command: 'echo "$GREETING $OTHER" && pwd' }, ctx());
    expect(r.status).toBe("ok");
    expect(r.output).toContain("from dotenv 1");
    expect(r.output).toContain(appDir);
  });

  test("command strings get ${VAR} interpolation from the scheduler env", async () => {
    process.env.T_ECHO = "printf";
    const r = await runTarget({ kind: "command", command: "${T_ECHO} ${T_MISSING:-fallback}" }, ctx());
    expect(r.status).toBe("ok");
    expect(r.output).toBe("fallback");
  });

  test("non-zero exit is an error with stderr captured", async () => {
    const r = await runTarget({ kind: "command", command: "echo bad >&2; exit 3" }, ctx());
    expect(r.status).toBe("error");
    expect(r.error).toBe("exit code 3");
    expect(r.output).toContain("bad");
  });

  test("timeout kills the process", async () => {
    const r = await runTarget({ kind: "command", command: "sleep 5" }, ctx(200));
    expect(r.status).toBe("error");
    expect(r.error).toBe("timed out");
  });
});

describe("agent target", () => {
  test("feeds the prompt file on stdin to the runtime", async () => {
    process.env.SPACE_AGENT_BIN_CLAUDE = "cat";
    const r = await runTarget({ kind: "agent", runtime: "claude", prompt: "prompt.md" }, ctx());
    delete process.env.SPACE_AGENT_BIN_CLAUDE;
    expect(r.status).toBe("ok");
    expect(r.output).toBe("hello agent");
  });

  test("missing prompt file is an error", async () => {
    const r = await runTarget({ kind: "agent", runtime: "claude", prompt: "nope.md" }, ctx());
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/prompt file not found/);
  });
});

describe("events in a run", () => {
  const events = [
    { id: 1, name: "feed/a", app: "feed", data: { i: 1 }, at: 0 },
    { id: 2, name: "feed/b", app: "feed", data: { i: 2 }, at: 1000 },
  ];

  test("http: events merge into a JSON body, the trigger rides in a header", async () => {
    const r = await runTarget({ kind: "http", method: "POST", url: `${base}/echo`, body: { job: "x" } }, { ...ctx(), trigger: "event", events });
    const got = JSON.parse(r.output!);
    expect(got.trigger).toBe("event");
    const body = JSON.parse(got.body);
    expect(body.job).toBe("x");
    expect(body.event).toEqual({ name: "feed/b", app: "feed", at: "1970-01-01T00:00:01.000Z", data: { i: 2 } });
    expect(body.events).toHaveLength(2);
    // No body declared: the events are the body. A string body is left alone. GET sends none.
    expect(JSON.parse(JSON.parse((await runTarget({ kind: "http", method: "POST", url: `${base}/echo` }, { ...ctx(), events })).output!).body).events).toHaveLength(2);
    expect(JSON.parse((await runTarget({ kind: "http", method: "POST", url: `${base}/echo`, body: "raw" }, { ...ctx(), events })).output!).body).toBe("raw");
    const get = JSON.parse((await runTarget({ kind: "http", method: "GET", url: `${base}/echo` }, { ...ctx(), events })).output!);
    expect(get.body).toBe("");
    expect(get.trigger).toBe("schedule");
  });

  test("command: SPACE_TRIGGER, SPACE_EVENT and SPACE_EVENTS", async () => {
    const r = await runTarget({ kind: "command", command: 'echo "$SPACE_TRIGGER|$SPACE_EVENT|$SPACE_EVENTS"' }, { ...ctx(), trigger: "event", events });
    expect(r.status).toBe("ok");
    const [trigger, last, all] = r.output!.split("|");
    expect(trigger).toBe("event");
    expect(JSON.parse(last!).name).toBe("feed/b");
    expect(JSON.parse(all!)).toHaveLength(2);
    expect((await runTarget({ kind: "command", command: 'echo "$SPACE_TRIGGER|$SPACE_EVENT"' }, ctx())).output).toBe("schedule|");
  });

  test("agent: the prompt ends with an Events section", async () => {
    process.env.SPACE_AGENT_BIN_CLAUDE = "cat";
    const r = await runTarget({ kind: "agent", runtime: "claude", prompt: "prompt.md" }, { ...ctx(), trigger: "event", events });
    delete process.env.SPACE_AGENT_BIN_CLAUDE;
    expect(r.output).toStartWith("hello agent");
    expect(r.output).toContain("## Events");
    expect(r.output).toContain('"name": "feed/a"');
  });
});

describe("env helpers", () => {
  test("interpolate supports defaults and errors on missing", () => {
    expect(interpolate("a ${X:-dflt} b", {})).toBe("a dflt b");
    expect(interpolate("${X}", { X: "1" })).toBe("1");
    expect(() => interpolate("${X}", {})).toThrow(/missing environment variable X/);
  });

  test("loadAppEnv parses quotes, comments and export", async () => {
    expect(await loadAppEnv(appDir)).toEqual({ GREETING: "from dotenv", OTHER: "1" });
    expect(await loadAppEnv("/definitely/not/here")).toEqual({});
  });
});

describe("extra env from the scheduler", () => {
  test("ctx.env layers over the app .env for command and agent targets", async () => {
    const r = await runTarget(
      { kind: "command", command: "echo $GREETING/$DATABASE_URL" },
      { ...ctx(), env: { GREETING: "from space", DATABASE_URL: "sqlite:///x.db" } },
    );
    expect(r.status).toBe("ok");
    expect(r.output).toBe("from space/sqlite:///x.db");
  });
});
