import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Workspace } from "../workspace.ts";

/**
 * Uninstalling an app from the panel: stop its service, take its directory
 * out of the workspace, forget it. Code is never deleted: a symlink is
 * unlinked and its target left alone, a checkout under apps/ moves to
 * <workspace>/trash/<name>-<stamp>, a manifest-only directory is removed,
 * and a directory outside apps/ (SPACE_APPS) is left where it is. The data
 * directory is always kept.
 */

export type DirOutcome = { kind: "unlinked" } | { kind: "moved"; to: string } | { kind: "deleted" } | { kind: "kept"; reason: string };

export async function retireAppDir(ws: Workspace, name: string, dir: string, manifestOnly: boolean): Promise<DirOutcome> {
  const inApps = dirname(resolve(dir)) === resolve(ws.apps);
  if (!inApps) return { kind: "kept", reason: "outside the workspace apps directory" };
  const st = await lstat(dir);
  if (st.isSymbolicLink()) {
    await rm(dir);
    return { kind: "unlinked" };
  }
  if (manifestOnly) {
    await rm(dir, { recursive: true, force: true });
    return { kind: "deleted" };
  }
  const trash = join(ws.home, "trash");
  await mkdir(trash, { recursive: true });
  const to = join(trash, `${name}-${stamp()}`);
  await rename(dir, to);
  return { kind: "moved", to };
}

const APP_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Run the operator's stop command for an app: the SPACE_SERVICE_STOP template
 * with `{app}` replaced, e.g. `sudo systemctl disable --now {app}` or
 * `systemctl --user disable --now {app}`. Only the app name is substituted, and
 * only when it is a plain app name.
 */
export async function runStopCommand(template: string, app: string, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; error?: string }> {
  if (!APP_RE.test(app)) return { ok: false, error: "invalid app name" };
  const cmd = template.replaceAll("{app}", app);
  const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 60_000);
  try {
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code === 0) return { ok: true };
    return { ok: false, error: `exit ${code}: ${(err || out).trim().slice(0, 500)}` };
  } finally {
    clearTimeout(timer);
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}
