import { describe, expect, test } from "bun:test";
import { assertEventName, assertTriggerEvent, eventEnv, eventPromptSection, matches, parseEventInput } from "./events.ts";
import type { SpaceEvent } from "./types.ts";

const ev = (name: string, data: Record<string, unknown> = {}, app = "feed"): SpaceEvent => ({ id: 7, name: `${app}/${name}`, app, data, at: Date.parse("2026-09-08T00:00:00Z") });

describe("event names", () => {
  test("names are one segment, triggers are app/event or app/*", () => {
    assertEventName("item.added");
    assertEventName("video-ingested_2");
    expect(() => assertEventName("feed/item")).toThrow(/invalid event name/);
    expect(() => assertEventName("")).toThrow(/invalid event name/);
    assertTriggerEvent("feed/item.added");
    assertTriggerEvent("feed/*");
    expect(() => assertTriggerEvent("item.added")).toThrow(/expected <app>\/<event>/);
    expect(() => assertTriggerEvent("feed/a/b")).toThrow(/expected <app>\/<event>/);
  });

  test("parseEventInput normalizes data and caps its size", () => {
    expect(parseEventInput("feed", { name: " item.added " })).toEqual({ app: "feed", name: "item.added", data: {} });
    expect(parseEventInput("feed", { name: "x", data: { id: 1 } }).data).toEqual({ id: 1 });
    expect(() => parseEventInput("feed", { name: "x", data: [1] })).toThrow(/JSON object/);
    expect(() => parseEventInput("feed", { name: "x", data: { blob: "x".repeat(70_000) } })).toThrow(/limit/);
  });
});

describe("matching", () => {
  test("exact name, wildcard, and never across apps", () => {
    expect(matches({ event: "feed/item.added" }, ev("item.added"))).toBe(true);
    expect(matches({ event: "feed/item.removed" }, ev("item.added"))).toBe(false);
    expect(matches({ event: "feed/*" }, ev("anything"))).toBe(true);
    expect(matches({ event: "other/*" }, ev("anything"))).toBe(false);
    expect(matches({ event: "feed/item.added" }, ev("item.added", {}, "other"))).toBe(false);
  });

  test("filters compare top-level data fields as strings, lists mean any of", () => {
    const e = ev("item.added", { channel: "news", n: 3, nested: { a: 1 } });
    expect(matches({ event: "feed/*", filter: { channel: "news" } }, e)).toBe(true);
    expect(matches({ event: "feed/*", filter: { channel: ["sports", "news"] } }, e)).toBe(true);
    expect(matches({ event: "feed/*", filter: { channel: "sports" } }, e)).toBe(false);
    expect(matches({ event: "feed/*", filter: { n: "3" } }, e)).toBe(true);
    expect(matches({ event: "feed/*", filter: { missing: "x" } }, e)).toBe(false);
    expect(matches({ event: "feed/*", filter: { nested: "x" } }, e)).toBe(false);
  });
});

describe("payload", () => {
  test("env carries the trigger, the latest event and all of them", () => {
    expect(eventEnv("schedule", [])).toEqual({ SPACE_TRIGGER: "schedule" });
    const env = eventEnv("event", [ev("a", { i: 1 }), ev("b", { i: 2 })]);
    expect(env.SPACE_TRIGGER).toBe("event");
    expect(JSON.parse(env.SPACE_EVENT!)).toEqual({ name: "feed/b", app: "feed", at: "2026-09-08T00:00:00.000Z", data: { i: 2 } });
    expect(JSON.parse(env.SPACE_EVENTS!)).toHaveLength(2);
  });

  test("the prompt section lists the events as JSON", () => {
    const one = eventPromptSection([ev("a")]);
    expect(one).toContain("## Events");
    expect(one).toContain("one event");
    expect(eventPromptSection([ev("a"), ev("b")])).toContain("2 events, oldest first");
  });
});
