import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import type { Workspace } from "../workspace.ts";
import { type Db, type Migration, sqliteUrl } from "./db.ts";
import { type DatabaseSpec, type Dialect, NAME_PATTERN, type ProvisionedDatabase, type StorageSpec, databaseEnvName } from "./types.ts";

/**
 * Storage service: provisions per-app databases, keeps the inventory and
 * writes `<workspace>/data/<app>/space.env`.
 *
 * Provisioning is idempotent and never destructive. A database that exists is
 * left as it is; a manifest database that disappears is marked orphaned and
 * kept; removal is a deliberate CLI step, not a side effect of sync.
 */

export const ENV_FILE = "space.env";

export type SyncResult = {
  app: string;
  databases: ProvisionedDatabase[];
  created: string[];
  orphaned: string[];
};

export type StorageOptions = {
  ws: Workspace;
  /** ai-space's own database, where the inventory lives. */
  db: Db;
  /** Superuser URL used only to create per-app postgres databases and roles. */
  pgAdminUrl?: string;
  log?: (msg: string) => void;
};

const MIGRATIONS: Migration[] = [
  {
    id: "001-storage-databases",
    up: (t) => `
      CREATE TABLE IF NOT EXISTS storage_databases (
        app        TEXT NOT NULL,
        name       TEXT NOT NULL,
        backend    TEXT NOT NULL,
        url        TEXT NOT NULL,
        source     TEXT NOT NULL,
        orphaned   ${t.bool} NOT NULL DEFAULT ${t.false},
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (app, name)
      )`,
  },
];

type Row = {
  app: string;
  name: string;
  backend: string;
  url: string;
  source: string;
  orphaned: number | boolean;
  created_at: number;
  updated_at: number;
};

export class StorageService {
  private readonly ws: Workspace;
  private readonly db: Db;
  private readonly pgAdminUrl?: string;
  private readonly log: (msg: string) => void;

  private constructor(opts: StorageOptions) {
    this.ws = opts.ws;
    this.db = opts.db;
    this.pgAdminUrl = opts.pgAdminUrl?.trim() || undefined;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  static async open(opts: StorageOptions): Promise<StorageService> {
    await opts.db.migrate(MIGRATIONS);
    return new StorageService(opts);
  }

  appDataDir(app: string): string {
    return join(this.ws.data, app);
  }

  envFile(app: string): string {
    return join(this.appDataDir(app), ENV_FILE);
  }

  /** Provision everything the manifest declares, mark what it dropped, rewrite space.env. */
  async syncApp(app: string, spec: StorageSpec): Promise<SyncResult> {
    assertName(app, "app");
    const created: string[] = [];
    const dir = this.appDataDir(app);
    if (!(await exists(dir))) {
      await mkdir(dir, { recursive: true });
      created.push(dir);
    }
    const existing = new Map((await this.list(app)).map((d) => [d.name, d]));
    const wanted = new Set(spec.databases.map((d) => d.name));

    for (const d of spec.databases) {
      const current = existing.get(d.name);
      if (current && current.backend !== d.backend) {
        throw new Error(`storage: database ${app}/${d.name} is ${current.backend}; changing to ${d.backend} is not supported by sync`);
      }
      const { url, createdPath } = await this.provision(app, d);
      if (createdPath) created.push(createdPath);
      await this.upsert({ app, name: d.name, backend: d.backend, url, source: "manifest", orphaned: false }, current);
    }

    const orphaned: string[] = [];
    for (const [name, d] of existing) {
      if (d.source !== "manifest" || wanted.has(name) || d.orphaned) continue;
      await this.db.sql`UPDATE storage_databases SET orphaned = ${true}, updated_at = ${Date.now()} WHERE app = ${app} AND name = ${name}`;
      orphaned.push(name);
    }

    const databases = await this.list(app);
    await this.writeEnv(app, databases);
    return { app, databases, created, orphaned };
  }

  /** Provision one database at runtime (source `api`). Idempotent for an existing name with the same backend. */
  async addDatabase(app: string, name: string, backend: Dialect): Promise<ProvisionedDatabase> {
    assertName(app, "app");
    assertName(name, "database name");
    const current = (await this.list(app)).find((d) => d.name === name);
    if (current) {
      if (current.backend !== backend) throw new Error(`database ${app}/${name} already exists as ${current.backend}`);
      if (current.orphaned) {
        await this.db.sql`UPDATE storage_databases SET orphaned = ${false}, source = ${"api"}, updated_at = ${Date.now()} WHERE app = ${app} AND name = ${name}`;
      }
    } else {
      await mkdir(this.appDataDir(app), { recursive: true });
      const { url } = await this.provision(app, { name, backend });
      await this.upsert({ app, name, backend, url, source: "api", orphaned: false }, undefined);
    }
    const databases = await this.list(app);
    await this.writeEnv(app, databases);
    return databases.find((d) => d.name === name)!;
  }

  async list(app: string): Promise<ProvisionedDatabase[]> {
    const rows = (await this.db.sql`SELECT * FROM storage_databases WHERE app = ${app} ORDER BY name`) as Row[];
    return rows.map(fromRow);
  }

  async listApps(): Promise<string[]> {
    const rows = (await this.db.sql`SELECT DISTINCT app FROM storage_databases ORDER BY app`) as { app: string }[];
    return rows.map((r) => r.app);
  }

  /** Public description of an app's storage: no passwords. */
  async describe(app: string) {
    const databases = (await this.list(app)).map((d) => ({
      name: d.name,
      backend: d.backend,
      source: d.source,
      orphaned: d.orphaned,
      env: databaseEnvName(d.name),
      ...(d.backend === "sqlite" ? { path: d.url.replace(/^sqlite:\/\//, "") } : {}),
      createdAt: new Date(d.createdAt).toISOString(),
    }));
    return { app, dataDir: this.appDataDir(app), envFile: this.envFile(app), databases };
  }

  /** The variables an app process should see. Orphaned databases are left out. */
  async envFor(app: string): Promise<Record<string, string>> {
    return envVars(app, this.appDataDir(app), await this.list(app));
  }

  private async provision(app: string, d: DatabaseSpec): Promise<{ url: string; createdPath?: string }> {
    if (d.backend === "sqlite") {
      const path = join(this.appDataDir(app), `${d.name}.db`);
      const fresh = !(await Bun.file(path).exists());
      if (fresh) new Database(path, { create: true }).close();
      return { url: sqliteUrl(path), createdPath: fresh ? path : undefined };
    }
    return { url: await this.provisionPostgres(app, d.name) };
  }

  private async provisionPostgres(app: string, name: string): Promise<string> {
    if (!this.pgAdminUrl) throw new Error(`storage: ${app}/${name} needs postgres but SPACE_PG_ADMIN_URL is not set`);
    const ident = `${app}_${name}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 63);
    const password = randomPassword();
    const admin = new SQL(this.pgAdminUrl);
    try {
      const role = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${ident}`;
      if (role.length === 0) {
        await admin.unsafe(`CREATE ROLE "${ident}" LOGIN PASSWORD '${password}'`);
        this.log(`[storage] created postgres role ${ident}`);
      } else {
        // The password is only known through the inventory; re-provisioning means we lost it.
        await admin.unsafe(`ALTER ROLE "${ident}" PASSWORD '${password}'`);
      }
      const dbs = await admin`SELECT 1 FROM pg_database WHERE datname = ${ident}`;
      if (dbs.length === 0) {
        await admin.unsafe(`CREATE DATABASE "${ident}" OWNER "${ident}"`);
        this.log(`[storage] created postgres database ${ident}`);
      }
    } finally {
      await admin.close();
    }
    const a = new URL(this.pgAdminUrl);
    return `postgres://${encodeURIComponent(ident)}:${encodeURIComponent(password)}@${a.hostname}${a.port ? `:${a.port}` : ""}/${ident}`;
  }

  private async upsert(d: Omit<ProvisionedDatabase, "createdAt" | "updatedAt">, current: ProvisionedDatabase | undefined): Promise<void> {
    const now = Date.now();
    if (current) {
      // Keep the URL of an existing database unless the backend re-provisioned it (postgres password rotation).
      const url = current.backend === "postgres" ? d.url : current.url;
      await this.db.sql`UPDATE storage_databases SET url = ${url}, source = ${d.source}, orphaned = ${false}, updated_at = ${now} WHERE app = ${d.app} AND name = ${d.name}`;
      return;
    }
    await this.db.sql`INSERT INTO storage_databases (app, name, backend, url, source, orphaned, created_at, updated_at)
      VALUES (${d.app}, ${d.name}, ${d.backend}, ${d.url}, ${d.source}, ${false}, ${now}, ${now})`;
  }

  private async writeEnv(app: string, databases: ProvisionedDatabase[]): Promise<void> {
    const vars = envVars(app, this.appDataDir(app), databases);
    const lines = [
      "# Generated by ai-space from the app's storage declaration. Do not edit; rewritten on every sync.",
      ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
      "",
    ];
    const file = this.envFile(app);
    await Bun.write(file, lines.join("\n"));
    await chmod(file, 0o600);
  }
}

export function envVars(app: string, dataDir: string, databases: ProvisionedDatabase[]): Record<string, string> {
  const vars: Record<string, string> = { SPACE_APP: app, SPACE_APP_DATA_DIR: dataDir };
  for (const d of databases) {
    if (d.orphaned) continue;
    vars[databaseEnvName(d.name)] = d.url;
  }
  return vars;
}

function fromRow(r: Row): ProvisionedDatabase {
  return {
    app: r.app,
    name: r.name,
    backend: r.backend as Dialect,
    url: r.url,
    source: r.source as ProvisionedDatabase["source"],
    orphaned: r.orphaned === true || r.orphaned === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function assertName(v: string, what: string): void {
  if (!NAME_PATTERN.test(v)) throw new Error(`invalid ${what}: ${v}`);
}

function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

async function exists(dir: string): Promise<boolean> {
  try {
    const { readdir } = await import("node:fs/promises");
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}
