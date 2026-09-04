import { homedir } from "node:os";
import { join } from "node:path";
import { SESSION_ID_RE } from "./runtime.ts";

/**
 * Restore a conversation from the claude CLI's own transcript, stored as
 * `~/.claude/projects/<cwd encoded>/<sid>.jsonl`. Tool results and framework
 * messages are skipped; consecutive assistant blocks merge into one message.
 */

export type TranscriptMessage = { role: "user"; text: string } | { role: "ai"; text: string; tools: { name: string; hint: string }[] };

export function transcriptPath(cwd: string, sid: string, home = homedir()): string {
  if (!SESSION_ID_RE.test(sid)) throw new Error("invalid session id");
  return join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"), `${sid}.jsonl`);
}

export async function readTranscript(cwd: string, sid: string, home = homedir()): Promise<TranscriptMessage[] | null> {
  const file = Bun.file(transcriptPath(cwd, sid, home));
  if (!(await file.exists())) return null;
  return parseTranscript(await file.text());
}

export function parseTranscript(jsonl: string): TranscriptMessage[] {
  const msgs: TranscriptMessage[] = [];
  for (const line of jsonl.split("\n")) {
    let ev: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev?.message?.content;
    if (ev.type === "user" && !ev.isMeta) {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b) => b?.type === "text")
                .map((b) => String(b.text ?? ""))
                .join("")
            : "";
      if (text.trim() && !text.trimStart().startsWith("<")) msgs.push({ role: "user", text });
    } else if (ev.type === "assistant" && Array.isArray(content)) {
      let last = msgs[msgs.length - 1];
      if (!last || last.role !== "ai") {
        last = { role: "ai", text: "", tools: [] };
        msgs.push(last);
      }
      for (const b of content) {
        if (b?.type === "text" && b.text) last.text += (last.text ? "\n\n" : "") + String(b.text);
        else if (b?.type === "tool_use") last.tools.push({ name: String(b.name ?? "tool"), hint: toolHint(b.input) });
      }
    }
  }
  return msgs;
}

function toolHint(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.path ?? i.query ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 42);
}
