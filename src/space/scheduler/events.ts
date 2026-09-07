import type { EventInput, EventTrigger, SpaceEvent } from "./types.ts";

/**
 * Events: names, matching and the payload a triggered run receives.
 *
 * An app publishes `{ name, data }`; the scheduler stores it as `<app>/<name>`
 * and hands it to every enabled task whose `triggers` match. Matching is exact
 * on the qualified name (or `<app>/*`), then by string equality on top-level
 * `data` fields named in `filter`. No expressions: an app that needs more
 * publishes a more specific event.
 */

const SEGMENT = "[a-z0-9][a-z0-9._-]*";
const EVENT_NAME_RE = new RegExp(`^${SEGMENT}$`, "i");
const TRIGGER_RE = new RegExp(`^${SEGMENT}/(${SEGMENT}|\\*)$`, "i");
export const MAX_EVENT_DATA_BYTES = 64 * 1024;

export function assertEventName(name: string): void {
  if (!EVENT_NAME_RE.test(name)) throw new Error(`invalid event name "${name}": letters, digits, dots, dashes and underscores`);
}

export function assertTriggerEvent(event: string): void {
  if (!TRIGGER_RE.test(event)) throw new Error(`invalid trigger event "${event}": expected <app>/<event> or <app>/*`);
}

/** Validate an event as published; returns the normalized input. */
export function parseEventInput(app: string, raw: Record<string, unknown>): EventInput {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  assertEventName(name);
  const data = raw.data === undefined || raw.data === null ? {} : raw.data;
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("data must be a JSON object");
  const bytes = Buffer.byteLength(JSON.stringify(data));
  if (bytes > MAX_EVENT_DATA_BYTES) throw new Error(`data is ${bytes} bytes; the limit is ${MAX_EVENT_DATA_BYTES}`);
  return { app, name, data: data as Record<string, unknown> };
}

export function qualifiedName(input: { app: string; name: string }): string {
  return `${input.app}/${input.name}`;
}

/** Does one trigger accept the event? Name first, then every filter field. */
export function matches(trigger: EventTrigger, event: SpaceEvent): boolean {
  const slash = trigger.event.indexOf("/");
  const app = trigger.event.slice(0, slash);
  const name = trigger.event.slice(slash + 1);
  if (app !== event.app) return false;
  if (name !== "*" && `${event.app}/${name}` !== event.name) return false;
  for (const [key, accepted] of Object.entries(trigger.filter ?? {})) {
    const v = event.data[key];
    if (v === undefined || v === null || typeof v === "object") return false;
    const text = String(v);
    if (Array.isArray(accepted) ? !accepted.includes(text) : accepted !== text) return false;
  }
  return true;
}

/** The triggers of a task that accept the event; empty when none. */
export function matchingTriggers(triggers: EventTrigger[] | undefined, event: SpaceEvent): EventTrigger[] {
  return (triggers ?? []).filter((t) => matches(t, event));
}

/** What a run sees of its events, in the order they were published. */
export type EventPayload = { name: string; app: string; at: string; data: Record<string, unknown> };

export function eventPayload(e: SpaceEvent): EventPayload {
  return { name: e.name, app: e.app, at: new Date(e.at).toISOString(), data: e.data };
}

/**
 * Environment for command and agent targets: `SPACE_TRIGGER`, and when events were
 * delivered, `SPACE_EVENT` (the latest one) and `SPACE_EVENTS` (all of them) as JSON.
 */
export function eventEnv(trigger: string, events: SpaceEvent[]): Record<string, string> {
  const env: Record<string, string> = { SPACE_TRIGGER: trigger };
  if (events.length) {
    const payloads = events.map(eventPayload);
    env.SPACE_EVENTS = JSON.stringify(payloads);
    env.SPACE_EVENT = JSON.stringify(payloads[payloads.length - 1]);
  }
  return env;
}

/** A section appended to an agent prompt so the session knows why it runs. */
export function eventPromptSection(events: SpaceEvent[]): string {
  const payloads = events.map(eventPayload);
  const head = payloads.length === 1 ? "This run was triggered by one event:" : `This run was triggered by ${payloads.length} events, oldest first:`;
  return `\n\n## Events\n\n${head}\n\n\`\`\`json\n${JSON.stringify(payloads, null, 2)}\n\`\`\`\n`;
}
