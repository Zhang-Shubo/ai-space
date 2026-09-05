import type { Keep } from "./types.ts";

/**
 * Retention: which snapshots stay. Counted, not dated, so a machine that was
 * off for a week does not delete everything on its first run back.
 *
 * - the newest `daily` snapshots,
 * - the first snapshot of each of the newest `weekly` ISO weeks,
 * - the first snapshot of each of the newest `monthly` months.
 *
 * A snapshot that failed verification never fills a slot and is dropped, unless
 * it is the only thing left.
 */

export type Candidate = { key: string; at: number; failed?: boolean };

export function selectRetained(candidates: Candidate[], keep: Keep): { keep: string[]; drop: string[] } {
  const sorted = [...candidates].sort((a, b) => b.at - a.at);
  const good = sorted.filter((c) => !c.failed);
  const kept = new Set<string>();

  for (const c of good.slice(0, keep.daily)) kept.add(c.key);
  for (const key of firstOfPeriods(good, isoWeek, keep.weekly)) kept.add(key);
  for (const key of firstOfPeriods(good, month, keep.monthly)) kept.add(key);

  if (kept.size === 0 && sorted[0]) kept.add(sorted[0].key);
  return {
    keep: sorted.filter((c) => kept.has(c.key)).map((c) => c.key),
    drop: sorted.filter((c) => !kept.has(c.key)).map((c) => c.key),
  };
}

/** The earliest snapshot of each of the `count` newest periods. */
function firstOfPeriods(sortedDesc: Candidate[], period: (ms: number) => string, count: number): string[] {
  if (count <= 0) return [];
  const first = new Map<string, Candidate>();
  for (const c of sortedDesc) first.set(period(c.at), c); // descending order: the last write per period is its earliest snapshot
  return [...first.values()].slice(0, count).map((c) => c.key);
}

export function month(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** ISO 8601 week, e.g. `2026-W36`, computed in UTC. */
export function isoWeek(ms: number): string {
  const d = new Date(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
