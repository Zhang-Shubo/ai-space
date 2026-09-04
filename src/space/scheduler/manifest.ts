import { basename, join } from "node:path";
import { assertSchedule, parseDuration } from "./schedule.ts";
import { DEFAULT_TIMEOUT_MS, TASK_NOTIFY_EVENTS, type Schedule, type Target, type TaskNotify, type TaskNotifyEvent } from "./types.ts";

/**
 * App manifest (`space.yaml`) parsing.
 *
 * The top level (identity, `service`, `agents`, `widgets`) and the `tasks`
 * section are interpreted here; `storage`, `notify` and `skills` are passed
 * through raw for their services. Each task declares one schedule form
 * (`at` / `every` / `schedule` for cron) and one `run` target (`http` /
 * `command` / `agent`). Parsing is strict: an unknown key, a wrong type or a
 * bad value rejects the whole app so nothing partially applies.
 */

export const MANIFEST_FILE = "space.yaml";
export const SPEC_VERSION = 1;

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const TOP_LEVEL_KEYS = ["spec", "name", "title", "description", "icon", "url", "status", "repo", "service", "agents", "widgets", "skills", "tasks", "storage", "notify"];

export type AppStatus = "active" | "paused" | "archived";
export type AgentRuntime = "claude" | "codex";
export type WidgetSize = "1x1" | "2x1" | "2x2";

export type ManifestTask = {
  name: string;
  description?: string;
  schedule: Schedule;
  target: Target;
  timeoutMs: number;
  enabled: boolean;
  notify?: TaskNotify;
};

/** The app's own long-running process. */
export type ManifestService = {
  command: string;
  port: number;
  /** Health path on 127.0.0.1:<port>; undefined = not probed. */
  health?: string;
  env?: Record<string, string>;
};

/** A chat identity the panel can open a session with. */
export type ManifestAgent = {
  name: string;
  title: string;
  description?: string;
  /** Avatar path relative to the app directory, or an emoji; undefined = the app icon. */
  avatar?: string;
  runtime: AgentRuntime;
  model?: string;
  /** System prompt file, relative to the app directory. */
  prompt?: string;
  /** Session working directory, relative to the app directory. */
  cwd: string;
  /** Runtime tool allow-list. */
  tools: string[];
  skills: string[];
  memory: "shared" | "app" | "none";
};

/** A card on the home panel fed by the app. */
export type ManifestWidget = {
  name: string;
  title?: string;
  kind: "items" | "embed";
  /** Path on the app's service or a full URL; never sent to the browser. */
  source: string;
  /** "View all" target, relative to the app's public URL; undefined = the app. */
  link?: string;
  size: WidgetSize;
  refreshMs: number;
};

export type Manifest = {
  app: string;
  dir: string;
  spec: number;
  /** Display name (`title:`); the panel and notifications fall back to the app name. */
  title?: string;
  description?: string;
  /** Repository path to an SVG/PNG, an emoji, or an http(s) URL. */
  icon?: string;
  /** Public entry URL. */
  url?: string;
  status: AppStatus;
  repo?: string;
  service?: ManifestService;
  agents: ManifestAgent[];
  widgets: ManifestWidget[];
  tasks: ManifestTask[];
  /** Raw `storage:` section, interpreted by the storage service. */
  storage?: unknown;
  /** Raw `notify:` section, interpreted by the notify service. */
  notify?: unknown;
};

export async function loadManifest(dir: string): Promise<Manifest> {
  const file = Bun.file(join(dir, MANIFEST_FILE));
  if (!(await file.exists())) throw new Error(`${MANIFEST_FILE} not found in ${dir}`);
  const manifest = parseManifest(await file.text(), dir);
  // `icon:` defaults to icon.svg when the file exists.
  if (manifest.icon === undefined && (await Bun.file(join(dir, "icon.svg")).exists())) manifest.icon = "icon.svg";
  return manifest;
}

export function parseManifest(yaml: string, dir: string): Manifest {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(yaml);
  } catch (e) {
    throw new Error(`invalid YAML: ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isRecord(doc)) throw new Error("manifest must be a mapping");
  for (const key of Object.keys(doc)) if (!TOP_LEVEL_KEYS.includes(key)) throw new Error(`unknown top-level key "${key}"`);

  const spec = doc.spec === undefined ? SPEC_VERSION : doc.spec;
  if (spec !== SPEC_VERSION) throw new Error(`unsupported spec version ${String(spec)} (this ai-space implements ${SPEC_VERSION})`);
  const app = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : basename(dir);
  if (!NAME_RE.test(app)) throw new Error(`invalid app name: ${app}`);

  const title = optionalString(doc.title, "title");
  const description = optionalString(doc.description, "description");
  const icon = optionalString(doc.icon, "icon");
  const url = optionalString(doc.url, "url");
  if (url !== undefined && !/^https?:\/\//.test(url)) throw new Error("url must start with http:// or https://");
  const repo = optionalString(doc.repo, "repo");
  const status = doc.status === undefined ? "active" : doc.status;
  if (status !== "active" && status !== "paused" && status !== "archived") throw new Error("status must be active, paused or archived");

  const service = doc.service === undefined ? undefined : parseService(doc.service);
  const agents = parseList(doc.agents, "agents", parseAgent);
  const widgets = parseList(doc.widgets, "widgets", parseWidget);

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

  return {
    app,
    dir,
    spec,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(url !== undefined ? { url } : {}),
    status,
    ...(repo !== undefined ? { repo } : {}),
    ...(service ? { service } : {}),
    agents,
    widgets,
    tasks,
    ...(doc.storage !== undefined ? { storage: doc.storage } : {}),
    ...(doc.notify !== undefined ? { notify: doc.notify } : {}),
  };
}

// ---------------------------------------------------------------- top-level sections

function parseService(raw: unknown): ManifestService {
  if (!isRecord(raw)) throw new Error("service must be a mapping with command / port");
  for (const key of Object.keys(raw)) if (!["command", "port", "health", "env"].includes(key)) throw new Error(`service has unknown key "${key}"`);
  if (typeof raw.command !== "string" || !raw.command.trim()) throw new Error("service.command must be a string");
  const port = raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("service.port must be an integer between 1 and 65535");
  const health = optionalString(raw.health, "service.health");
  if (health !== undefined && !health.startsWith("/")) throw new Error("service.health must be a path starting with /");
  if (raw.env !== undefined && !isStringMap(raw.env)) throw new Error("service.env must map strings to strings");
  return { command: raw.command.trim(), port, ...(health ? { health } : {}), ...(raw.env ? { env: raw.env as Record<string, string> } : {}) };
}

function parseList<T extends { name: string }>(raw: unknown, section: string, parse: (item: unknown, where: string) => T): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${section} must be a list`);
  const out: T[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const parsed = parse(item, `${section}[${i}]`);
    if (seen.has(parsed.name)) throw new Error(`duplicate ${section} name: ${parsed.name}`);
    seen.add(parsed.name);
    out.push(parsed);
  });
  return out;
}

function parseAgent(raw: unknown, where: string): ManifestAgent {
  if (!isRecord(raw)) throw new Error(`${where} must be a mapping`);
  const keys = ["name", "title", "description", "avatar", "runtime", "model", "prompt", "cwd", "tools", "skills", "memory"];
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`${where} has unknown key "${key}"`);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${where}: invalid or missing name`);
  const ctx = `agent "${name}"`;
  const runtime = raw.runtime ?? "claude";
  if (runtime !== "claude" && runtime !== "codex") throw new Error(`${ctx}: runtime must be claude or codex`);
  const memory = raw.memory ?? "shared";
  if (memory !== "shared" && memory !== "app" && memory !== "none") throw new Error(`${ctx}: memory must be shared, app or none`);
  const tools = stringList(raw.tools, `${ctx}: tools`);
  const skills = stringList(raw.skills, `${ctx}: skills`);
  const title = optionalString(raw.title, `${ctx}: title`) ?? name;
  const description = optionalString(raw.description, `${ctx}: description`);
  const avatar = optionalString(raw.avatar, `${ctx}: avatar`);
  const model = optionalString(raw.model, `${ctx}: model`);
  const prompt = optionalString(raw.prompt, `${ctx}: prompt`);
  const cwd = optionalString(raw.cwd, `${ctx}: cwd`) ?? ".";
  return {
    name,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(avatar !== undefined ? { avatar } : {}),
    runtime,
    ...(model !== undefined ? { model } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    cwd,
    tools,
    skills,
    memory,
  };
}

const MIN_REFRESH_MS = 15_000;

function parseWidget(raw: unknown, where: string): ManifestWidget {
  if (!isRecord(raw)) throw new Error(`${where} must be a mapping`);
  const keys = ["name", "title", "kind", "source", "link", "size", "refresh"];
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`${where} has unknown key "${key}"`);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`${where}: invalid or missing name`);
  const ctx = `widget "${name}"`;
  const kind = raw.kind ?? "items";
  if (kind !== "items" && kind !== "embed") throw new Error(`${ctx}: kind must be items or embed`);
  const source = optionalString(raw.source, `${ctx}: source`);
  if (!source) throw new Error(`${ctx}: source is required`);
  if (!source.startsWith("/") && !/^https?:\/\//.test(source)) throw new Error(`${ctx}: source must be a path starting with / or an http(s) URL`);
  const size = raw.size ?? "1x1";
  if (size !== "1x1" && size !== "2x1" && size !== "2x2") throw new Error(`${ctx}: size must be 1x1, 2x1 or 2x2`);
  const refreshMs = raw.refresh === undefined ? 60_000 : parseDuration(raw.refresh as string | number);
  if (refreshMs < MIN_REFRESH_MS) throw new Error(`${ctx}: refresh must be at least 15s`);
  const title = optionalString(raw.title, `${ctx}: title`);
  const link = optionalString(raw.link, `${ctx}: link`);
  return { name, ...(title !== undefined ? { title } : {}), kind, source, ...(link !== undefined ? { link } : {}), size, refreshMs };
}

// ---------------------------------------------------------------- tasks

function parseTask(raw: unknown, index: number): ManifestTask {
  const where = `tasks[${index}]`;
  if (!isRecord(raw)) throw new Error(`${where} must be a mapping`);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!NAME_RE.test(name)) throw new Error(`${where}: invalid or missing name`);
  const ctx = `task "${name}"`;

  const schedule = parseSchedule(raw, ctx);
  assertSchedule(schedule);
  const target = parseTarget(raw.run, ctx);
  const timeoutMs = raw.timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(raw.timeout as string | number);
  const enabled = raw.enabled === undefined ? true : raw.enabled === true;
  const description = typeof raw.description === "string" ? raw.description : undefined;
  const notify = raw.notify === undefined ? undefined : parseTaskNotify(raw.notify, ctx);
  return { name, description, schedule, target, timeoutMs, enabled, ...(notify ? { notify } : {}) };
}

/**
 * `notify: { when: [error, ok], channel: ops }`; `when` defaults to `[error]`.
 * The key is `when` rather than `on` because YAML 1.1 reads a bare `on` as the
 * boolean true.
 */
export function parseTaskNotify(raw: unknown, ctx: string): TaskNotify {
  if (raw === true) return { when: ["error"] };
  if (!isRecord(raw)) throw new Error(`${ctx}: notify must be a mapping with when / channel`);
  for (const key of Object.keys(raw)) if (key !== "when" && key !== "channel") throw new Error(`${ctx}: notify has unknown key "${key}"`);
  const when = raw.when === undefined ? ["error"] : Array.isArray(raw.when) ? raw.when : [raw.when];
  if (when.length === 0) throw new Error(`${ctx}: notify.when must name at least one of ${TASK_NOTIFY_EVENTS.join(", ")}`);
  for (const e of when) {
    if (!(TASK_NOTIFY_EVENTS as readonly unknown[]).includes(e)) throw new Error(`${ctx}: notify.when must be a list of ${TASK_NOTIFY_EVENTS.join(", ")}`);
  }
  const events = [...new Set(when as TaskNotifyEvent[])];
  if (raw.channel === undefined) return { when: events };
  if (typeof raw.channel !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(raw.channel)) throw new Error(`${ctx}: notify.channel must be a channel name`);
  return { when: events, channel: raw.channel };
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

// ---------------------------------------------------------------- helpers

function optionalString(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} must be a non-empty string`);
  return v.trim();
}

function stringList(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) throw new Error(`${what} must be a list of strings`);
  return v.map((x: string) => x.trim());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringMap(v: unknown): v is Record<string, string> {
  return isRecord(v) && Object.values(v).every((x) => typeof x === "string");
}
