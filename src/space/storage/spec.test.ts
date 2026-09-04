import { describe, expect, test } from "bun:test";
import { parseStorageSpec } from "./spec.ts";
import { databaseEnvName } from "./types.ts";

describe("parseStorageSpec", () => {
  test("absent section means no databases", () => {
    expect(parseStorageSpec(undefined)).toEqual({ databases: [] });
    expect(parseStorageSpec(null)).toEqual({ databases: [] });
  });

  test("short form declares one database named main", () => {
    expect(parseStorageSpec({ database: "sqlite" })).toEqual({ databases: [{ name: "main", backend: "sqlite" }] });
    expect(parseStorageSpec({ database: "postgresql" })).toEqual({ databases: [{ name: "main", backend: "postgres" }] });
  });

  test("long form accepts names and mappings", () => {
    expect(parseStorageSpec({ databases: ["news", { name: "cache" }, { name: "main", backend: "postgres" }] })).toEqual({
      databases: [
        { name: "news", backend: "sqlite" },
        { name: "cache", backend: "sqlite" },
        { name: "main", backend: "postgres" },
      ],
    });
  });

  test("rejects bad input", () => {
    expect(() => parseStorageSpec("sqlite")).toThrow(/mapping/);
    expect(() => parseStorageSpec({ database: "mysql" })).toThrow(/sqlite or postgres/);
    expect(() => parseStorageSpec({ database: "sqlite", databases: [] })).toThrow(/not both/);
    expect(() => parseStorageSpec({ databases: "x" })).toThrow(/list/);
    expect(() => parseStorageSpec({ databases: [{ backend: "sqlite" }] })).toThrow(/name/);
    expect(() => parseStorageSpec({ databases: ["a", "a"] })).toThrow(/duplicate/);
    expect(() => parseStorageSpec({ databases: ["../x"] })).toThrow(/name/);
  });
});

test("databaseEnvName", () => {
  expect(databaseEnvName("main")).toBe("DATABASE_URL");
  expect(databaseEnvName("news")).toBe("DATABASE_URL_NEWS");
  expect(databaseEnvName("tg-signals")).toBe("DATABASE_URL_TG_SIGNALS");
  expect(databaseEnvName("a.b")).toBe("DATABASE_URL_A_B");
});
