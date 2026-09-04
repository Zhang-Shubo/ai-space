import { type BlobBackend, type BlobSpec, DEFAULT_DATABASE_NAME, type DatabaseSpec, type Dialect, EMPTY_STORAGE, NAME_PATTERN, PREFIX_PATTERN, type StorageSpec } from "./types.ts";

/**
 * Parse the `storage:` section of a manifest.
 *
 *   storage:
 *     database: sqlite                 # short form: one database named "main"
 *     databases:                       # long form
 *       - { name: main, backend: postgres }
 *       - { name: cache, backend: sqlite }
 *     blobs: s3                        # none (default) | file | s3
 *     # blobs: { backend: s3, bucket: my-bucket, prefix: "" }
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
  const blobs = parseBlobs(raw.blobs);
  return { databases, ...(blobs ? { blobs } : {}) };
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

/** `blobs: s3` / `blobs: file` / `blobs: none`, or the mapping form with bucket and prefix. */
export function parseBlobs(raw: unknown): BlobSpec | undefined {
  if (raw === undefined || raw === null || raw === "none" || raw === false) return undefined;
  if (typeof raw === "string") return { backend: parseBlobBackend(raw, "storage.blobs") };
  if (!isRecord(raw)) throw new Error("storage.blobs must be none, file, s3 or a mapping");
  const spec: BlobSpec = { backend: parseBlobBackend(raw.backend, "storage.blobs.backend") };
  if (raw.bucket !== undefined) {
    if (spec.backend !== "s3") throw new Error("storage.blobs.bucket only applies to the s3 backend");
    spec.bucket = parseName(raw.bucket, "storage.blobs.bucket");
  }
  if (raw.prefix !== undefined) {
    if (spec.backend !== "s3") throw new Error("storage.blobs.prefix only applies to the s3 backend");
    spec.prefix = parsePrefix(raw.prefix, "storage.blobs.prefix");
  }
  return spec;
}

export function parseBlobBackend(v: unknown, where: string): BlobBackend {
  if (v === "file" || v === "s3") return v;
  throw new Error(`${where}: backend must be file or s3`);
}

/** Normalise an object-key prefix: strip leading slashes, add the trailing one, refuse anything path-like. */
export function parsePrefix(v: unknown, where: string): string {
  if (typeof v !== "string") throw new Error(`${where}: must be a string`);
  let p = v.trim().replace(/^\/+/, "");
  if (p && !p.endsWith("/")) p += "/";
  if (!PREFIX_PATTERN.test(p) || p.split("/").some((seg) => /^\.+$/.test(seg))) throw new Error(`${where}: invalid prefix "${v}"`);
  return p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
