import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MANIFEST_FILE } from "./scheduler/manifest.ts";

/**
 * The ai-space workspace: one directory, default `~/.ai-space`, that holds
 * everything the space owns on a machine. Created on first boot (or `init`),
 * idempotent afterwards.
 *
 *   ~/.ai-space/
 *   ├── core/    ai-space itself (this repository), when deployed here
 *   ├── apps/    one directory per app; an app with a space.yaml is picked up automatically
 *   ├── data/    runtime state: space.db, then one directory per app (its databases, blobs/ and space.env)
 *   ├── logs/
 *   └── .env     ai-space configuration and the secrets app manifests reference
 */

export type Workspace = {
  home: string;
  apps: string;
  data: string;
  logs: string;
  envFile: string;
};

export const DEFAULT_HOME = join(homedir(), ".ai-space");

export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const raw = env.SPACE_HOME?.trim();
  if (!raw) return DEFAULT_HOME;
  return resolve(raw.replace(/^~(?=$|\/)/, homedir()));
}

export function workspacePaths(home: string): Workspace {
  return {
    home,
    apps: join(home, "apps"),
    data: join(home, "data"),
    logs: join(home, "logs"),
    envFile: join(home, ".env"),
  };
}

const ENV_TEMPLATE = `# ai-space workspace configuration. Loaded on boot; values already set in the
# process environment win. Apps under apps/ reference these through \${VAR} in
# their space.yaml, so app secrets the scheduler must present go here too.

SPACE_HOST=127.0.0.1
SPACE_PORT=8700
# Bearer token for mutating API routes. Empty = no check (127.0.0.1 only).
SPACE_API_TOKEN=
SPACE_MAX_CONCURRENCY=2
# How the panel stops an app's service when it uninstalls the app; {app} = name.
# e.g. sudo systemctl disable --now {app}   or   systemctl --user disable --now {app}
SPACE_SERVICE_STOP=
`;

/** Create the workspace directories and a starter .env if missing. Safe to call every boot. */
export async function ensureWorkspace(home: string): Promise<{ ws: Workspace; created: string[] }> {
  const ws = workspacePaths(home);
  const created: string[] = [];
  for (const dir of [ws.home, ws.apps, ws.data, ws.logs]) {
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
      created.push(dir);
    }
  }
  if (!(await Bun.file(ws.envFile).exists())) {
    await Bun.write(ws.envFile, ENV_TEMPLATE);
    created.push(ws.envFile);
  }
  return { ws, created };
}

/** App directories under apps/ that carry a manifest, sorted by name. */
export async function discoverApps(ws: Workspace): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(ws.apps);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of entries.sort()) {
    const dir = join(ws.apps, name);
    if (await Bun.file(join(dir, MANIFEST_FILE)).exists()) dirs.push(dir);
  }
  return dirs;
}

/**
 * Load `.env` from the workspace into process.env without overriding values
 * that are already set. Bun only auto-loads the .env in the cwd, and the
 * service runs from core/ while the config lives one level up.
 */
export async function loadWorkspaceEnv(ws: Workspace, env: Record<string, string | undefined> = process.env): Promise<number> {
  const file = Bun.file(ws.envFile);
  if (!(await file.exists())) return 0;
  let loaded = 0;
  for (const raw of (await file.text()).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
    loaded++;
  }
  return loaded;
}

async function exists(dir: string): Promise<boolean> {
  try {
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}
