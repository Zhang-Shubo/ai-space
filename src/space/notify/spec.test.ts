import { describe, expect, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { parseNotificationInput, parseNotifySpec } from "./spec.ts";

describe("parseNotifySpec", () => {
  test("missing section gives the default channel and window, with the app title when known", () => {
    expect(parseNotifySpec(undefined)).toEqual({ default: "default", channels: ["default"], windowMs: 600_000 });
    expect(parseNotifySpec(null, { title: "My App" })).toEqual({ default: "default", channels: ["default"], windowMs: 600_000, title: "My App" });
  });

  test("channels, default, title and window", () => {
    expect(parseNotifySpec({ default: "ops", channels: ["ops", "trades"], title: "Trader", window: "30m" }, { title: "ignored" })).toEqual({
      default: "ops",
      channels: ["ops", "trades"],
      title: "Trader",
      windowMs: 30 * 60_000,
    });
  });

  test("default alone implies the channel list; the first channel is the default otherwise", () => {
    expect(parseNotifySpec({ default: "ops" })).toMatchObject({ default: "ops", channels: ["ops"] });
    expect(parseNotifySpec({ channels: ["a", "b"] })).toMatchObject({ default: "a", channels: ["a", "b"] });
  });

  test("rejects unknown keys, bad names, duplicates and a default outside the list", () => {
    expect(() => parseNotifySpec("ops")).toThrow(/mapping/);
    expect(() => parseNotifySpec({ chanels: [] })).toThrow(/unknown key "chanels"/);
    expect(() => parseNotifySpec({ channels: [] })).toThrow(/non-empty/);
    expect(() => parseNotifySpec({ channels: ["Ops"] })).toThrow(/invalid channel name/);
    expect(() => parseNotifySpec({ channels: ["a", "a"] })).toThrow(/duplicates/);
    expect(() => parseNotifySpec({ default: "x", channels: ["a"] })).toThrow(/not in notify.channels/);
    expect(() => parseNotifySpec({ title: "" })).toThrow(/title/);
    expect(() => parseNotifySpec({ window: "soon" })).toThrow(/duration/);
  });
});

describe("parseNotificationInput", () => {
  test("accepts the documented fields", () => {
    expect(
      parseNotificationInput({
        level: "alert",
        title: " Feed stalled ",
        text: "No items.\n",
        url: "https://x.test/1",
        image: { url: "https://x.test/i.png" },
        channels: ["ops"],
        key: "feed",
        window: "5m",
        wait: true,
      }),
    ).toEqual({
      level: "alert",
      title: "Feed stalled",
      text: "No items.",
      url: "https://x.test/1",
      image: { url: "https://x.test/i.png" },
      channels: ["ops"],
      key: "feed",
      windowMs: 300_000,
      wait: true,
    });
  });

  test("a title alone is enough; channel is an alias for a one-element channels list", () => {
    expect(parseNotificationInput({ title: "Done" })).toEqual({ title: "Done", text: "Done" });
    expect(parseNotificationInput({ text: "x", channel: "ops" })).toEqual({ text: "x", channels: ["ops"] });
    expect(parseNotificationInput({ text: "x", image: { data: "aGVsbG8=", type: "image/jpeg" } }).image).toEqual({ data: "aGVsbG8=", type: "image/jpeg" });
  });

  test("rejects bad input with the field name", () => {
    expect(() => parseNotificationInput("hi")).toThrow(/JSON object/);
    expect(() => parseNotificationInput({})).toThrow(/text is required/);
    expect(() => parseNotificationInput({ text: "x", level: "loud" })).toThrow(/level must be one of/);
    expect(() => parseNotificationInput({ text: "x", url: "ftp://x" })).toThrow(/url/);
    expect(() => parseNotificationInput({ text: "x", channels: [] })).toThrow(/channels/);
    expect(() => parseNotificationInput({ text: "x", channels: ["Bad!"] })).toThrow(/channels\[0\]/);
    expect(() => parseNotificationInput({ text: "x", key: "" })).toThrow(/key/);
    expect(() => parseNotificationInput({ text: "x", image: {} })).toThrow(/image/);
    expect(() => parseNotificationInput({ text: "x", image: { data: "abc", type: "image/bmp" } })).toThrow(/image.type/);
    expect(() => parseNotificationInput({ text: "x", wait: "yes" })).toThrow(/wait/);
  });
});

describe("manifest notify fields", () => {
  test("top-level title and notify pass through; task notify is parsed", () => {
    const m = parseManifest(
      `name: my-app
title: My App
notify:
  channels: [ops]
tasks:
  - name: a
    every: 5m
    notify: { when: [error, ok], channel: ops }
    run: { command: "true" }
  - name: b
    every: 5m
    notify: true
    run: { command: "true" }
  - name: c
    every: 5m
    notify: { when: recover }
    run: { command: "true" }
`,
      "/apps/my-app",
    );
    expect(m.title).toBe("My App");
    expect(m.notify).toEqual({ channels: ["ops"] });
    expect(m.tasks.map((t) => t.notify)).toEqual([{ when: ["error", "ok"], channel: "ops" }, { when: ["error"] }, { when: ["recover"] }]);
  });

  test("rejects a bad task notify block", () => {
    const yaml = (notify: string) => `name: a\ntasks:\n  - name: t\n    every: 5m\n    notify: ${notify}\n    run: { command: "true" }\n`;
    expect(() => parseManifest(yaml("{ when: [boom] }"), "/a")).toThrow(/notify.when/);
    expect(() => parseManifest(yaml("{ when: [] }"), "/a")).toThrow(/at least one/);
    expect(() => parseManifest(yaml("{ channel: 'Bad Name' }"), "/a")).toThrow(/notify.channel/);
    expect(() => parseManifest(yaml("{ on: error }"), "/a")).toThrow(/unknown key "true"/);
    expect(() => parseManifest("name: a\ntitle: ''\n", "/a")).toThrow(/title/);
  });
});
