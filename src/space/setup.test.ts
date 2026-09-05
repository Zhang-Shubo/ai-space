import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNEL_FORMS, type SetupDeps, type SetupIO, isSecretKey, mask, quoteEnvValue, runSetup, updateEnvText } from "./setup.ts";
import type { ChannelKind } from "./notify/types.ts";
import { parseChannelUrl } from "./notify/channels.ts";
import { ensureWorkspace } from "./workspace.ts";

/**
 * A terminal that answers from a script: each entry is matched against the
 * question by substring and consumed; an unscripted question takes its default.
 * `remaining` is what the flow never asked.
 */
function scripted(answers: [string, string | boolean][]): SetupIO & { log: string[]; remaining: [string, string | boolean][] } {
  const log: string[] = [];
  const take = (q: string): string | boolean | undefined => {
    const i = answers.findIndex(([needle]) => q.includes(needle));
    if (i < 0) return undefined;
    return answers.splice(i, 1)[0]![1];
  };
  return {
    log,
    remaining: answers,
    say: (l = "") => log.push(l),
    async ask(q, opts = {}) {
      const a = take(q);
      return a === undefined ? (opts.default ?? "") : String(a);
    },
    async confirm(q, def) {
      const a = take(q);
      return a === undefined ? def : Boolean(a);
    },
  };
}

async function deps(io: SetupIO, env: Record<string, string | undefined>, over: Partial<SetupDeps> = {}): Promise<SetupDeps & { ran: string[][] }> {
  const { ws } = await ensureWorkspace(join(await mkdtemp(join(tmpdir(), "space-setup-")), "ws"));
  const ran: string[][] = [];
  return {
    ran,
    io,
    ws,
    env,
    which: async (cmd) => (["claude", "gh", "tar", "zstd"].includes(cmd) ? `/usr/bin/${cmd}` : undefined),
    async run(cmd) {
      ran.push(cmd);
      const [bin, ...rest] = cmd;
      if (bin === "bun") return { code: 0, stdout: "1.3.0\n", stderr: "" };
      if (bin === "git") return { code: 0, stdout: rest[0] === "config" ? "me@example.com\n" : "git version 2.44\n", stderr: "" };
      if (bin === "claude") return rest[0] === "--version" ? { code: 0, stdout: "2.0.0\n", stderr: "" } : { code: 0, stdout: '{"result":"ok"}\n', stderr: "" };
      if (bin === "gh") return { code: 1, stdout: "", stderr: "not logged in" };
      if (bin === "systemctl") return { code: 0, stdout: rest[1] === "is-enabled" ? "enabled\n" : "", stderr: "" };
      return { code: 127, stdout: "", stderr: "missing" };
    },
    probeS3: async () => {},
    sendTest: async () => {},
    fetch: (async () => new Response(JSON.stringify({ ok: true, result: [] }))) as unknown as typeof fetch,
    randomToken: () => "tok-" + "a".repeat(60),
    hostname: () => "box",
    ...over,
  };
}

describe("updateEnvText", () => {
  test("replaces in place, uncomments, appends the rest under one header", () => {
    const text = ["# header", "SPACE_PORT=8700", "# SPACE_CHAT_MODEL=sonnet", "SPACE_API_TOKEN=", "MY_APP=1", ""].join("\n");
    const out = updateEnvText(text, { SPACE_PORT: "9000", SPACE_CHAT_MODEL: "opus", SPACE_API_TOKEN: "t", SPACE_NAME: "box" });
    expect(out).toBe(["# header", "SPACE_PORT=9000", "SPACE_CHAT_MODEL=opus", "SPACE_API_TOKEN=t", "MY_APP=1", "", "# Added by `bun src/index.ts setup`", "SPACE_NAME=box", ""].join("\n"));
  });

  test("quotes values with spaces and reads back through the workspace loader", async () => {
    expect(quoteEnvValue("a b")).toBe('"a b"');
    expect(quoteEnvValue("plain")).toBe("plain");
    expect(quoteEnvValue("")).toBe('""');
    const out = updateEnvText("", { SPACE_PEER_X_HEADERS: "CF-Access-Client-Id: a; CF-Access-Client-Secret: b" });
    expect(out).toContain('SPACE_PEER_X_HEADERS="CF-Access-Client-Id: a; CF-Access-Client-Secret: b"');
  });

  test("empty file gets no leading blank line", () => {
    expect(updateEnvText("", { A: "1" })).toBe("# Added by `bun src/index.ts setup`\nA=1\n");
  });
});

describe("channel forms", () => {
  test("every kind builds a URL the channel parser accepts", () => {
    const sample: Record<string, string> = { token: "abc-123", chat: "-100", thread: "", secret: "s", id: "42", path: "T/B/C", key: "k", host: "h.example.com", topic: "t" };
    for (const [kind, form] of Object.entries(CHANNEL_FORMS)) {
      if (kind === "stdout") continue;
      const url = form.build(kind === "telegram" ? { ...sample, token: "123:ABC" } : sample);
      expect(parseChannelUrl("default", url).kind).toBe(kind as ChannelKind);
    }
  });

  test("secret keys are masked", () => {
    expect(isSecretKey("SPACE_API_TOKEN")).toBe(true);
    expect(isSecretKey("SPACE_NOTIFY_DEFAULT")).toBe(true);
    expect(isSecretKey("SPACE_PORT")).toBe(false);
    expect(isSecretKey("SPACE_NOTIFY_TASKS")).toBe(false);
    expect(isSecretKey("SPACE_NOTIFY_OPS_ENABLED")).toBe(false);
    expect(mask("abcdefghijkl")).toBe("abcd…ijkl");
    expect(mask("short")).toBe("*****");
  });
});

describe("runSetup", () => {
  test("first run: generates a token, configures telegram, writes and restarts", async () => {
    const io = scripted([
      ["Port", "8701"],
      ["Task runs", "6"],
      ["Default chat model", "sonnet"],
      ["Name of this space", "box"],
      ["Configure a notification channel now?", true],
      ["Kind", "telegram"],
      ["Bot token", "123:ABC"],
      ["Chat id", "-100"],
      ["Send a test message", true],
      ["Report tasks that fail", true],
      ["Configure one now?", false],
      ["Will a hub", false],
      ["Add a peer", false],
      ["Write them?", true],
      ["Restart the ai-space unit", true],
    ]);
    const sent: string[] = [];
    const d = await deps(io, { SPACE_PORT: "8700" }, { sendTest: async (c) => void sent.push(c.url) });
    const out = await runSetup(d);
    expect(io.remaining).toEqual([]);
    expect(sent).toEqual(["telegram://123:ABC@-100"]);
    expect(out.written).toEqual(["SPACE_HOST", "SPACE_PORT", "SPACE_API_TOKEN", "SPACE_MAX_CONCURRENCY", "SPACE_CHAT_MODEL", "SPACE_NAME", "SPACE_NOTIFY_DEFAULT", "SPACE_NOTIFY_TASKS"]);
    expect(out.missing).toEqual(["gh", "cloudflared"]);
    expect(out.restarted).toBe(true);
    const text = await Bun.file(d.ws.envFile).text();
    expect(text).toContain("SPACE_PORT=8701");
    expect(text).toContain("SPACE_API_TOKEN=tok-");
    expect(text).toContain("SPACE_NOTIFY_DEFAULT=telegram://123:ABC@-100");
    expect(text).toContain("SPACE_NOTIFY_TASKS=default");
    expect(d.ran).toContainEqual(["systemctl", "--user", "restart", "ai-space"]);
    // the summary masks secrets
    expect(io.log.join("\n")).not.toContain("SPACE_NOTIFY_DEFAULT=telegram://123");
  });

  test("re-run with everything set changes nothing and writes nothing", async () => {
    const io = scripted([
      ["Replace the default channel?", false],
      ["Change the S3 credentials?", false],
      ["Rotate the hub token?", false],
      ["Add a peer", false],
    ]);
    const env = {
      SPACE_HOST: "127.0.0.1",
      SPACE_PORT: "8700",
      SPACE_API_TOKEN: "existing",
      SPACE_MAX_CONCURRENCY: "4",
      SPACE_CHAT_MODEL: "sonnet",
      SPACE_NAME: "box",
      SPACE_NOTIFY_DEFAULT: "stdout://",
      SPACE_NOTIFY_TASKS: "default",
      SPACE_S3_ACCESS_KEY_ID: "k",
      SPACE_HUB_TOKEN: "h",
    };
    const d = await deps(io, env);
    const before = await Bun.file(d.ws.envFile).text();
    const out = await runSetup(d);
    expect(io.remaining).toEqual([]);
    expect(out.written).toEqual([]);
    expect(await Bun.file(d.ws.envFile).text()).toBe(before);
    expect(io.log).toContain("Nothing changed.");
  });

  test("a failed S3 probe is dropped unless kept; a rejected peer token is reported", async () => {
    const io = scripted([
      ["Configure a notification channel now?", false],
      ["Configure one now?", true],
      ["Endpoint", "https://acc.r2.cloudflarestorage.com"],
      ["Access key id", "id"],
      ["Secret access key", "sec"],
      ["Default bucket", "b"],
      ["Keep these credentials anyway?", false],
      ["Will a hub", false],
      ["Add a peer this panel should merge?", true],
      ["Peer name", "david"],
      ["Peer URL", "https://space-david.example.com"],
      ["Its SPACE_HUB_TOKEN", "t"],
      ["Is an access layer", false],
      ["Keep it anyway?", true],
      ["Write them?", false],
    ]);
    const d = await deps(
      io,
      { SPACE_API_TOKEN: "x" },
      {
        probeS3: async () => {
          throw new Error("403 SignatureDoesNotMatch");
        },
        fetch: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
      },
    );
    const out = await runSetup(d);
    expect(io.remaining).toEqual([]);
    expect(out.written).toEqual([]);
    const log = io.log.join("\n");
    expect(log).toContain("list failed: 403");
    expect(log).toContain("401 from the peer (token rejected)");
    expect(log).toContain("SPACE_PEER_DAVID=https://space-david.example.com");
    expect(log).toContain("SPACE_PEER_DAVID_TOKEN=*");
    expect(log).toContain("not written.");
  });

  test("telegram chat ids are looked up from the bot's updates", async () => {
    const io = scripted([
      ["Configure a notification channel now?", true],
      ["Kind", "telegram"],
      ["Bot token", "123:ABC"],
      ["Send a test message", false],
      ["Report tasks that fail", false],
      ["Configure one now?", false],
      ["Will a hub", false],
      ["Add a peer", false],
      ["Write them?", false],
    ]);
    const d = await deps(
      io,
      { SPACE_API_TOKEN: "x" },
      { fetch: (async () => new Response(JSON.stringify({ ok: true, result: [{ message: { chat: { id: -1001, title: "Ops" } } }] }))) as unknown as typeof fetch },
    );
    await runSetup(d);
    // "Chat id" was not scripted, so the default (the first chat found) was taken
    expect(io.remaining).toEqual([]);
    expect(io.log).toContain("    -1001  Ops");
    expect(io.log).toContain("  SPACE_NOTIFY_DEFAULT=" + mask("telegram://123:ABC@-1001"));
  });
});
