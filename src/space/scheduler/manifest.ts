import { basename, join } from "node:path";
import { assertSchedule, parseDuration } from "./schedule.ts";
import { DEFAULT_TIMEOUT_MS, type Schedule, type Target } from "./types.ts";

/**
 * App manifest (`space.yaml`) parsing.
 *
 * Only the `tasks` section is interpreted here; `storage` is passed through raw
 * for the storage service. Each task declares one
 * schedule form (`at` / `every` / `schedule` for cron) and one `run` target
 * (`http` / `command` / `agent`). Parsing is strict: a bad manifest rejects
 * the whole app so nothing partially applies.
 */

export const MANIFEST_FILE = "space.yaml";

export type ManifestTask = {
  name: string;
  description?: string;
  schedule: Schedule;
  target: Target;
  timeoutMs: number;
  enabled: boolean;
};

export type Manifest = {
  app: string;
  dir: string;
  tasks: ManifestTask[];
  /** Raw `storage:` section, interpreted by the storage service. */
  storage?: unknown;
};

export async function loadManifest(dir: string): Promise<Manifest> {
  const file = Bun.file(join(dir, MANIFEST_FILE));
  if (!(await file.exists())) throw new Error(`${MANIFEST_FILE} not found in ${dir}`);
  return parseManifest(await file.text(), dir);
}

export function parseManifest(yaml: string, dir: string): Manifest {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(yaml);
  } catch (e) {
    throw new Error(`invalid YAML: ${(e as Error).message}`);
  }
  if (!isRecord(doc)) throw new Error("manifest must be a mapping");
  const app = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : basename(dir);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(app)) throw new Error(`invalid app name: ${app}`);

  const rawTasks = doc.tasks ?? [];
  if (!Array.isArray(rawTasks)) throw new Error("tasks must be a list");
  const tasks: ManifestTask[] = [];
  const seen = new Set<string>();
  rawTasks.forEach((raw, i) => {
    const t = parseTask(raw, i);
    if (seen.has(t.name)) throw new Error(`duplicate task name: ${t.name}`);
    seen.add(t.name);
    tasks.push(t);
  });
  return { app, dir, tasks, ...(doc.storage !== undefined ? { storage: doc.storage } : {}) };
}

function parseTask(raw: unknown, index: number): ManifestTask {
  const where = `tasks[${index}]`;
  if (!isRecord(raw)) throw new Error(`${where} must be a mapping`);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`${where}: invalid or missing name`);
  const ctx = `task "${name}"`;

  const schedule = parseSchedule(raw, ctx);
  assertSchedule(schedule);
  const target = parseTarget(raw.run, ctx);
  const timeoutMs = raw.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(raw.timeout as string | number);
  const enabled = raw.enabled === undefined ? true : raw.enabled === true;
  const description = typeof raw.description === "string" ? raw.description : undefined;
  return { name, description, schedule, target, timeoutMs, enabled };
}

function parseSchedule(raw: Record<string, unknown>, ctx: string): Schedule {
  const forms = ["at", "every", "schedule"].filter((k) => raw[k] !== undefined);
  if (forms.length !== 1) throw new Error(`${ctx}: declare exactly one of at / every / schedule`);
  if (raw.at !== undefined) {
    if (typeof raw.at !== "string") throw new Error(`${ctx}: at must be an ISO timestamp string`);
    return { kind: "at", at: raw.at };
  }
  if (raw.every !== undefined) {
    return { kind: "every", everyMs: parseDuration(raw.every as string | number) };
  }
  if (typeof raw.schedule !== "string") throw new Error(`${ctx}: schedule must be a cron expression string`);
  const tz = raw.timezone ?? raw.tz;
  if (tz !== undefined && typeof tz !== "string") throw new Error(`${ctx}: timezone must be a string`);
  return { kind: "cron", expr: raw.schedule, ...(tz ? { tz } : {}) };
}

function parseTarget(run: unknown, ctx: string): Target {
  if (!isRecord(run)) throw new Error(`${ctx}: run must be a mapping with http / command / agent`);
  const kinds = ["http", "command", "agent"].filter((k) => run[k] !== undefined);
  if (kinds.length !== 1) throw new Error(`${ctx}: run must declare exactly one of http / command / agent`);

  if (run.command !== undefined) {
    if (typeof run.command !== "string" || !run.command.trim()) throw new Error(`${ctx}: run.command must be a string`);
    const env = run.env;
    if (env !== undefined && !isStringMap(env)) throw new Error(`${ctx}: run.env must map strings to strings`);
    return { kind: "command", command: run.command, ...(env ? { env } : {}) };
  }

  if (run.http !== undefined) {
    const h = run.http;
    if (!isRecord(h) || typeof h.url !== "string") throw new Error(`${ctx}: run.http needs a url`);
    const method = String(h.method ?? "POST").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error(`${ctx}: unsupported method ${method}`);
    if (h.headers !== undefined && !isStringMap(h.headers)) throw new Error(`${ctx}: run.http.headers must map strings to strings`);
    return {
      kind: "http",
      method: method as Extract<Target, { kind: "http" }>["method"],
      url: h.url,
      ...(h.headers ? { headers: h.headers } : {}),
      ...(h.body !== undefined ? { body: h.body } : {}),
    };
  }

  const a = run.agent;
  if (!isRecord(a) || typeof a.prompt !== "string") throw new Error(`${ctx}: run.agent needs a prompt path`);
  const runtime = a.runtime ?? "claude";
  if (runtime !== "claude" && runtime !== "codex") throw new Error(`${ctx}: run.agent.runtime must be claude or codex`);
  if (a.model !== undefined && typeof a.model !== "string") throw new Error(`${ctx}: run.agent.model must be a string`);
  return { kind: "agent", runtime, prompt: a.prompt, ...(a.model ? { model: a.model } : {}) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringMap(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === "string");
}
