import { describe, expect, test } from "bun:test";
import { parsePrefix, parseStorageSpec } from "./spec.ts";
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

describe("parseStorageSpec blobs", () => {
  test("short forms", () => {
    expect(parseStorageSpec({ blobs: "none" })).toEqual({ databases: [] });
    expect(parseStorageSpec({ blobs: "file" })).toEqual({ databases: [], blobs: { backend: "file" } });
    expect(parseStorageSpec({ database: "sqlite", blobs: "s3" })).toEqual({
      databases: [{ name: "main", backend: "sqlite" }],
      blobs: { backend: "s3" },
    });
  });

  test("mapping form with bucket and prefix", () => {
    expect(parseStorageSpec({ blobs: { backend: "s3", bucket: "media", prefix: "" } })).toEqual({
      databases: [],
      blobs: { backend: "s3", bucket: "media", prefix: "" },
    });
    expect(parseStorageSpec({ blobs: { backend: "s3", prefix: "/photos/2026" } }).blobs).toEqual({ backend: "s3", prefix: "photos/2026/" });
  });

  test("rejects bad input", () => {
    expect(() => parseStorageSpec({ blobs: "gcs" })).toThrow(/file or s3/);
    expect(() => parseStorageSpec({ blobs: ["s3"] })).toThrow(/mapping/);
    expect(() => parseStorageSpec({ blobs: { backend: "file", bucket: "x" } })).toThrow(/only applies to the s3/);
    expect(() => parseStorageSpec({ blobs: { backend: "s3", prefix: "../x" } })).toThrow(/invalid prefix/);
    expect(() => parseStorageSpec({ blobs: { backend: "s3", bucket: "bad name" } })).toThrow(/bucket/);
  });
});

test("parsePrefix normalises slashes", () => {
  expect(parsePrefix("", "p")).toBe("");
  expect(parsePrefix("a", "p")).toBe("a/");
  expect(parsePrefix("//a/b/", "p")).toBe("a/b/");
  expect(() => parsePrefix("a//b", "p")).toThrow(/invalid prefix/);
});

test("databaseEnvName", () => {
  expect(databaseEnvName("main")).toBe("DATABASE_URL");
  expect(databaseEnvName("news")).toBe("DATABASE_URL_NEWS");
  expect(databaseEnvName("tg-signals")).toBe("DATABASE_URL_TG_SIGNALS");
  expect(databaseEnvName("a.b")).toBe("DATABASE_URL_A_B");
});
