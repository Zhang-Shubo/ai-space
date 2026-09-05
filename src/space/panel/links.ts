import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MANIFEST_FILE } from "../scheduler/manifest.ts";
import type { Workspace } from "../workspace.ts";

/**
 * Manifest-only apps: what the panel creates when the operator adds a link.
 * The result is `apps/<name>/space.yaml` with identity fields only, so the
 * launcher can show things that are not ai-space services (a page, a tool on
 * another machine, a repository). Uninstalling one from the panel just removes
 * the directory (uninstall.ts).
 */

export type LinkApp = {
  name: string;
  title?: string;
  description?: string;
  /** Emoji or http(s) URL. */
  icon?: string;
  url?: string;
  repo?: string;
};

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseLinkApp(body: Record<string, unknown>): LinkApp {
  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  if (!NAME_RE.test(name)) throw new Error("name must be lowercase kebab-case (letters, digits, . _ -)");
  const str = (k: string, max = 500) => {
    const v = body[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new Error(`${k} must be a string`);
    const t = v.trim().replace(/\s+/g, " ");
    return t ? t.slice(0, max) : undefined;
  };
  const url = str("url");
  if (url !== undefined && !/^https?:\/\//.test(url)) throw new Error("url must start with http:// or https://");
  const icon = str("icon", 300);
  if (icon !== undefined && /^[\w./-]/.test(icon) && !/^https?:\/\//.test(icon)) throw new Error("icon must be an emoji or an http(s) URL");
  return {
    name,
    ...(str("title", 120) !== undefined ? { title: str("title", 120) } : {}),
    ...(str("description") !== undefined ? { description: str("description") } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(str("repo", 300) !== undefined ? { repo: str("repo", 300) } : {}),
  };
}

/** The manifest text for a link app; every value is YAML-quoted. */
export function linkManifest(app: LinkApp): string {
  const q = (s: string) => JSON.stringify(s);
  const lines = ["# Created by the ai-space panel. Identity only: no service, no storage.", "spec: 1", `name: ${q(app.name)}`];
  if (app.title) lines.push(`title: ${q(app.title)}`);
  if (app.description) lines.push(`description: ${q(app.description)}`);
  if (app.icon) lines.push(`icon: ${q(app.icon)}`);
  if (app.url) lines.push(`url: ${q(app.url)}`);
  if (app.repo) lines.push(`repo: ${q(app.repo)}`);
  return lines.join("\n") + "\n";
}

/** Write `apps/<name>/space.yaml`; refuses to touch an existing directory. */
export async function createLinkApp(ws: Workspace, app: LinkApp): Promise<string> {
  const dir = join(ws.apps, app.name);
  if (await exists(dir)) throw new Error(`app "${app.name}" already exists`);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, MANIFEST_FILE), linkManifest(app));
  return dir;
}

/** Remove a manifest-only app directory. The caller has checked it is one. */
export async function removeLinkApp(ws: Workspace, name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error("invalid app name");
  await rm(join(ws.apps, name), { recursive: true, force: true });
}

/**
 * Ask the claude runtime to read a link and propose the identity fields.
 * Returns whatever JSON object the answer contains; the caller validates it.
 */
export async function resolveLinkWithAgent(link: string, opts: { bin?: string[]; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const prompt = `Analyse this link: ${link}
Read it with WebFetch, then output exactly one JSON object and nothing else:
{"name":"short kebab-case name (lowercase letters, digits, dashes)","title":"display name, a few words","icon":"absolute URL of the site's own icon (<link rel=icon>, /favicon.svg or /favicon.ico, verified reachable) or, failing that, one fitting emoji","description":"one sentence saying what it is","repo":"its https clone URL if it is a code repository, else empty string","url":"the link itself if it is a page or service a browser can open, else empty string"}`;
  const cmd = opts.bin ?? ["claude", "-p", "--output-format", "json", "--allowedTools", "WebFetch"];
  const proc = Bun.spawn([...cmd, prompt], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 180_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`runtime exited with ${code}: ${stderr.trim().slice(-300)}`);
  let text = stdout;
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown };
    if (typeof parsed.result === "string") text = parsed.result;
  } catch {
    /* plain text answer */
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("the runtime returned no JSON");
  const obj = JSON.parse(m[0]) as Record<string, unknown>;
  if (typeof obj.name === "string") obj.name = obj.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return obj;
}

async function exists(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
