/**
 * Chat runtime: one turn of a conversation with an agent, run as a headless
 * `claude` process that streams `stream-json` events. Authentication is the
 * CLI's own login on the machine; multi-turn continuity is `--resume <sid>`.
 * The agent identity (system prompt, tool allow-list) is decided by the
 * caller from the manifest, never by the browser.
 */

export type ChatTurn = {
  message: string;
  model?: string;
  sessionId?: string;
  /** Write authorisation tier; anything else means read-only (the headless default). */
  permissionMode?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  extraArgs?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
};

export type ChatCallbacks = {
  /** A raw stream-json line, forwarded to the client as is. */
  onEvent: (line: string) => void;
  /** First event carrying a session id. */
  onSession?: (sid: string) => void;
  /** Process ended; `error` is null on a clean exit. */
  onFinish: (error: string | null) => void;
};

export const PERMISSION_MODES = ["acceptEdits", "bypassPermissions", "plan"] as const;
export const SESSION_ID_RE = /^[a-f0-9-]{8,64}$/i;
export const MODEL_RE = /^[a-z0-9._-]{1,64}$/i;

/** Runtime command; `SPACE_CHAT_BIN` overrides it (tests, a wrapper script). */
export function chatCommand(env: Record<string, string | undefined> = process.env): string[] {
  const override = env.SPACE_CHAT_BIN?.trim();
  return override ? override.split(/\s+/).filter(Boolean) : ["claude"];
}

/** Arguments after the binary; exported for tests. */
export function chatArgs(t: ChatTurn): string[] {
  const args = ["-p", t.message, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (t.model) args.push("--model", t.model);
  if (t.sessionId) args.push("--resume", t.sessionId);
  if ((PERMISSION_MODES as readonly string[]).includes(t.permissionMode ?? "")) args.push("--permission-mode", t.permissionMode!);
  if (t.systemPrompt) args.push("--append-system-prompt", t.systemPrompt);
  if (t.allowedTools?.length) args.push("--allowedTools", t.allowedTools.join(","));
  args.push(...(t.extraArgs ?? []));
  return args;
}

/** Spawn one turn and forward its events line by line. Returns a handle to kill it. */
export function chatStream(t: ChatTurn, cb: ChatCallbacks): { kill: () => void } {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([...chatCommand(t.env ?? process.env), ...chatArgs(t)], {
      cwd: t.cwd,
      env: t.env ?? process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    queueMicrotask(() => cb.onFinish(`could not start the runtime: ${(e as Error).message}`));
    return { kill: () => {} };
  }

  let sessionSeen = false;
  const stderr = new Response(proc.stderr).text();
  const pump = async () => {
    let rest = "";
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) emit(line);
    }
    if (rest.trim()) emit(rest);
  };
  const emit = (line: string) => {
    if (!line.trim()) return;
    if (!sessionSeen && cb.onSession && line.includes('"session_id"')) {
      try {
        const ev = JSON.parse(line) as { session_id?: unknown };
        if (typeof ev.session_id === "string") {
          sessionSeen = true;
          cb.onSession(ev.session_id);
        }
      } catch {
        /* partial line */
      }
    }
    cb.onEvent(line);
  };

  void (async () => {
    await pump().catch(() => {});
    const code = await proc.exited;
    const err = (await stderr).trim();
    cb.onFinish(code === 0 ? null : (err || `runtime exited with ${code}`).slice(-800));
  })();

  return { kill: () => proc.kill() };
}

/**
 * Server-sent events adapter: the response streams every runtime event as a
 * `data:` line, then `{"type":"error"}` on failure and `{"type":"done"}`.
 * Closing the response (client gone) kills the process.
 */
export function chatResponse(t: ChatTurn, hooks: { onSession?: (sid: string) => void } = {}): Response {
  const enc = new TextEncoder();
  let handle: { kill: () => void } | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (line: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${line}\n\n`));
        } catch {
          closed = true;
        }
      };
      handle = chatStream(t, {
        onEvent: send,
        onSession: hooks.onSession,
        onFinish: (error) => {
          if (error) send(JSON.stringify({ type: "error", error }));
          send('{"type":"done"}');
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
      });
    },
    cancel() {
      handle?.kill();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
