import { describe, expect, test } from "bun:test";
import { fmtDuration, relTime, scheduleText, untilTime } from "./api.ts";
import { LANGS, MESSAGES, detectLang, localized, translate, withLang } from "./i18n.ts";

describe("dictionaries", () => {
  test("every language has every key of English and no empty text", () => {
    const keys = Object.keys(MESSAGES.en).sort();
    for (const { code } of LANGS) {
      expect(Object.keys(MESSAGES[code]).sort()).toEqual(keys);
      for (const [k, v] of Object.entries(MESSAGES[code])) expect(v.trim(), `${code}: ${k}`).not.toBe("");
    }
  });

  test("placeholders match between languages", () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const [k, en] of Object.entries(MESSAGES.en)) expect(holes(MESSAGES.zh[k as keyof typeof MESSAGES.en]), k).toEqual(holes(en));
  });
});

describe("translate", () => {
  test("fills placeholders and leaves unknown ones visible", () => {
    expect(translate("en", "settings.snapshot", { time: "3 min ago" })).toBe("snapshot 3 min ago");
    expect(translate("zh", "uninstall.stopService", { port: 8710 })).toBe("停止它的服务（端口 8710）。");
    expect(translate("en", "tasks.summary", { active: 2 })).toBe("2 of {total} active");
  });
});

describe("detectLang", () => {
  test("matches on the primary tag, in order, and falls back to English", () => {
    expect(detectLang(["zh-CN", "en-US"])).toBe("zh");
    expect(detectLang(["fr-FR", "zh-Hant-TW"])).toBe("zh");
    expect(detectLang(["en-GB"])).toBe("en");
    expect(detectLang(["fr", "de"])).toBe("en");
    expect(detectLang([])).toBe("en");
  });
});

describe("localized", () => {
  const app = { title: "Notes", description: "Personal notes.", i18n: { "zh-Hant": { title: "筆記" }, zh: { title: "笔记" } } };
  test("prefers the exact tag, then the primary tag, then the plain field", () => {
    expect(localized("zh", app)).toEqual({ title: "笔记", description: "Personal notes." });
    expect(localized("zh", { title: "Notes", i18n: { "zh-Hant": { title: "筆記", description: "個人筆記。" } } })).toEqual({ title: "筆記", description: "個人筆記。" });
    expect(localized("en", app)).toEqual({ title: "Notes", description: "Personal notes." });
    expect(localized("zh", { title: "Plain" })).toEqual({ title: "Plain" });
  });
});

describe("withLang", () => {
  test("fills the placeholder, raw or percent-encoded, and leaves other urls alone", () => {
    expect(withLang("https://a.example.com/?lang={lang}", "zh")).toBe("https://a.example.com/?lang=zh");
    expect(withLang("https://a.example.com/%7Blang%7D/", "en")).toBe("https://a.example.com/en/");
    expect(withLang("https://a.example.com/", "zh")).toBe("https://a.example.com/");
  });
});

describe("time helpers take the language", () => {
  test("durations", () => {
    expect(fmtDuration(500)).toBe("500 ms");
    expect(fmtDuration(90_000)).toBe("1m 30s");
    expect(fmtDuration(90_000, "zh")).toBe("1 分 30 秒");
    expect(fmtDuration(3 * 3_600_000, "zh")).toBe("3 小时");
    expect(fmtDuration(25 * 3_600_000, "zh")).toBe("1 天 1 小时");
  });

  test("relative and forward times", () => {
    const now = Date.now();
    expect(relTime(now)).toBe("just now");
    expect(relTime(now - 5 * 60_000, "zh")).toBe("5 分钟前");
    expect(relTime(now - 2 * 3_600_000, "zh")).toBe("2 小时前");
    expect(relTime(now - 3 * 86_400_000)).toBe("3 d ago");
    expect(untilTime(new Date(now + 10_000).toISOString(), "zh")).toBe("现在");
    expect(untilTime(new Date(now + 5 * 60_000).toISOString(), "zh")).toBe("5 分钟后");
    expect(untilTime(new Date(now + 5 * 60_000).toISOString())).toBe("in 5 min");
  });

  test("schedules", () => {
    expect(scheduleText({ kind: "every", everyMs: 30 * 60_000 })).toBe("every 30m");
    expect(scheduleText({ kind: "every", everyMs: 30 * 60_000 }, "zh")).toBe("每 30 分");
    expect(scheduleText({ kind: "cron", expr: "0 9 * * *", tz: "Asia/Seoul" }, "zh")).toBe("0 9 * * * (Asia/Seoul)");
    expect(scheduleText({ kind: "at", at: "2030-01-01T00:00:00Z" }, "zh")).toMatch(/运行一次$/);
  });
});
