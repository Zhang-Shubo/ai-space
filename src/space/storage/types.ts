/**
 * Storage data model: what an app declares, what ai-space provisions.
 *
 * The contract between an app and the storage service is a URL. Apps declare
 * databases and a blob store in `space.yaml`; ai-space creates or checks them,
 * records them in its inventory and hands the URLs (plus the credentials they
 * need) over through `<workspace>/data/<app>/space.env`. See `docs/storage.md`.
 */

export type Dialect = "sqlite" | "postgres";

export const DEFAULT_DATABASE_NAME = "main";

/** One database an app asks for. */
export type DatabaseSpec = {
  name: string;
  backend: Dialect;
};

export type BlobBackend = "file" | "s3";

/**
 * The blob store an app asks for. `file` is a directory under the app's data
 * dir; `s3` is `bucket` (default `SPACE_S3_BUCKET`) under `prefix` (default
 * `<app>/`; `""` means the bucket root, for apps that already own a bucket).
 */
export type BlobSpec = {
  backend: BlobBackend;
  bucket?: string;
  prefix?: string;
};

/** The parsed `storage:` section of a manifest. */
export type StorageSpec = {
  databases: DatabaseSpec[];
  blobs?: BlobSpec;
};

export const EMPTY_STORAGE: StorageSpec = { databases: [] };

/** A database ai-space has provisioned, as kept in the inventory. */
export type ProvisionedDatabase = {
  app: string;
  name: string;
  backend: Dialect;
  /** Connection URL handed to the app. Contains the password for postgres. */
  url: string;
  /** `manifest` databases follow space.yaml; `api` databases were created at runtime. */
  source: "manifest" | "api";
  /** A manifest database that disappeared from the manifest. Kept, never removed by sync. */
  orphaned: boolean;
  createdAt: number;
  updatedAt: number;
};

/** The blob store ai-space has provisioned for an app (at most one per app). */
export type ProvisionedBlobStore = {
  app: string;
  backend: BlobBackend;
  /** `file:///abs/dir` or `s3://bucket/prefix/`. Never contains credentials. */
  url: string;
  /** The store left the manifest. Kept, dropped from space.env. */
  orphaned: boolean;
  createdAt: number;
  updatedAt: number;
};

/** S3-compatible credentials shared by every `s3` blob store, from the workspace `.env`. */
export type S3Config = {
  accessKeyId: string;
  secretAccessKey: string;
  /** e.g. https://<account>.r2.cloudflarestorage.com or http://127.0.0.1:9000; empty for AWS S3. */
  endpoint?: string;
  /** `auto` for R2; a real region for AWS. */
  region?: string;
  /** Default bucket for apps that do not name one. */
  bucket?: string;
};

/** Environment variable name for a database: DATABASE_URL for `main`, DATABASE_URL_<NAME> otherwise. */
export function databaseEnvName(name: string): string {
  if (name === DEFAULT_DATABASE_NAME) return "DATABASE_URL";
  return `DATABASE_URL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Object-key prefixes: path-like, no `..`, normalised to end with `/` unless empty. */
export const PREFIX_PATTERN = /^(?:[a-z0-9._-]+\/)*$/i;
