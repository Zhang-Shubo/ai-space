import { Cron } from "croner";
import type { Schedule } from "./types.ts";

/**
 * Compute the next run time strictly after `nowMs`, or undefined when the
 * schedule has no future occurrence (a one-shot in the past, an empty cron).
 */
export function nextRunAt(schedule: Schedule, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case "at": {
      const atMs = Date.parse(schedule.at);
      if (!Number.isFinite(atMs)) return undefined;
      return atMs > nowMs ? atMs : undefined;
    }
    case "every": {
      const everyMs = Math.max(1, Math.floor(schedule.everyMs));
      const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
      if (nowMs < anchor) return anchor;
      const steps = Math.floor((nowMs - anchor) / everyMs) + 1;
      return anchor + steps * everyMs;
    }
    case "cron": {
      const expr = schedule.expr.trim();
      if (!expr) return undefined;
      const cron = new Cron(expr, { timezone: schedule.tz || undefined, catch: false });
      const next = cron.nextRun(new Date(nowMs));
      if (!next) return undefined;
      const nextMs = next.getTime();
      if (nextMs > nowMs) return nextMs;
      // croner can return the current instant on second boundaries; retry from the next whole second.
      const retry = cron.nextRun(new Date(Math.floor(nowMs / 1000) * 1000 + 1000));
      return retry && retry.getTime() > nowMs ? retry.getTime() : undefined;
    }
  }
}

/** Validate a schedule without computing anything; throws with a readable message. */
export function assertSchedule(schedule: Schedule): void {
  switch (schedule.kind) {
    case "at":
      if (!Number.isFinite(Date.parse(schedule.at))) throw new Error(`invalid at timestamp: ${schedule.at}`);
      return;
    case "every":
      if (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0) {
        throw new Error(`invalid every interval: ${schedule.everyMs}`);
      }
      return;
    case "cron":
      try {
        new Cron(schedule.expr, { timezone: schedule.tz || undefined, catch: false }).nextRun();
      } catch (e) {
        throw new Error(`invalid cron expression "${schedule.expr}": ${(e as Error).message}`);
      }
      return;
    default:
      throw new Error(`unknown schedule kind: ${String((schedule as { kind: unknown }).kind)}`);
  }
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse "30m", "6h", "90s", "1d", "250ms" or a bare number of milliseconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) throw new Error(`invalid duration: ${input}`);
    return Math.floor(input);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/i.exec(input);
  if (!m) throw new Error(`invalid duration: "${input}"`);
  const value = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const ms = value * (DURATION_UNITS[unit] ?? 1);
  if (ms <= 0) throw new Error(`invalid duration: "${input}"`);
  return Math.floor(ms);
}
