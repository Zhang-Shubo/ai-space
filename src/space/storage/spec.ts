import { DEFAULT_DATABASE_NAME, type DatabaseSpec, type Dialect, EMPTY_STORAGE, NAME_PATTERN, type StorageSpec } from "./types.ts";

/**
 * Parse the `storage:` section of a manifest.
 *
 *   storage:
 *     database: sqlite                 # short form: one database named "main"
 *     databases:                       # long form
 *       - { name: main, backend: postgres }
 *       - { name: cache, backend: sqlite }
 *
 * Strict, like task parsing: an invalid section rejects the whole app.
 */
export function parseStorageSpec(raw: unknown): StorageSpec {
  if (raw === undefined || raw === null) return EMPTY_STORAGE;
  if (!isRecord(raw)) throw new Error("storage must be a mapping");
  if (raw.database !== undefined && raw.databases !== undefined) {
    throw new Error("storage: declare either database or databases, not both");
  }
  const databases: DatabaseSpec[] = [];
  if (raw.database !== undefined) {
    databases.push({ name: DEFAULT_DATABASE_NAME, backend: parseBackend(raw.database, "storage.database") });
  }
  if (raw.databases !== undefined) {
    if (!Array.isArray(raw.databases)) throw new Error("storage.databases must be a list");
    raw.databases.forEach((entry, i) => {
      const where = `storage.databases[${i}]`;
      if (typeof entry === "string") {
        databases.push({ name: parseName(entry, where), backend: "sqlite" });
        return;
      }
      if (!isRecord(entry)) throw new Error(`${where} must be a name or a mapping`);
      databases.push({
        name: parseName(entry.name, where),
        backend: entry.backend === undefined ? "sqlite" : parseBackend(entry.backend, `${where}.backend`),
      });
    });
  }
  const seen = new Set<string>();
  for (const d of databases) {
    if (seen.has(d.name)) throw new Error(`storage: duplicate database name: ${d.name}`);
    seen.add(d.name);
  }
  return { databases };
}

export function parseBackend(v: unknown, where: string): Dialect {
  if (v === "sqlite" || v === "postgres") return v;
  if (v === "postgresql") return "postgres";
  throw new Error(`${where}: backend must be sqlite or postgres`);
}

export function parseName(v: unknown, where: string): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (!NAME_PATTERN.test(name)) throw new Error(`${where}: invalid or missing name`);
  return name;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
