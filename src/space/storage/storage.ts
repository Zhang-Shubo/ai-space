import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { S3Client, SQL } from "bun";
import type { Workspace } from "../workspace.ts";
import { type Db, type Migration, sqliteUrl } from "./db.ts";
import {
  type BlobBackend,
  type BlobSpec,
  type DatabaseSpec,
  type Dialect,
  NAME_PATTERN,
  type ProvisionedBlobStore,
  type ProvisionedDatabase,
  type S3Config,
  type StorageSpec,
  databaseEnvName,
} from "./types.ts";

/**
 * Storage service: provisions per-app databases and blob stores, keeps the
 * inventory and writes `<workspace>/data/<app>/space.env`.
 *
 * Provisioning is idempotent and never destructive. A database or store that
 * exists is left as it is; one that disappears from the manifest is marked
 * orphaned and kept; removal is a deliberate CLI step, not a side effect of
 * sync. An `s3` store is only checked for reachability the first time it is
 * declared, so a flaky bucket does not stop the app from booting later.
 */

export const ENV_FILE = "space.env";
export const BLOB_DIR = "blobs";

export type SyncResult = {
  app: string;
  databases: ProvisionedDatabase[];
  blobs?: ProvisionedBlobStore;
  created: string[];
  orphaned: string[];
};

/** Bucket + prefix an s3 store resolves to, with the credentials it is checked with. */
export type S3Target = S3Config & { bucket: string; prefix: string };

export type StorageOptions = {
  ws: Workspace;
  /** ai-space's own database, where the inventory lives. */
  db: Db;
  /** Superuser URL used only to create per-app postgres databases and roles. */
  pgAdminUrl?: string;
  /** Credentials for `s3` blob stores; absent disables the backend. */
  s3?: S3Config;
  /** Reachability check for a new s3 store. Defaults to one `list` call on the bucket. */
  probeS3?: (target: S3Target) => Promise<void>;
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
  {
    id: "002-storage-blob-stores",
    up: (t) => `
      CREATE TABLE IF NOT EXISTS storage_blob_stores (
        app        TEXT PRIMARY KEY,
        backend    TEXT NOT NULL,
        url        TEXT NOT NULL,
        orphaned   ${t.bool} NOT NULL DEFAULT ${t.false},
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
  },
  {
    id: "003-app-tokens",
    up: () => `
      CREATE TABLE IF NOT EXISTS app_tokens (
        app        TEXT PRIMARY KEY,
        token      TEXT NOT NULL UNIQUE,
        created_at BIGINT NOT NULL
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

type BlobRow = Omit<Row, "name" | "source">;

export class StorageService {
  private readonly ws: Workspace;
  private readonly db: Db;
  private readonly pgAdminUrl?: string;
  private readonly s3?: S3Config;
  private readonly probeS3: (target: S3Target) => Promise<void>;
  private readonly log: (msg: string) => void;

  private constructor(opts: StorageOptions) {
    this.ws = opts.ws;
    this.db = opts.db;
    this.pgAdminUrl = opts.pgAdminUrl?.trim() || undefined;
    this.s3 = opts.s3;
    this.probeS3 = opts.probeS3 ?? defaultProbeS3;
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

    const currentBlobs = await this.blobStore(app);
    if (spec.blobs) {
      const { createdPath } = await this.provisionBlobs(app, spec.blobs, currentBlobs);
      if (createdPath) created.push(createdPath);
    } else if (currentBlobs && !currentBlobs.orphaned) {
      await this.db.sql`UPDATE storage_blob_stores SET orphaned = ${true}, updated_at = ${Date.now()} WHERE app = ${app}`;
      orphaned.push("blobs");
    }

    const databases = await this.list(app);
    const blobs = await this.blobStore(app);
    await this.writeEnv(app, databases, blobs);
    return { app, databases, ...(blobs ? { blobs } : {}), created, orphaned };
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
    await this.writeEnv(app, databases, await this.blobStore(app));
    return databases.find((d) => d.name === name)!;
  }

  async list(app: string): Promise<ProvisionedDatabase[]> {
    const rows = (await this.db.sql`SELECT * FROM storage_databases WHERE app = ${app} ORDER BY name`) as Row[];
    return rows.map(fromRow);
  }

  async blobStore(app: string): Promise<ProvisionedBlobStore | undefined> {
    const rows = (await this.db.sql`SELECT * FROM storage_blob_stores WHERE app = ${app}`) as BlobRow[];
    return rows[0] ? fromBlobRow(rows[0]) : undefined;
  }

  async listApps(): Promise<string[]> {
    const rows = (await this.db.sql`
      SELECT app FROM storage_databases UNION SELECT app FROM storage_blob_stores ORDER BY app`) as { app: string }[];
    return rows.map((r) => r.app);
  }

  /** Public description of an app's storage: no passwords, no S3 keys. */
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
    const store = await this.blobStore(app);
    const blobs = store
      ? {
          backend: store.backend,
          orphaned: store.orphaned,
          env: "BLOB_URL",
          ...(store.backend === "file" ? { path: store.url.replace(/^file:\/\//, "") } : s3Parts(store.url)),
          createdAt: new Date(store.createdAt).toISOString(),
        }
      : null;
    return { app, dataDir: this.appDataDir(app), envFile: this.envFile(app), databases, blobs };
  }

  /** The variables an app process should see. Orphaned databases and stores are left out. */
  async envFor(app: string): Promise<Record<string, string>> {
    assertName(app, "app");
    return envVars(app, this.appDataDir(app), await this.list(app), await this.blobStore(app), this.s3, await this.tokenFor(app));
  }

  /**
   * The app's own bearer token for the Space API (`SPACE_APP_TOKEN`), created on
   * first use and stable afterwards. It identifies the app on routes that act on
   * its behalf, such as `POST /api/notify`.
   */
  async tokenFor(app: string): Promise<string> {
    assertName(app, "app");
    const rows = (await this.db.sql`SELECT token FROM app_tokens WHERE app = ${app}`) as { token: string }[];
    if (rows[0]) return rows[0].token;
    const token = `sat_${randomPassword()}`;
    await this.db.sql`INSERT INTO app_tokens (app, token, created_at) VALUES (${app}, ${token}, ${Date.now()})`;
    return token;
  }

  async appForToken(token: string): Promise<string | undefined> {
    if (!token) return undefined;
    const rows = (await this.db.sql`SELECT app FROM app_tokens WHERE token = ${token}`) as { app: string }[];
    return rows[0]?.app;
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

  /**
   * Resolve the store URL, create the directory or probe the bucket, record it.
   * Backend changes are refused (data does not move); a bucket or prefix change
   * on an existing s3 store is accepted and logged, because it is the app's
   * declaration and nothing on the old location is touched.
   */
  private async provisionBlobs(app: string, spec: BlobSpec, current: ProvisionedBlobStore | undefined): Promise<{ createdPath?: string }> {
    if (current && current.backend !== spec.backend) {
      throw new Error(`storage: blob store of ${app} is ${current.backend}; changing to ${spec.backend} is not supported by sync`);
    }
    let url: string;
    let createdPath: string | undefined;
    if (spec.backend === "file") {
      const dir = join(this.appDataDir(app), BLOB_DIR);
      if (!(await exists(dir))) {
        await mkdir(dir, { recursive: true });
        createdPath = dir;
      }
      url = `file://${dir}`;
    } else {
      const target = this.resolveS3(app, spec);
      url = `s3://${target.bucket}/${target.prefix}`;
      if (!current || current.url !== url) {
        try {
          await this.probeS3(target);
        } catch (e) {
          throw new Error(`storage: ${app}: bucket ${target.bucket} is not reachable with the SPACE_S3_* credentials: ${(e as Error).message}`);
        }
        if (current) this.log(`[storage] ${app}: blob store moved from ${current.url} to ${url}; nothing was copied`);
      }
    }
    const now = Date.now();
    if (current) {
      await this.db.sql`UPDATE storage_blob_stores SET url = ${url}, orphaned = ${false}, updated_at = ${now} WHERE app = ${app}`;
    } else {
      await this.db.sql`INSERT INTO storage_blob_stores (app, backend, url, orphaned, created_at, updated_at)
        VALUES (${app}, ${spec.backend}, ${url}, ${false}, ${now}, ${now})`;
    }
    return { createdPath };
  }

  private resolveS3(app: string, spec: BlobSpec): S3Target {
    if (!this.s3) throw new Error(`storage: ${app} needs an s3 blob store but SPACE_S3_ACCESS_KEY_ID / SPACE_S3_SECRET_ACCESS_KEY are not set`);
    const bucket = spec.bucket ?? this.s3.bucket;
    if (!bucket) throw new Error(`storage: ${app}: storage.blobs names no bucket and SPACE_S3_BUCKET is not set`);
    const prefix = spec.prefix === undefined ? `${app}/` : spec.prefix && !spec.prefix.endsWith("/") ? `${spec.prefix}/` : spec.prefix;
    return { ...this.s3, bucket, prefix };
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

  private async writeEnv(app: string, databases: ProvisionedDatabase[], blobs: ProvisionedBlobStore | undefined): Promise<void> {
    const vars = envVars(app, this.appDataDir(app), databases, blobs, this.s3, await this.tokenFor(app));
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

/**
 * Variables handed to an app. Identity: `SPACE_APP`, `SPACE_APP_DATA_DIR` and
 * the app's `SPACE_APP_TOKEN`. Databases: `DATABASE_URL[_NAME]`. Blob store:
 * `BLOB_URL`, plus for s3 the `S3_*` names Bun's `S3Client` and most SDKs read
 * by default, so an app can open the bucket without ai-space code.
 */
export function envVars(
  app: string,
  dataDir: string,
  databases: ProvisionedDatabase[],
  blobs?: ProvisionedBlobStore,
  s3?: S3Config,
  token?: string,
): Record<string, string> {
  const vars: Record<string, string> = { SPACE_APP: app, SPACE_APP_DATA_DIR: dataDir, ...(token ? { SPACE_APP_TOKEN: token } : {}) };
  for (const d of databases) {
    if (d.orphaned) continue;
    vars[databaseEnvName(d.name)] = d.url;
  }
  if (blobs && !blobs.orphaned) {
    vars.BLOB_URL = blobs.url;
    if (blobs.backend === "s3" && s3) {
      const { bucket } = s3Parts(blobs.url);
      if (s3.endpoint) vars.S3_ENDPOINT = s3.endpoint;
      if (s3.region) vars.S3_REGION = s3.region;
      vars.S3_BUCKET = bucket;
      vars.S3_ACCESS_KEY_ID = s3.accessKeyId;
      vars.S3_SECRET_ACCESS_KEY = s3.secretAccessKey;
    }
  }
  return vars;
}

/** Split `s3://bucket/prefix/` into its parts. */
export function s3Parts(url: string): { bucket: string; prefix: string } {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  if (!m) throw new Error(`not an s3 url: ${url}`);
  return { bucket: m[1]!, prefix: m[2] ?? "" };
}

async function defaultProbeS3(t: S3Target): Promise<void> {
  const client = new S3Client({
    accessKeyId: t.accessKeyId,
    secretAccessKey: t.secretAccessKey,
    bucket: t.bucket,
    ...(t.endpoint ? { endpoint: t.endpoint } : {}),
    ...(t.region ? { region: t.region } : {}),
  });
  await client.list({ prefix: t.prefix, maxKeys: 1 });
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

function fromBlobRow(r: BlobRow): ProvisionedBlobStore {
  return {
    app: r.app,
    backend: r.backend as BlobBackend,
    url: r.url,
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
    await readdir(dir);
    return true;
  } catch {
    return false;
  }
}
