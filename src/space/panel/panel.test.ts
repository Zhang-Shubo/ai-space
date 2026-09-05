import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { LayoutStore, orderBy } from "./layout.ts";
import { linkManifest, parseLinkApp } from "./links.ts";
import { iconUrl, resolveLink } from "./view.ts";

describe("layout", () => {
  test("orderBy puts unknown names after ordered ones, alphabetically", () => {
    const items = ["c", "a", "b", "d"].map((name) => ({ name }));
    expect(orderBy(items, ["d", "b"], (i) => i.name).map((i) => i.name)).toEqual(["d", "b", "a", "c"]);
  });

  test("store round-trips, validates and dedupes", () => {
    const store = new LayoutStore(new Database(":memory:"));
    expect(store.read()).toEqual({ order: { apps: [], agents: [], widgets: [] }, hidden: [], sizes: {} });
    store.update({ order: { apps: ["b", "a", "b", 3 as unknown as string] } });
    store.update({ hidden: ["x"] });
    expect(store.read()).toEqual({ order: { apps: ["b", "a"], agents: [], widgets: [] }, hidden: ["x"], sizes: {} });
    expect(store.hide("y", true).hidden).toEqual(["x", "y"]);
    expect(store.hide("x", false).hidden).toEqual(["y"]);
    expect(() => store.update({ hidden: "x" as unknown as string[] })).toThrow(/hidden must be/);
  });
});

describe("links", () => {
  test("parseLinkApp normalises and rejects bad input", () => {
    expect(parseLinkApp({ name: " My-App ", title: "  My   App ", url: "https://a.example.com", icon: "🔧", description: "x" })).toEqual({ name: "my-app", title: "My App", description: "x", icon: "🔧", url: "https://a.example.com" });
    expect(() => parseLinkApp({ name: "bad name" })).toThrow(/kebab-case/);
    expect(() => parseLinkApp({ name: "a", url: "ftp://x" })).toThrow(/url must/);
    expect(() => parseLinkApp({ name: "a", icon: "icons/x.svg" })).toThrow(/icon must/);
    expect(() => parseLinkApp({ name: "a", title: 3 })).toThrow(/title must be/);
  });

  test("linkManifest parses back through parseManifest", () => {
    const yaml = linkManifest({ name: "tool", title: 'A "quoted" tool', url: "https://t.example.com/#x", icon: "🔧", repo: "https://github.com/x/tool.git" });
    const m = parseManifest(yaml, "/apps/tool");
    expect(m).toMatchObject({ app: "tool", title: 'A "quoted" tool', url: "https://t.example.com/#x", icon: "🔧", repo: "https://github.com/x/tool.git", status: "active" });
    expect(m.service).toBeUndefined();
  });
});

describe("view", () => {
  const m = parseManifest("name: n\nicon: icon.svg\nurl: https://n.example.com/app/\n", "/apps/n");
  test("iconUrl distinguishes emoji, urls and files", () => {
    expect(iconUrl(m)).toBe("/api/apps/n/icon");
    expect(iconUrl({ ...m, icon: "📦" })).toBe("📦");
    expect(iconUrl({ ...m, icon: "https://x/i.png" })).toBe("https://x/i.png");
    expect(iconUrl({ ...m, icon: undefined })).toBe("📦");
  });
  test("resolveLink resolves against the app url", () => {
    expect(resolveLink(m, "/#recent")).toBe("https://n.example.com/#recent");
    expect(resolveLink(m, "list")).toBe("https://n.example.com/app/list");
    expect(resolveLink(m, undefined)).toBe("https://n.example.com/app/");
    expect(resolveLink({ ...m, url: undefined }, "/x")).toBe("");
  });
});
