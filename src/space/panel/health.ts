/**
 * Service health probe with a short cache, so listing apps costs at most one
 * loopback request per service every `ttlMs`. Service supervision is not
 * implemented yet; the probe is what tells the panel "up" from "down".
 */

export type Health = "ok" | "down";

export class HealthProbe {
  private readonly cache = new Map<string, { at: number; health: Health }>();

  constructor(
    private readonly opts: { ttlMs?: number; timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {}

  async check(port: number, path: string): Promise<Health> {
    const url = `http://127.0.0.1:${port}${path}`;
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < (this.opts.ttlMs ?? 15_000)) return hit.health;
    let health: Health = "down";
    try {
      const r = await (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2_000) });
      health = r.ok ? "ok" : "down";
    } catch {
      health = "down";
    }
    this.cache.set(url, { at: Date.now(), health });
    return health;
  }
}
