import { join } from "node:path";
import type { Manifest } from "../scheduler/manifest.ts";

/**
 * The apps ai-space currently knows: every manifest that passed validation on
 * boot or on a later sync, keyed by app name. The panel reads its lists from
 * here; the scheduler, storage and notify services keep their own state and
 * are synced by the entry point when a manifest changes.
 */

export type RegisteredApp = {
  manifest: Manifest;
  /**
   * True when the directory holds nothing but the manifest and its assets:
   * no service and no git repository. Such apps are owned by the panel (it
   * created them from a link) and may be deleted from it.
   */
  manifestOnly: boolean;
  registeredAt: number;
};

export class AppRegistry {
  private readonly apps = new Map<string, RegisteredApp>();

  async set(manifest: Manifest): Promise<RegisteredApp> {
    const manifestOnly = !manifest.service && !(await isDir(join(manifest.dir, ".git")));
    const entry = { manifest, manifestOnly, registeredAt: Date.now() };
    this.apps.set(manifest.app, entry);
    return entry;
  }

  remove(app: string): boolean {
    return this.apps.delete(app);
  }

  get(app: string): RegisteredApp | undefined {
    return this.apps.get(app);
  }

  /** Sorted by app name. */
  list(): RegisteredApp[] {
    return [...this.apps.values()].sort((a, b) => a.manifest.app.localeCompare(b.manifest.app));
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
