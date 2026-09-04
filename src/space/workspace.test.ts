import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { discoverApps, ensureWorkspace, loadWorkspaceEnv, resolveHome, workspacePaths } from "./workspace.ts";

describe("workspace", () => {
  test("resolveHome defaults to ~/.ai-space and expands ~", () => {
    expect(resolveHome({})).toBe(join(homedir(), ".ai-space"));
    expect(resolveHome({ SPACE_HOME: "~/elsewhere" })).toBe(join(homedir(), "elsewhere"));
    expect(resolveHome({ SPACE_HOME: "/abs/space" })).toBe("/abs/space");
  });

  test("ensureWorkspace creates the layout once and is idempotent", async () => {
    const home = join(await mkdtemp(join(tmpdir(), "space-ws-")), "ws");
    const first = await ensureWorkspace(home);
    expect(first.created).toHaveLength(5);
    expect(await Bun.file(first.ws.envFile).text()).toContain("SPACE_PORT=8700");
    await writeFile(first.ws.envFile, "SPACE_PORT=9999\n");
    const second = await ensureWorkspace(home);
    expect(second.created).toEqual([]);
    expect(await Bun.file(second.ws.envFile).text()).toBe("SPACE_PORT=9999\n");
  });

  test("discoverApps lists only app dirs that carry a manifest", async () => {
    const { ws } = await ensureWorkspace(join(await mkdtemp(join(tmpdir(), "space-ws-")), "ws"));
    await Bun.write(join(ws.apps, "b-app", "space.yaml"), "tasks: []\n");
    await Bun.write(join(ws.apps, "a-app", "space.yaml"), "tasks: []\n");
    await Bun.write(join(ws.apps, "no-manifest", "README.md"), "x\n");
    expect(await discoverApps(ws)).toEqual([join(ws.apps, "a-app"), join(ws.apps, "b-app")]);
    expect(await discoverApps(workspacePaths("/nope"))).toEqual([]);
  });

  test("loadWorkspaceEnv fills missing keys only", async () => {
    const { ws } = await ensureWorkspace(join(await mkdtemp(join(tmpdir(), "space-ws-")), "ws"));
    await writeFile(ws.envFile, '# c\nA=1\nB="two"\nexport C=3\n');
    const env: Record<string, string | undefined> = { A: "keep" };
    expect(await loadWorkspaceEnv(ws, env)).toBe(2);
    expect(env).toEqual({ A: "keep", B: "two", C: "3" });
    expect(await loadWorkspaceEnv(workspacePaths("/nope"), env)).toBe(0);
  });
});
