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
