import { join } from "node:path";
import type { RunStatus, Target } from "./types.ts";

/**
 * Target runners: turn a task's target into one execution with a timeout.
 *
 * Every runner returns a RunResult and never throws. `output` is truncated so
 * it can be stored with the run record. Command and agent targets run inside
 * the app directory with the app's `.env` merged into the environment.
 */

export type RunResult = {
  status: RunStatus;
  error?: string;
  output?: string;
};

export type RunContext = {
  /** App directory; default cwd for command/agent targets and base for prompt paths. */
  appDir?: string;
  signal: AbortSignal;
};

const MAX_OUTPUT_CHARS = 4000;

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n…(${t.length - max} more chars)` : t;
}

export async function runTarget(target: Target, ctx: RunContext): Promise<RunResult> {
  try {
    switch (target.kind) {
      case "http":
        return await runHttp(target, ctx);
      case "command":
        return await runCommand(target, ctx);
      case "agent":
        return await runAgent(target, ctx);
      default:
        return { status: "error", error: `unknown target kind: ${String((target as { kind: unknown }).kind)}` };
    }
  } catch (e) {
    const err = e as Error;
    if (ctx.signal.aborted || err.name === "TimeoutError" || err.name === "AbortError") {
      return { status: "error", error: "timed out" };
    }
    return { status: "error", error: err.message ?? String(e) };
  }
}

// ---------------------------------------------------------------- http

async function runHttp(target: Extract<Target, { kind: "http" }>, ctx: RunContext): Promise<RunResult> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(target.headers ?? {})) headers[k] = interpolate(v);
  let body: string | undefined;
  if (target.body !== undefined && target.method !== "GET") {
    body = typeof target.body === "string" ? interpolate(target.body) : JSON.stringify(target.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(interpolate(target.url), { method: target.method, headers, body, signal: ctx.signal });
  const raw = await res.text();
  const text = truncate(raw);
  if (!res.ok) return { status: "error", error: `HTTP ${res.status}`, output: text };
  // Light protocol: a 2xx JSON body may carry its own verdict, e.g. an app that
  // skipped a round because the previous one is still running.
  const verdict = parseVerdict(raw);
  if (verdict) return { status: verdict.status, error: verdict.error, output: text };
  return { status: "ok", output: text };
}

function parseVerdict(raw: string): { status: RunStatus; error?: string } | undefined {
  try {
    const v = JSON.parse(raw) as { status?: unknown; error?: unknown };
    if (v?.status === "ok" || v?.status === "error" || v?.status === "skipped") {
      return { status: v.status, error: typeof v.error === "string" ? v.error : undefined };
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

// ---------------------------------------------------------------- command / agent

async function runCommand(target: Extract<Target, { kind: "command" }>, ctx: RunContext): Promise<RunResult> {
  const cwd = target.cwd ?? ctx.appDir ?? process.cwd();
  const env = { ...process.env, ...(await loadAppEnv(cwd)), ...(target.env ?? {}) };
  // ${VAR} placeholders resolve from the scheduler environment, same as http targets,
  // so machine-specific paths (a venv python, a token) stay out of the manifest.
  return spawnAndWait(["sh", "-c", interpolate(target.command)], { cwd, env, signal: ctx.signal });
}

async function runAgent(target: Extract<Target, { kind: "agent" }>, ctx: RunContext): Promise<RunResult> {
  const cwd = target.cwd ?? ctx.appDir ?? process.cwd();
  const promptPath = target.prompt.startsWith("/") ? target.prompt : join(cwd, target.prompt);
  const promptFile = Bun.file(promptPath);
  if (!(await promptFile.exists())) return { status: "error", error: `prompt file not found: ${promptPath}` };
  const prompt = await promptFile.text();
  const env = { ...process.env, ...(await loadAppEnv(cwd)) };
  const cmd = agentCommand(target.runtime, target.model);
  return spawnAndWait(cmd, { cwd, env, signal: ctx.signal, stdin: prompt });
}

/** Command line for an agent runtime; overridable per runtime via SPACE_AGENT_BIN_<RUNTIME> for tests. */
export function agentCommand(runtime: "claude" | "codex", model?: string): string[] {
  const override = process.env[`SPACE_AGENT_BIN_${runtime.toUpperCase()}`];
  if (override) return override.split(/\s+/).filter(Boolean);
  if (runtime === "claude") {
    return ["claude", "-p", "--output-format", "json", ...(model ? ["--model", model] : [])];
  }
  return ["codex", "exec", ...(model ? ["--model", model] : []), "-"];
}

/**
 * Spawn and wait, honoring the abort signal. The child is started in its own
 * process group where `setsid` exists (Linux) so a timeout kills the whole tree,
 * not just the `sh` wrapper; without it (macOS) only the direct child is killed
 * and grandchildren are left to finish on their own. After an abort we stop
 * waiting on the pipes: an orphaned grandchild could otherwise hold stdout open.
 */
async function spawnAndWait(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; signal: AbortSignal; stdin?: string },
): Promise<RunResult> {
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...cmd] : cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const aborted = new Promise<"aborted">((resolve) => opts.signal.addEventListener("abort", () => resolve("aborted"), { once: true }));
  const outcome = await Promise.race([proc.exited, aborted]);

  if (outcome === "aborted") {
    try {
      if (setsid) process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await Promise.race([proc.exited, Bun.sleep(1000)]);
    const partial = await Promise.race([Promise.all([stdout, stderr]), Bun.sleep(200).then(() => ["", ""] as const)]);
    return { status: "error", error: "timed out", output: truncate(joinOutput(partial[0], partial[1])) };
  }

  const output = truncate(joinOutput(await stdout, await stderr));
  if (outcome !== 0) return { status: "error", error: `exit code ${outcome}`, output };
  return { status: "ok", output };
}

function joinOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
}

// ---------------------------------------------------------------- env helpers

/** Resolve `${VAR}` and `${VAR:-default}` from the scheduler's own environment. */
export function interpolate(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    throw new Error(`missing environment variable ${name}`);
  });
}

/** Minimal dotenv reader for an app's `.env`; missing file yields {}. */
export async function loadAppEnv(dir: string): Promise<Record<string, string>> {
  const file = Bun.file(join(dir, ".env"));
  if (!(await file.exists())) return {};
  const out: Record<string, string> = {};
  for (const raw of (await file.text()).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
