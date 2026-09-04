import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "./index.ts";

test("loadConfig applies defaults", () => {
  const c = loadConfig({});
  expect(c.host).toBe("127.0.0.1");
  expect(c.port).toBe(8700);
  expect(c.dbPath).toBe(resolve("data/space.db"));
  expect(c.appDirs).toEqual([]);
  expect(c.apiToken).toBe("");
  expect(c.maxConcurrency).toBe(2);
});

test("loadConfig reads the environment and expands ~ in app dirs", () => {
  const c = loadConfig({
    SPACE_HOST: "0.0.0.0",
    SPACE_PORT: "9000",
    SPACE_DB: "/tmp/x.db",
    SPACE_APPS: " ~/apps/a , /abs/b ,, ",
    SPACE_API_TOKEN: " tok ",
    SPACE_MAX_CONCURRENCY: "4",
  });
  expect(c.host).toBe("0.0.0.0");
  expect(c.port).toBe(9000);
  expect(c.dbPath).toBe("/tmp/x.db");
  expect(c.appDirs).toEqual([resolve(`${process.env.HOME}/apps/a`), "/abs/b"]);
  expect(c.apiToken).toBe("tok");
  expect(c.maxConcurrency).toBe(4);
});
