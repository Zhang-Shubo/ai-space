import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { loadConfig, parseNotifyArgs } from "./index.ts";
import { workspacePaths } from "./space/workspace.ts";

const ws = workspacePaths("/ws");

test("loadConfig applies defaults relative to the workspace", () => {
  const c = loadConfig(ws, {});
  expect(c.host).toBe("127.0.0.1");
  expect(c.port).toBe(8700);
  expect(c.dbPath).toBe(join("/ws", "data", "space.db"));
  expect(c.extraAppDirs).toEqual([]);
  expect(c.apiToken).toBe("");
  expect(c.maxConcurrency).toBe(2);
});

test("loadConfig reads the environment and expands ~ in extra app dirs", () => {
  const c = loadConfig(ws, {
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
  expect(c.extraAppDirs).toEqual([resolve(`${process.env.HOME}/apps/a`), "/abs/b"]);
  expect(c.apiToken).toBe("tok");
  expect(c.maxConcurrency).toBe(4);
});

test("loadConfig reads the postgres admin url", () => {
  expect(loadConfig(ws, {}).pgAdminUrl).toBe("");
  expect(loadConfig(ws, { SPACE_PG_ADMIN_URL: " postgres://admin:pw@127.0.0.1/postgres " }).pgAdminUrl).toBe("postgres://admin:pw@127.0.0.1/postgres");
});

test("loadConfig builds the s3 config only when both keys are present", () => {
  expect(loadConfig(ws, {}).s3).toBeUndefined();
  expect(loadConfig(ws, { SPACE_S3_ACCESS_KEY_ID: "AK" }).s3).toBeUndefined();
  expect(
    loadConfig(ws, {
      SPACE_S3_ACCESS_KEY_ID: " AK ",
      SPACE_S3_SECRET_ACCESS_KEY: "SK",
      SPACE_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      SPACE_S3_REGION: "auto",
      SPACE_S3_BUCKET: "media",
    }).s3,
  ).toEqual({ accessKeyId: "AK", secretAccessKey: "SK", endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto", bucket: "media" });
  expect(loadConfig(ws, { SPACE_S3_ACCESS_KEY_ID: "AK", SPACE_S3_SECRET_ACCESS_KEY: "SK" }).s3).toEqual({ accessKeyId: "AK", secretAccessKey: "SK" });
});

test("loadConfig reads the task notification channel", () => {
  expect(loadConfig(ws, {}).notifyTasks).toBe("");
  expect(loadConfig(ws, { SPACE_NOTIFY_TASKS: " ops " }).notifyTasks).toBe("ops");
});

test("parseNotifyArgs builds the request body from flags and text", () => {
  expect(parseNotifyArgs(["--level", "warn", "--title", "Backup", "--channel", "ops", "--key", "bk", "--wait", "Restore", "check", "failed"], { SPACE_APP: "my-app" })).toEqual({
    app: "my-app",
    level: "warn",
    title: "Backup",
    channels: ["ops"],
    key: "bk",
    wait: true,
    text: "Restore check failed",
  });
  expect(parseNotifyArgs(["--app", "other", "hi"], { SPACE_APP: "my-app" })).toEqual({ app: "other", text: "hi" });
  expect(() => parseNotifyArgs(["hi"], {})).toThrow(/--app is required/);
  expect(() => parseNotifyArgs(["--app", "a"], {})).toThrow(/text is required/);
  expect(() => parseNotifyArgs(["--app", "a", "--title"], {})).toThrow(/needs a value/);
  expect(() => parseNotifyArgs(["--app", "a", "--loud", "x"], {})).toThrow(/unknown option/);
});
