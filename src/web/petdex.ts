// Pets from petdex.dev, a public gallery of animated pets in the Codex sprite format.
// The site publishes one manifest of every approved pet; a pet's sprite sheet lives at a
// content-hashed path, so a name has to be looked up here rather than turned into a URL.
// The manifest and the sheets are served with `Access-Control-Allow-Origin: *`, so the
// browser reads them directly; the manifest (under 1 MB) is fetched once per page and only
// when the user is choosing a pet. petdex sits behind Cloudflare hotlink protection, which
// answers 403 to any request carrying another site's Referer, so nothing here sends one.

/** The manifest as the petdex CLI reads it, and the file it redirects to, tried in turn. */
export const PETDEX_MANIFESTS = ["https://petdex.dev/api/manifest/v2", "https://assets.petdex.dev/manifests/petdex-v2.json"];

export type PetdexPet = {
  slug: string;
  name: string;
  kind: string;
  by: string | null;
  url: string;
  version: 1 | 2;
};

/** The chosen pet as kept in the panel preferences: enough to draw it without the manifest. */
export type PetChoice = { slug: string; name: string; by: string | null; url: string };

const FIELDS = ["slug", "displayName", "kind", "submittedBy", "spritesheet", "petJson", "zip", "spriteVersionNumber"];

/**
 * Parse the compact v2 manifest: `{ v: 2, assetBase, fields, pets: [[slug, name, kind, by, sheet, json, zip, version], ...] }`.
 * Rows that do not fit are skipped rather than failing the whole list. Only https asset URLs are kept.
 */
export function parseManifest(input: unknown): PetdexPet[] {
  if (!input || typeof input !== "object") throw new Error("invalid manifest");
  const m = input as { v?: unknown; assetBase?: unknown; fields?: unknown; pets?: unknown };
  if (m.v !== 2 || typeof m.assetBase !== "string" || !Array.isArray(m.pets)) throw new Error("invalid manifest");
  if (!Array.isArray(m.fields) || m.fields.length !== FIELDS.length || m.fields.some((f, i) => f !== FIELDS[i])) throw new Error("unexpected manifest fields");
  const base = `${m.assetBase.replace(/\/+$/, "")}/`;
  const out: PetdexPet[] = [];
  for (const row of m.pets as unknown[]) {
    if (!Array.isArray(row) || row.length !== FIELDS.length) continue;
    const [slug, name, kind, by, sheet, , , version] = row as unknown[];
    if (typeof slug !== "string" || typeof name !== "string" || typeof kind !== "string" || typeof sheet !== "string") continue;
    if (by !== null && typeof by !== "string") continue;
    let url: string;
    try {
      url = new URL(sheet, base).toString();
    } catch {
      continue;
    }
    if (!url.startsWith("https://")) continue;
    out.push({ slug, name, kind, by: by as string | null, url, version: version === 2 ? 2 : 1 });
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Find the pet a person meant by `query`: the exact slug first, then the exact display name, then a
 * slug or name that starts with the query, then one that contains it. Case-insensitive, whitespace trimmed.
 */
export function findPet(pets: PetdexPet[], query: string): PetdexPet | undefined {
  const q = norm(query);
  if (!q) return undefined;
  return (
    pets.find((p) => p.slug === q) ||
    pets.find((p) => norm(p.name) === q) ||
    pets.find((p) => p.slug.startsWith(q) || norm(p.name).startsWith(q)) ||
    pets.find((p) => p.slug.includes(q) || norm(p.name).includes(q))
  );
}

/** Up to `limit` pets matching `query` for a suggestion list, best matches first, no duplicates. */
export function suggestPets(pets: PetdexPet[], query: string, limit = 8): PetdexPet[] {
  const q = norm(query);
  if (!q) return [];
  const seen = new Set<PetdexPet>();
  const out: PetdexPet[] = [];
  const take = (pred: (p: PetdexPet) => boolean) => {
    for (const p of pets) {
      if (out.length >= limit) return;
      if (!seen.has(p) && pred(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  };
  take((p) => p.slug === q);
  take((p) => norm(p.name) === q);
  take((p) => p.slug.startsWith(q) || norm(p.name).startsWith(q));
  take((p) => p.slug.includes(q) || norm(p.name).includes(q));
  return out;
}

let cache: Promise<PetdexPet[]> | null = null;

async function fetchManifest(): Promise<PetdexPet[]> {
  let last: unknown;
  for (const url of PETDEX_MANIFESTS) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, referrerPolicy: "no-referrer", signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`petdex ${r.status}`);
      return parseManifest(await r.json());
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** The manifest, fetched once per page. A failed fetch is not cached so the next attempt retries. */
export function loadPetdex(): Promise<PetdexPet[]> {
  if (!cache) {
    cache = fetchManifest().catch((e) => {
      cache = null;
      throw e;
    });
  }
  return cache;
}

/** Look one pet up by name. Resolves to `undefined` when nothing matches; rejects when petdex is unreachable. */
export async function resolvePet(query: string): Promise<PetChoice | undefined> {
  const p = findPet(await loadPetdex(), query);
  return p && { slug: p.slug, name: p.name, by: p.by, url: p.url };
}
