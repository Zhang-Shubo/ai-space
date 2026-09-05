import { mkdir } from "node:fs/promises";
import { $ } from "bun";

/**
 * The archive step: one `tar` stream compressed by `zstd`, both spawned as
 * the system binaries (GNU or BSD tar, any zstd). Nothing is buffered in
 * memory; the hash is computed by streaming the finished file.
 */

export const ARCHIVE_TOOLS = ["tar", "zstd"] as const;

export function missingArchiveTools(): string[] {
  return ARCHIVE_TOOLS.filter((t) => !Bun.which(t));
}

export function requireArchiveTools(): void {
  const missing = missingArchiveTools();
  if (missing.length) throw new Error(`backup needs ${missing.join(" and ")} on PATH (apt-get install ${missing.join(" ")})`);
}

export async function createArchive(stageDir: string, outPath: string): Promise<{ bytes: number; sha256: string }> {
  await $`tar -cf - -C ${stageDir} . | zstd -q -T0 -o ${outPath}`.quiet();
  return hashFile(outPath);
}

export async function extractArchive(archivePath: string, toDir: string): Promise<void> {
  await mkdir(toDir, { recursive: true });
  await $`zstd -dc ${archivePath} | tar -xf - -C ${toDir}`.quiet();
}

/** File paths inside the archive, relative, directories left out. */
export async function listArchive(archivePath: string): Promise<string[]> {
  const text = await $`zstd -dc ${archivePath} | tar -tf -`.text();
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^\.\//, ""))
    .filter((l) => l && l !== "." && !l.endsWith("/"))
    .sort();
}

export async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    bytes += value.byteLength;
  }
  return { bytes, sha256: hasher.digest("hex") };
}
