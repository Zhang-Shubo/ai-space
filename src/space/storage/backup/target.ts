import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { S3Client } from "bun";
import type { S3Config } from "../types.ts";

/**
 * Where snapshots go. Two backends behind one small interface: a directory
 * (`file:///abs/dir/`) and an S3-compatible bucket (`s3://bucket/prefix/`,
 * through Bun's `S3Client` with the workspace `SPACE_S3_*` credentials).
 * Keys are relative to the target root and always `<app>/<stamp>.<ext>`.
 */

export type ObjectInfo = { key: string; size: number };

export interface BackupTarget {
  readonly url: string;
  readonly kind: "file" | "s3";
  /** Upload a local file. Large files stream (multipart on S3). */
  put(key: string, localPath: string): Promise<void>;
  putText(key: string, text: string): Promise<void>;
  /** Download to a local path, creating parent directories. */
  get(key: string, localPath: string): Promise<void>;
  /** undefined when the object does not exist. */
  getText(key: string): Promise<string | undefined>;
  list(prefix: string): Promise<ObjectInfo[]>;
  delete(key: string): Promise<void>;
}

export function parseTargetUrl(url: string): { kind: "file"; dir: string } | { kind: "s3"; bucket: string; prefix: string } {
  const u = url.trim();
  const file = /^file:\/\/(.+)$/.exec(u);
  if (file) return { kind: "file", dir: resolve(file[1]!.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) };
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u);
  if (s3) {
    let prefix = s3[2] ?? "";
    if (prefix && !prefix.endsWith("/")) prefix += "/";
    return { kind: "s3", bucket: s3[1]!, prefix };
  }
  throw new Error(`SPACE_BACKUP_URL must be s3://bucket/prefix/ or file:///dir/, got ${u || "(empty)"}`);
}

export function openBackupTarget(url: string, s3?: S3Config): BackupTarget {
  const parsed = parseTargetUrl(url);
  if (parsed.kind === "file") return new FileTarget(parsed.dir);
  if (!s3) throw new Error(`SPACE_BACKUP_URL is ${url} but SPACE_S3_ACCESS_KEY_ID / SPACE_S3_SECRET_ACCESS_KEY are not set`);
  return new S3Target(parsed.bucket, parsed.prefix, s3);
}

export class FileTarget implements BackupTarget {
  readonly kind = "file" as const;
  readonly url: string;
  constructor(readonly dir: string) {
    this.url = `file://${dir}/`;
  }
  private path(key: string): string {
    const p = resolve(this.dir, key);
    if (!p.startsWith(`${this.dir}/`)) throw new Error(`key escapes the target: ${key}`);
    return p;
  }
  async put(key: string, localPath: string): Promise<void> {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, Bun.file(localPath));
  }
  async putText(key: string, text: string): Promise<void> {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, text);
  }
  async get(key: string, localPath: string): Promise<void> {
    const src = Bun.file(this.path(key));
    if (!(await src.exists())) throw new Error(`no such object: ${key}`);
    await mkdir(dirname(localPath), { recursive: true });
    await Bun.write(localPath, src);
  }
  async getText(key: string): Promise<string | undefined> {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? f.text() : undefined;
  }
  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    const walk = async (dir: string) => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        const p = join(dir, name);
        const s = await stat(p);
        if (s.isDirectory()) await walk(p);
        else {
          const key = relative(this.dir, p);
          if (key.startsWith(prefix)) out.push({ key, size: s.size });
        }
      }
    };
    await walk(this.dir);
    return out;
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

export class S3Target implements BackupTarget {
  readonly kind = "s3" as const;
  readonly url: string;
  private readonly client: S3Client;
  constructor(
    readonly bucket: string,
    readonly prefix: string,
    s3: S3Config,
  ) {
    this.url = `s3://${bucket}/${prefix}`;
    this.client = new S3Client({
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      bucket,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      ...(s3.region ? { region: s3.region } : {}),
    });
  }
  private full(key: string): string {
    return `${this.prefix}${key}`;
  }
  async put(key: string, localPath: string): Promise<void> {
    await this.client.write(this.full(key), Bun.file(localPath));
  }
  async putText(key: string, text: string): Promise<void> {
    await this.client.write(this.full(key), text, { type: "application/json" });
  }
  async get(key: string, localPath: string): Promise<void> {
    await mkdir(dirname(localPath), { recursive: true });
    await Bun.write(localPath, this.client.file(this.full(key)));
  }
  async getText(key: string): Promise<string | undefined> {
    const f = this.client.file(this.full(key));
    if (!(await f.exists())) return undefined;
    return f.text();
  }
  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.client.list({ prefix: this.full(prefix), maxKeys: 1000, ...(startAfter ? { startAfter } : {}) });
      for (const o of page.contents ?? []) {
        if (o.key.startsWith(this.prefix)) out.push({ key: o.key.slice(this.prefix.length), size: o.size ?? 0 });
      }
      const last = page.contents?.at(-1)?.key;
      if (!page.isTruncated || !last) break;
      startAfter = last;
    }
    return out;
  }
  async delete(key: string): Promise<void> {
    await this.client.delete(this.full(key));
  }
}
