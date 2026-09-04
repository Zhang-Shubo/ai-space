/**
 * Peer configuration on the hub: `SPACE_PEER_<NAME>=<url>` lines in the
 * workspace .env, one per peer, with optional companions:
 *
 *   SPACE_PEER_<NAME>_TOKEN=<the peer's SPACE_HUB_TOKEN>
 *   SPACE_PEER_<NAME>_HEADERS=Name: value; Name: value   (an access layer in front of the peer)
 *   SPACE_PEER_<NAME>_REFRESH=30s                        (snapshot refresh; default 30s, minimum 10s)
 *
 * NAME is lowercased and `_` becomes `-` to form the peer name, as notify
 * channels do. A malformed peer rejects that one peer (reported, not thrown)
 * and leaves the others alone.
 */

export const ENV_PREFIX = "SPACE_PEER_";
const SUFFIXES = ["_TOKEN", "_HEADERS", "_REFRESH"] as const;

export const PEER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DEFAULT_REFRESH_MS = 30_000;
export const MIN_REFRESH_MS = 10_000;

export type PeerConfig = {
  name: string;
  /** Base URL of the peer's ai-space, without a trailing slash. */
  url: string;
  token: string;
  /** Extra request headers, e.g. an access layer's service credentials. */
  headers: Record<string, string>;
  refreshMs: number;
};

export type PeerLoad = {
  peers: PeerConfig[];
  /** Peers that failed to parse, with the reason. */
  errors: Map<string, string>;
};

/** Read every `SPACE_PEER_*` variable from an environment map. */
export function loadPeers(env: Record<string, string | undefined> = process.env): PeerLoad {
  const urls = new Map<string, string>();
  const extras = new Map<string, Partial<Record<(typeof SUFFIXES)[number], string>>>();
  const errors = new Map<string, string>();

  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(ENV_PREFIX) || raw === undefined) continue;
    const rest = key.slice(ENV_PREFIX.length);
    const suffix = SUFFIXES.find((s) => rest.endsWith(s) && rest.length > s.length);
    if (suffix) {
      const name = envToName(rest.slice(0, -suffix.length));
      const cur = extras.get(name) ?? {};
      cur[suffix] = raw;
      extras.set(name, cur);
      continue;
    }
    const name = envToName(rest);
    if (!PEER_NAME_RE.test(name)) {
      errors.set(name || key, `invalid peer name in ${key}`);
      continue;
    }
    urls.set(name, raw.trim());
  }

  for (const name of extras.keys()) {
    if (!urls.has(name) && !errors.has(name)) errors.set(name, `${ENV_PREFIX}${nameToEnv(name)} is not set`);
  }

  const peers: PeerConfig[] = [];
  for (const [name, url] of urls) {
    const x = extras.get(name) ?? {};
    try {
      peers.push({ name, url: parseUrl(url), token: (x._TOKEN ?? "").trim(), headers: parseHeaders(x._HEADERS ?? ""), refreshMs: parseRefresh(x._REFRESH) });
    } catch (e) {
      errors.set(name, (e as Error).message);
    }
  }
  peers.sort((a, b) => a.name.localeCompare(b.name));
  return { peers, errors };
}

function parseUrl(raw: string): string {
  if (!/^https?:\/\//.test(raw)) throw new Error("url must start with http:// or https://");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("url is not a valid URL");
  }
  if (u.search || u.hash) throw new Error("url must not carry a query or a fragment");
  return u.toString().replace(/\/+$/, "");
}

/** `Name: value; Name: value` → a header map. */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf(":");
    if (i <= 0) throw new Error(`header "${p}" is not "Name: value"`);
    const name = p.slice(0, i).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`invalid header name "${name}"`);
    out[name] = p.slice(i + 1).trim();
  }
  return out;
}

/** `30s`, `2m`, `1h` or plain seconds; clamped to the minimum. */
export function parseRefresh(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REFRESH_MS;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) throw new Error(`invalid refresh "${raw}"`);
  const n = Number(m[1]);
  const ms = m[2] === "ms" ? n : m[2] === "m" ? n * 60_000 : m[2] === "h" ? n * 3_600_000 : n * 1000;
  return Math.max(MIN_REFRESH_MS, Math.round(ms));
}

function envToName(rest: string): string {
  return rest.toLowerCase().replace(/_/g, "-");
}

function nameToEnv(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}
