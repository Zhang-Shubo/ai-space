/**
 * Storage data model: what an app declares, what ai-space provisions.
 *
 * The contract between an app and the storage service is a URL. Apps declare
 * databases in `space.yaml`; ai-space creates them, records them in its
 * inventory and hands the URLs over through `<workspace>/data/<app>/space.env`.
 * See `docs/storage.md`.
 */

export type Dialect = "sqlite" | "postgres";

export const DEFAULT_DATABASE_NAME = "main";

/** One database an app asks for. */
export type DatabaseSpec = {
  name: string;
  backend: Dialect;
};

/** The parsed `storage:` section of a manifest. */
export type StorageSpec = {
  databases: DatabaseSpec[];
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

/** Environment variable name for a database: DATABASE_URL for `main`, DATABASE_URL_<NAME> otherwise. */
export function databaseEnvName(name: string): string {
  if (name === DEFAULT_DATABASE_NAME) return "DATABASE_URL";
  return `DATABASE_URL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
