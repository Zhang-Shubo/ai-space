import { useEffect, useRef, useState } from "react";
import { type AgentInfo, type ChatSession, getJson, isImgIcon, relTime } from "./api.ts";

// Chat drawer. The server streams the runtime's stream-json events over SSE.
// - Mounted permanently (closing only slides it away) so conversations and session ids survive.
// - Conversations are keyed by agent id and run in parallel: each has its own queue and in-flight turn;
//   the bookmark bar on the left switches between them, a busy one shows a pulsing dot.
// - Typewriter smoothing: a burst of text is released at a steady rate per frame.
// - Messages sent while a turn runs are queued and sent in order; ⏹ interrupts the current turn.
// - Model and write-permission tier are picked in the header and remembered in localStorage.

// Minimal markdown → html (escape first, then mark up): headings, lists, tables, quotes, rules,
// fenced code, bold, inline code, links and bare URLs.
const escMd = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
// Bare URL: up to whitespace, angle brackets or CJK punctuation; trailing ASCII punctuation is not part of it.
const BARE_URL = /https?:\/\/[^\s<>　-〿一-鿿＀-￯]+/g;
const trimUrl = (u: string) => u.replace(/[),.;:!?'"]+$/, "");
function mdHtml(src: string): string {
  const mkA = (url: string, txt: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  // Links are stashed in slots before the other replacements so their hrefs are not rewritten twice.
  const inline = (s: string) => {
    const slots: string[] = [];
    const stash = (html: string) => `\x00${slots.push(html) - 1}\x00`;
    return escMd(s)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t: string, u: string) => stash(mkA(u, t)))
      .replace(BARE_URL, (u) => {
        const url = trimUrl(u);
        return stash(mkA(url, url)) + u.slice(url.length);
      })
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\x00(\d+)\x00/g, (_, i: string) => slots[Number(i)] ?? "");
  };
  let out = "";
  let list = false;
  let table: string[][] | null = null;
  let fence: string | null = null;
  const closeList = () => {
    if (list) {
      out += "</ul>";
      list = false;
    }
  };
  const closeTable = () => {
    if (!table) return;
    const [h = [], ...b] = table;
    out += `<div class="tblwrap"><table><thead><tr>${h.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${b.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    table = null;
  };
  for (const line of (src || "").split("\n")) {
    if (fence !== null) {
      if (line.trim().startsWith("```")) {
        out += `<pre>${escMd(fence)}</pre>`;
        fence = null;
      } else fence += (fence ? "\n" : "") + line;
      continue;
    }
    const t = line.trim();
    if (t.startsWith("```")) {
      closeList();
      closeTable();
      fence = "";
      continue;
    }
    if (t.startsWith("|") && t.endsWith("|") && t.length > 2) {
      closeList();
      if (!table) table = [];
      if (!/^\|[\s:|-]+\|$/.test(t)) table.push(t.slice(1, -1).split("|").map((c) => inline(c.trim())));
      continue;
    }
    closeTable();
    if (list && !/^[-*] |^\d+[.)] /.test(t)) closeList();
    if (!t) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      out += "<hr>";
      continue;
    }
    if (t.startsWith("#")) {
      out += `<h4>${inline(t.replace(/^#+\s*/, ""))}</h4>`;
      continue;
    }
    if (t.startsWith("> ")) {
      out += `<blockquote>${inline(t.slice(2))}</blockquote>`;
      continue;
    }
    if (/^[-*] /.test(t)) {
      if (!list) {
        out += "<ul>";
        list = true;
      }
      out += `<li>${inline(t.slice(2))}</li>`;
      continue;
    }
    if (/^\d+[.)] /.test(t)) {
      if (!list) {
        out += "<ul>";
        list = true;
      }
      out += `<li>${inline(t.replace(/^\d+[.)] /, ""))}</li>`;
      continue;
    }
    out += `<p>${inline(t)}</p>`;
  }
  closeList();
  closeTable();
  if (fence !== null) out += `<pre>${escMd(fence)}</pre>`; // an unclosed block while streaming still renders
  return out;
}

// User messages render as text; URLs inside become links without HTML injection.
const linkNodes = (text: string) =>
  String(text)
    .split(new RegExp(`(${BARE_URL.source})`))
    .map((part, i) =>
      i % 2 ? (
        <a key={i} href={trimUrl(part)} target="_blank" rel="noopener noreferrer">
          {part}
        </a>
      ) : (
        part
      ),
    );

type Tool = { name: string; hint: string };
// Same-named tools collapse into one chip ("Read ×12") so a long run does not flood the bubble.
const groupTools = (tools: Tool[]) => {
  const order: { name: string; count: number; hint: string }[] = [];
  const byName = new Map<string, { name: string; count: number; hint: string }>();
  for (const t of tools) {
    let g = byName.get(t.name);
    if (!g) {
      g = { name: t.name, count: 0, hint: "" };
      byName.set(t.name, g);
      order.push(g);
    }
    g.count++;
    g.hint = t.hint || g.hint;
  }
  return order;
};
const toolHint = (input: Record<string, unknown> = {}) => {
  const v = input.command || input.file_path || input.pattern || input.url || input.path || input.query || "";
  return String(v).replace(/\s+/g, " ").slice(0, 42);
};

const Ava = ({ icon, fallback = "✨" }: { icon?: string; fallback?: string }) => (isImgIcon(icon) ? <img src={icon} alt="" /> : <>{icon || fallback}</>);

type Msg = { role: "user"; text: string } | { role: "ai"; text: string; tools: Tool[]; denied: string[]; status?: string | null; live?: boolean };
type Conv = { agent: AgentInfo | null; msgs: Msg[]; sid: string | null; busy: boolean; queued: number };
const EMPTY_CONV: Conv = { agent: null, msgs: [], sid: null, busy: false, queued: 0 };
type Runner = { queue: string[]; running: boolean; active: { ctrl: AbortController; typer: { target: string } } | null };

export default function Chat({ open, agent, onClose, onSwitch }: { open: boolean; agent: AgentInfo; onClose: () => void; onSwitch?: (a: AgentInfo) => void }) {
  const [convs, setConvs] = useState<Record<string, Conv>>({});
  const [input, setInput] = useState("");
  const [stick, setStick] = useState(true); // stick to the bottom unless the user scrolled up
  const [model, setModel] = useState(localStorage.getItem("chat-model") || "");
  const [perm, setPerm] = useState(localStorage.getItem("chat-perm") || ""); // '' read-only | acceptEdits | bypassPermissions
  const [hist, setHist] = useState<ChatSession[] | null>(null); // null = history panel closed
  const modelRef = useRef(model);
  const permRef = useRef(perm);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  useEffect(() => {
    permRef.current = perm;
  }, [perm]);
  const convsRef = useRef(convs);
  useEffect(() => {
    convsRef.current = convs;
  }, [convs]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runnersRef = useRef<Record<string, Runner>>({});
  const runner = (k: string): Runner => (runnersRef.current[k] ||= { queue: [], running: false, active: null });

  const key = agent.id;
  const conv = convs[key] || EMPTY_CONV;
  const patch = (k: string, fn: (v: Conv) => Conv) => setConvs((c) => ({ ...c, [k]: fn(c[k] || { ...EMPTY_CONV }) }));
  const base = `/api/agents/${encodeURIComponent(agent.app)}/${encodeURIComponent(agent.name)}`;

  useEffect(() => {
    patch(key, (v) => ({ ...v, agent: agent || v.agent }));
    setHist(null);
    setStick(true);
    inputRef.current?.focus();
  }, [key]);

  useEffect(() => {
    if (stick) bodyRef.current?.scrollTo(0, 1e9);
  }, [conv.msgs, stick]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };
  const toLatest = () => {
    bodyRef.current?.scrollTo({ top: 1e9, behavior: "smooth" });
    setStick(true);
  };
  const pickModel = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setModel(e.target.value);
    localStorage.setItem("chat-model", e.target.value);
  };
  const pickPerm = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPerm(e.target.value);
    localStorage.setItem("chat-perm", e.target.value);
  };

  // One turn: append an AI bubble to the agent's conversation and fill it from the SSE stream.
  const runTurn = async (turnKey: string, chatBase: string, text: string) => {
    let aiIdx = -1;
    patch(turnKey, (v) => {
      aiIdx = v.msgs.length;
      return { ...v, msgs: [...v.msgs, { role: "ai", text: "", tools: [], denied: [], status: "Starting…", live: true }] };
    });
    const upd = (fn: (m: Extract<Msg, { role: "ai" }>) => Msg) =>
      patch(turnKey, (v) => {
        const cur = v.msgs[aiIdx];
        if (aiIdx < 0 || !cur || cur.role !== "ai") return v;
        const m = v.msgs.slice();
        m[aiIdx] = fn(cur);
        return { ...v, msgs: m };
      });
    const typer: { target: string; timer: ReturnType<typeof setInterval> | null; done: boolean } = { target: "", timer: null, done: false };
    const pump = () => {
      if (typer.timer) return;
      typer.timer = setInterval(() => {
        upd((x) => {
          const shown = x.text.length;
          if (shown >= typer.target.length) {
            if (typer.done && typer.timer) {
              clearInterval(typer.timer);
              typer.timer = null;
            }
            return x;
          }
          const step = Math.max(2, Math.ceil((typer.target.length - shown) / 12));
          return { ...x, text: typer.target.slice(0, shown + step), status: null };
        });
      }, 33);
    };
    const setTarget = (s: string) => {
      typer.target = s;
      pump();
    };
    const ctrl = new AbortController();
    runner(turnKey).active = { ctrl, typer };
    const setSid = (sid: string) => patch(turnKey, (v) => ({ ...v, sid }));
    let acc = ""; // finished text of this turn (tool calls split it into several assistant messages)
    let streamed = ""; // delta of the current message
    const seenTools = new Set<string>();
    const toolNames = new Map<string, string>();
    try {
      const r = await fetch(`${chatBase}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: convsRef.current[turnKey]?.sid || undefined,
          model: modelRef.current || undefined,
          permissionMode: permRef.current || undefined,
        }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          if (!raw.startsWith("data: ")) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let ev: any;
          try {
            ev = JSON.parse(raw.slice(6));
          } catch {
            continue;
          }
          if (ev.type === "system" && ev.subtype === "init") {
            setSid(ev.session_id);
            upd((x) => ({ ...x, status: `Thinking… (${ev.model || "claude"})` }));
          } else if (ev.type === "stream_event" && ev.event?.delta?.type === "text_delta") {
            streamed += ev.event.delta.text;
            setTarget(acc + streamed);
          } else if (ev.type === "assistant") {
            const blocks: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] = ev.message?.content || [];
            const txt = blocks
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (txt) {
              acc += (acc ? "\n\n" : "") + txt;
              streamed = "";
              setTarget(acc);
            }
            for (const b of blocks)
              if (b.type === "tool_use" && b.id && !seenTools.has(b.id)) {
                seenTools.add(b.id);
                toolNames.set(b.id, b.name || "tool");
                upd((x) => ({ ...x, status: `Running ${b.name}…`, tools: [...x.tools, { name: b.name || "tool", hint: toolHint(b.input) }] }));
              }
          } else if (ev.type === "user") {
            // Tool results: a write the headless run was not allowed to make comes back as an error; show it.
            for (const b of ev.message?.content || []) {
              if (b.type !== "tool_result" || !b.is_error) continue;
              const rtxt = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text || "").join(" ") : "";
              if (/permission|granted|denied/i.test(rtxt)) {
                const name = toolNames.get(b.tool_use_id) || "tool";
                upd((x) => (x.denied.includes(name) ? x : { ...x, denied: [...x.denied, name] }));
              }
            }
          } else if (ev.type === "result") {
            if (ev.session_id) setSid(ev.session_id);
            if (ev.is_error && !acc) setTarget(String(ev.result || ev.subtype || "Something went wrong"));
          } else if (ev.type === "error") {
            setTarget((typer.target ? typer.target + "\n\n" : "") + `⚠️ ${ev.error}`);
          }
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") setTarget((typer.target ? typer.target + "\n\n" : "") + "⏹ Interrupted");
      else setTarget((typer.target ? typer.target + "\n\n" : "") + `⚠️ ${err.message || err}`);
    }
    if (!typer.target) typer.target = "(no output)";
    typer.done = true;
    if (typer.timer) {
      clearInterval(typer.timer);
      typer.timer = null;
    }
    upd((x) => ({ ...x, text: typer.target, status: null, live: false }));
    runner(turnKey).active = null;
  };

  const drain = async (k: string, chatBase: string) => {
    const r = runner(k);
    if (r.running) return;
    r.running = true;
    patch(k, (v) => ({ ...v, busy: true }));
    while (r.queue.length) {
      const text = r.queue.shift() as string;
      const queued = r.queue.length; // read before the lazy state update runs
      patch(k, (v) => ({ ...v, queued }));
      await runTurn(k, chatBase, text);
    }
    r.running = false;
    patch(k, (v) => ({ ...v, busy: false, queued: 0 }));
  };

  const send = (text: string) => {
    patch(key, (v) => ({ ...v, agent: agent || v.agent, msgs: [...v.msgs, { role: "user", text }] }));
    runner(key).queue.push(text);
    drain(key, base);
  };
  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setStick(true);
    send(text);
  };

  const stop = () => runner(key).active?.ctrl.abort();

  const reset = () => {
    const r = runner(key);
    r.queue = [];
    r.active?.ctrl.abort();
    patch(key, (v) => ({ ...v, msgs: [], sid: null }));
    setHist(null);
    inputRef.current?.focus();
  };

  // After a refusal: switch to "edit files" and ask the agent to redo the refused step in the same session.
  const retryWithPerm = () => {
    const v = "acceptEdits";
    setPerm(v);
    permRef.current = v;
    localStorage.setItem("chat-perm", v);
    send("I have granted write access (edit files). Please finish the step that was refused for lack of permission.");
  };

  const toggleHist = async () => {
    if (hist) return setHist(null);
    try {
      const j = await getJson<{ sessions: ChatSession[] }>(`${base}/sessions`);
      setHist(j.sessions);
    } catch {
      setHist([]);
    }
  };
  // Pick a past session: restore its transcript and resume it; without a transcript the session still resumes.
  const pickSession = async (s: ChatSession) => {
    setHist(null);
    const r = runner(key);
    r.queue = [];
    r.active?.ctrl.abort();
    let msgs: Msg[];
    try {
      const j = await getJson<{ messages: ({ role: "user"; text: string } | { role: "ai"; text: string; tools: Tool[] })[] }>(`${base}/sessions/${encodeURIComponent(s.sid)}`);
      msgs = j.messages.map((m) => (m.role === "ai" ? { denied: [], ...m } : m));
    } catch (e) {
      msgs = [{ role: "ai", text: `⚠️ Transcript unavailable (${(e as Error).message}); the session is resumed, continue from here.`, tools: [], denied: [] }];
    }
    patch(key, (v) => ({ ...v, sid: s.sid, msgs }));
    setStick(true);
    inputRef.current?.focus();
  };

  const tabs = Object.entries(convs);

  return (
    <aside className={`chat ${open ? "open" : ""}`}>
      {tabs.length > 1 && (
        <div className="chat-tabs">
          {tabs.map(([k, v]) => (
            <button
              key={k}
              className={`chat-tab ${k === key ? "on" : ""}`}
              title={v.agent?.title || k}
              onClick={() => {
                if (k !== key && v.agent) onSwitch?.(v.agent);
              }}
            >
              <Ava icon={v.agent?.avatar} />
              {v.busy && <i className="tab-busy" />}
            </button>
          ))}
        </div>
      )}
      <div className="chat-main">
        <div className="chat-head">
          <div className="chat-head-top">
            <span className="chat-ava">
              <Ava icon={agent.avatar} />
            </span>
            <b>{agent.title}</b>
            <span className="chat-sub">{conv.busy ? `Thinking…${conv.queued ? ` (+${conv.queued} queued)` : ""}` : conv.sid ? "in session" : "new session"}</span>
            {conv.busy && (
              <button className="chat-hbtn" title="Interrupt" onClick={stop}>
                ⏹
              </button>
            )}
            <button className="chat-hbtn" title="History" onClick={toggleHist}>
              🕘
            </button>
            <button className="chat-hbtn" title="New conversation" onClick={reset}>
              ↺
            </button>
            <button className="chat-hbtn" title="Close" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="chat-opts">
            <select className="chat-model" value={model} onChange={pickModel} title="Model (next message)">
              <option value="">default model</option>
              <option value="haiku">haiku · fast</option>
              <option value="sonnet">sonnet</option>
              <option value="opus">opus · strong</option>
            </select>
            <select className="chat-model" value={perm} onChange={pickPerm} title="Write access (next message)">
              <option value="">🔒 read-only</option>
              <option value="acceptEdits">✏️ edit files</option>
              <option value="bypassPermissions">⚡ all permissions</option>
            </select>
          </div>
          {hist && (
            <div className="chat-hist">
              {hist.length === 0 && <p className="hist-empty">No past sessions</p>}
              {hist.map((s) => (
                <button key={s.sid} className="hist-item" onClick={() => pickSession(s)}>
                  <span className="hist-title">{s.title || "(untitled)"}</span>
                  <span className="hist-time">{relTime(s.ts)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="chat-body" ref={bodyRef} onScroll={onScroll}>
          {conv.msgs.length === 0 && (
            <div className="chat-hello">
              <span className="hello-ava">
                <Ava icon={agent.avatar} />
              </span>
              <b>{agent.title}</b>
              <br />
              {agent.description || (agent.app === "space" ? "Ask about the space: apps, manifests, files." : agent.id)}
            </div>
          )}
          {conv.msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "ai" && m.tools.length > 0 && (
                <span className="msg-tools">
                  {groupTools(m.tools).map((t, j) => (
                    <i key={j}>
                      🔧 {t.name}
                      {t.count > 1 ? ` ×${t.count}` : t.hint ? <em> {t.hint}</em> : null}
                    </i>
                  ))}
                </span>
              )}
              {m.role === "ai" ? <span className={`md ${m.live ? "live" : ""}`} dangerouslySetInnerHTML={{ __html: mdHtml(m.text) }} /> : linkNodes(m.text)}
              {m.role === "ai" && m.denied.length > 0 && (
                <span className="msg-denied">
                  ⛔ {m.denied.join(", ")} needed write access and was refused
                  {!m.live && <button onClick={retryWithPerm}>Grant and retry</button>}
                </span>
              )}
              {m.role === "ai" && m.live && m.status && <span className="msg-status">{m.status}</span>}
            </div>
          ))}
        </div>
        {!stick && conv.msgs.length > 0 && (
          <button className="chat-down" title="Latest" onClick={toLatest}>
            ↓
          </button>
        )}
        <div className="chat-input">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            placeholder={conv.busy ? "Keep typing; sent when the reply finishes…" : "Message, Enter to send"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="chat-send" disabled={!input.trim()} onClick={submit}>
            ↑
          </button>
        </div>
      </div>
    </aside>
  );
}
