import { describe, expect, test } from "bun:test";
import { DISCORD_MARKDOWN, HTML, PLAIN, renderFields, renderText, splitParts, splitText } from "./render.ts";
import type { Notification } from "./types.ts";

const base: Notification = { id: "n_1", app: "my-app", level: "info", text: "Hello", createdAt: 0 };

describe("splitParts", () => {
  test("title becomes the headline, text the body, url the trailer", () => {
    expect(splitParts({ ...base, title: "Feed stalled", text: "No items for 3h.", url: "https://x.test/1" }, "My App")).toEqual({
      headline: "[My App] Feed stalled",
      body: "No items for 3h.",
      url: "https://x.test/1",
    });
  });

  test("without a title the first line of text is the headline", () => {
    expect(splitParts({ ...base, text: "First line\nsecond\nthird" }, "my-app")).toEqual({ headline: "[my-app] First line", body: "second\nthird" });
  });

  test("levels prepend their emoji once, and never in front of a headline that already starts with one", () => {
    expect(splitParts({ ...base, level: "alert", text: "Down" }, "app").headline).toBe("🚨 [app] Down");
    expect(splitParts({ ...base, level: "warn", text: "🐋 Whale moved" }, "app").headline).toBe("[app] 🐋 Whale moved");
    expect(splitParts({ ...base, level: "report", title: "Daily", text: "…" }, "app").headline).toBe("📊 [app] Daily");
    expect(splitParts({ ...base, level: "success", text: "Done" }, "app").headline).toBe("✅ [app] Done");
  });
});

describe("renderText", () => {
  const n: Notification = { ...base, level: "warn", title: "A <b> & c", text: "x < y\n1 & 2", url: "https://x.test/?a=1&b=2" };

  test("HTML escapes everything and bolds the headline", () => {
    expect(renderText(n, "App", HTML)).toBe("<b>⚠️ [App] A &lt;b&gt; &amp; c</b>\nx &lt; y\n1 &amp; 2\nhttps://x.test/?a=1&amp;b=2");
  });

  test("Discord markdown escapes specials", () => {
    expect(renderText({ ...base, title: "a*b_c", text: "`code` and #tag" }, "App", DISCORD_MARKDOWN)).toBe("**[App] a\\*b\\_c**\n\\`code\\` and #tag");
  });

  test("plain text passes through unchanged", () => {
    expect(renderText(n, "App", PLAIN)).toBe("⚠️ [App] A <b> & c\nx < y\n1 & 2\nhttps://x.test/?a=1&b=2");
  });

  test("renderFields gives push channels a title and a body that is never empty", () => {
    expect(renderFields({ ...base, text: "Only headline" }, "App")).toEqual({ title: "[App] Only headline", body: "[App] Only headline" });
    expect(renderFields(n, "App")).toEqual({ title: "⚠️ [App] A <b> & c", body: "x < y\n1 & 2", url: "https://x.test/?a=1&b=2" });
  });
});

describe("splitText", () => {
  test("returns one part when the text fits", () => {
    expect(splitText("short", { splitAt: 100 })).toEqual(["short"]);
  });

  test("splits at line boundaries and numbers the parts", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
    const parts = splitText(lines.join("\n"), { splitAt: 80 });
    expect(parts.length).toBeGreaterThan(2);
    for (const [i, p] of parts.entries()) {
      expect(p.startsWith(`(${i + 1}/${parts.length}) `)).toBe(true);
      expect(p.length).toBeLessThanOrEqual(80);
    }
    expect(parts.map((p) => p.replace(/^\(\d+\/\d+\) /, "")).join("\n")).toBe(lines.join("\n"));
  });

  test("hard-cuts a single line longer than the limit", () => {
    const parts = splitText("a".repeat(100), { splitAt: 40 });
    expect(parts.every((p) => p.length <= 40)).toBe(true);
    expect(parts.map((p) => p.replace(/^\(\d+\/\d+\) /, "")).join("")).toBe("a".repeat(100));
  });

  test("measures bytes when asked, so multi-byte text stays under a byte limit", () => {
    const text = Array.from({ length: 30 }, () => "汉字汉字汉字汉字").join("\n"); // 24 bytes per line
    const parts = splitText(text, { splitAt: 100, bytes: true });
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(100);
  });
});
