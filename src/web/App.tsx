import { type ReactNode, useEffect, useRef, useState } from "react";
import Chat from "./Chat.tsx";
import Pet from "./Pet.tsx";
import { type AgentInfo, type AppInfo, type ServiceInfo, type WidgetInfo, getJson, isImgIcon, relTime, repoUrl, sendJson } from "./api.ts";

// Launcher-style panel: App and Agent tiles with hover details, widget cards, a chat drawer.
// Edit mode (long-press the background): add an app from a link, hide or delete, drag to reorder.
// Everything comes from the apps' manifests through the panel API; the browser holds no secrets.

const STATUS: Record<string, string> = { active: "active", paused: "paused", archived: "archived" };
const HEALTH: Record<string, string> = { ok: "up", down: "down", unknown: "" };

type DragProps = Partial<Record<"draggable" | "onDragStart" | "onDragOver" | "onDragEnd", unknown>> | undefined;

function Icon({ icon, fallback }: { icon: string; fallback: string }) {
  const [broken, setBroken] = useState(false);
  if (isImgIcon(icon) && !broken) return <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <>{isImgIcon(icon) ? fallback : icon || fallback}</>;
}

function Tile({
  icon,
  fallback,
  name,
  href,
  health,
  editing,
  onRemove,
  removeTitle,
  onOpen,
  showPop = true,
  dragProps,
  children,
}: {
  icon: string;
  fallback: string;
  name: string;
  href?: string;
  health?: string;
  editing: boolean;
  onRemove?: () => void;
  removeTitle?: string;
  onOpen?: () => void;
  showPop?: boolean;
  dragProps?: DragProps;
  children?: ReactNode;
}) {
  // onOpen wins over href: agent tiles open the chat drawer; links move into the pop-over.
  const asLink = !!href && !editing && !onOpen;
  // Hide the pop-over once the tile is clicked (a pure :hover would keep it while the pointer rests there).
  const [popHidden, setPopHidden] = useState(false);
  const inner = (
    <>
      {editing && onRemove && (
        <button
          className="tile-del"
          title={removeTitle}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
        >
          ✕
        </button>
      )}
      {health && <i className={`tile-health ${health}`} title={HEALTH[health] || health} />}
      <span className="tile-icon">
        <Icon icon={icon} fallback={fallback} />
      </span>
      <span className="tile-name">{name}</span>
      {!editing && !popHidden && showPop && <div className="pop">{children}</div>}
    </>
  );
  const common = {
    className: "tile",
    ...(dragProps as object),
    onMouseLeave: () => setPopHidden(false),
    onClick: () => {
      setPopHidden(true);
      if (!editing && onOpen) onOpen();
    },
  };
  return asLink ? (
    <a {...common} href={href} target="_blank" rel="noopener noreferrer">
      {inner}
    </a>
  ) : (
    <div {...common}>{inner}</div>
  );
}

function Widget({ w, dragProps, theme }: { w: WidgetInfo; dragProps?: DragProps; theme: string }) {
  return (
    <div className={`widget s${w.size}`} {...(dragProps as object)}>
      <div className="widget-head">
        <span className="widget-ico">
          <Icon icon={w.icon} fallback="📦" />
        </span>
        <b>{w.title}</b>
      </div>
      {w.kind === "embed" ? (
        <iframe title={w.title} src={`/api/widgets/${encodeURIComponent(w.app)}/${encodeURIComponent(w.name)}/embed?theme=${theme}`} sandbox="allow-scripts" loading="lazy" />
      ) : w.ok ? (
        <div className="widget-list">
          {w.items.slice(0, 6).map((it, i) => (
            <a key={i} href={it.url || w.link} target="_blank" rel="noopener noreferrer">
              <span className="wi-text">{it.text}</span>
              {it.time && <span className="wi-time">{relTime(it.time)}</span>}
            </a>
          ))}
          {!w.items.length && <p className="widget-err">Nothing yet</p>}
        </div>
      ) : (
        <p className="widget-err">Unavailable: {w.error}</p>
      )}
      {w.link && (
        <a className="widget-more" href={w.link} target="_blank" rel="noopener noreferrer">
          View all →
        </a>
      )}
    </div>
  );
}

function AddForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!/^https?:\/\//.test(link.trim())) return setErr("Enter a link (a repository or a service address)");
    setErr("");
    setBusy(true);
    try {
      await sendJson("POST", "/api/apps", { link: link.trim() });
      onSaved();
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          Add app<span className="modal-sub">from a link, resolved by the agent</span>
        </h3>
        <div className="field">
          <label>Link *</label>
          <input value={link} onChange={(e) => setLink(e.target.value)} disabled={busy} placeholder="https://github.com/you/my-app or https://tool.example.com" onKeyDown={(e) => e.key === "Enter" && !busy && save()} />
        </div>
        <div className="form-hint">The name, icon and description are read from the link and written to a manifest-only app under apps/.</div>
        {err && <div className="form-err">{err}</div>}
        <div className="actions">
          <button className="btn2" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn2 primary" onClick={save} disabled={busy}>
            {busy ? "Resolving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

type Prefs = { noPop?: boolean; noPet?: boolean; noWidget?: boolean };

export default function App() {
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("panel-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // The chat opens on the space agent by default; an agent tile switches to that agent.
  const [chatAgent, setChatAgent] = useState<AgentInfo>({ id: "space/assistant", app: "space", name: "assistant", title: "Space", avatar: "✨", runtime: "claude" });
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      return (JSON.parse(localStorage.getItem("panel-prefs") || "{}") as Prefs) || {};
    } catch {
      return {};
    }
  });
  const [setsOpen, setSetsOpen] = useState(false);
  // Services: every app with a service, headless ones included. Loaded each time the pop-over opens
  // so the health dots are fresh (the server caches probes for 15 s).
  const [services, setServices] = useState<ServiceInfo[] | null>(null);
  useEffect(() => {
    if (!setsOpen) return;
    getJson<{ services: ServiceInfo[] }>("/api/services")
      .then((d) => setServices(d.services || []))
      .catch(() => setServices([]));
  }, [setsOpen]);
  const togglePref = (k: keyof Prefs) =>
    setPrefs((p) => {
      const n = { ...p, [k]: !p[k] };
      localStorage.setItem("panel-prefs", JSON.stringify(n));
      return n;
    });
  useEffect(() => {
    if (!setsOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".setpop, .set-btn")) setSetsOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [setsOpen]);

  const reload = () =>
    Promise.all([getJson<{ apps: AppInfo[] }>("/api/apps"), getJson<{ agents: AgentInfo[] }>("/api/agents")])
      .then(([p, a]) => {
        setApps(p.apps);
        setAgents(a.agents);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));

  useEffect(() => {
    reload();
  }, []);

  // Widgets: once on load, then every 5 minutes while visible; the server caches per widget refresh.
  const [widgets, setWidgets] = useState<WidgetInfo[]>([]);
  useEffect(() => {
    const pull = () => {
      if (!document.hidden)
        getJson<{ widgets: WidgetInfo[] }>("/api/widgets")
          .then((d) => setWidgets(d.widgets || []))
          .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 300_000);
    document.addEventListener("visibilitychange", pull);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", pull);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("panel-theme", theme);
  }, [theme]);

  // Clicking outside the chat drawer closes it.
  useEffect(() => {
    if (!chatOpen) return;
    const h = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if ((e.target as Element).closest(".chat, .fab, .tile, .modal, .overlay, .pop, .setpop, .pet, .widget, a, button, input, select, textarea")) return;
      setChatOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [chatOpen]);

  // Long-press (550 ms, under 8 px of movement) on the background enters edit mode; a click on the
  // background leaves it. The listeners mount once and read `editing` through a ref: remounting on
  // every change would reset the `fired` flag and mistake the long-press release for an exit click.
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  useEffect(() => {
    const blank = (e: MouseEvent) => e.button === 0 && !(e.target as Element).closest(".tile, .fab, .modal, .overlay, .pop, .empty, .pet, .chat, .setpop, .widget, a, button, input, select, textarea");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sx = 0;
    let sy = 0;
    let fired = false;
    const down = (e: MouseEvent) => {
      if (editingRef.current || !blank(e)) return;
      sx = e.clientX;
      sy = e.clientY;
      timer = setTimeout(() => {
        fired = true;
        setEditing(true);
      }, 550);
    };
    const move = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) clearTimeout(timer);
    };
    const up = () => {
      clearTimeout(timer);
      setTimeout(() => {
        fired = false;
      }, 0);
    };
    const click = (e: MouseEvent) => {
      if (fired) return;
      if (editingRef.current && blank(e)) setEditing(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.addEventListener("click", click);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("click", click);
    };
  }, []);

  // Remove from the panel: manifest-only apps are deleted, apps with code are hidden.
  const removeApp = async (app: AppInfo) => {
    try {
      if (app.manifestOnly) await sendJson("DELETE", `/api/apps/${encodeURIComponent(app.name)}`);
      else await sendJson("PATCH", `/api/apps/${encodeURIComponent(app.name)}`, { hidden: true });
    } catch {
      /* the reload shows the real state */
    }
    reload();
  };

  // Drag to reorder in edit mode (HTML5 DnD); the group's order is saved on drop.
  const dragRef = useRef<{ kind: string; index: number } | null>(null);
  const arrMove = <T,>(arr: T[], from: number, to: number) => {
    const a = arr.slice();
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x as T);
    return a;
  };
  const saveOrder = (kind: string, ids: string[]) => sendJson("PUT", "/api/panel/layout", { order: { [kind]: ids } }).catch(() => {});
  const dragProps = <T extends { name?: string; id?: string }>(kind: string, setItems: (fn: (cur: T[]) => T[]) => void, i: number): DragProps =>
    editing
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            dragRef.current = { kind, index: i };
            e.dataTransfer.effectAllowed = "move";
          },
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault();
            const d = dragRef.current;
            if (!d || d.kind !== kind || d.index === i) return;
            setItems((cur) => arrMove(cur, d.index, i));
            d.index = i;
          },
          onDragEnd: () => {
            setItems((cur) => {
              saveOrder(
                kind,
                cur.map((x) => x.id ?? x.name ?? ""),
              );
              return cur;
            });
            dragRef.current = null;
          },
        }
      : undefined;

  const empty = (text: string) => (loaded ? <div className="empty">{text}</div> : null);

  return (
    <>
      <div className="aurora">
        <i />
        <i />
        <i />
      </div>
      <div className="shell">
        <section>
          <h2>Apps</h2>
          {apps.length || editing ? (
            <div className={`launcher ${editing ? "editing" : ""}`}>
              {apps.map((p, i) => (
                <Tile
                  key={p.name}
                  icon={p.icon}
                  fallback="📦"
                  name={p.title}
                  href={p.url || (p.repo && repoUrl(p.repo)) || undefined}
                  health={p.service?.health && p.service.health !== "unknown" ? p.service.health : undefined}
                  editing={editing}
                  onRemove={() => removeApp(p)}
                  removeTitle={p.manifestOnly ? "Delete" : "Hide"}
                  showPop={!prefs.noPop}
                  dragProps={dragProps("apps", setApps, i)}
                >
                  <p className="pop-title">
                    {p.title}
                    <span className={`status ${p.service?.health ?? p.status}`}>
                      <i />
                      {p.service ? HEALTH[p.service.health] || STATUS[p.status] : STATUS[p.status] || p.status}
                    </span>
                  </p>
                  {p.description && <p className="pop-body">{p.description}</p>}
                  {p.repo && (
                    <p className="pop-entry">
                      <a href={repoUrl(p.repo)} target="_blank" rel="noopener noreferrer">
                        repository ↗
                      </a>
                    </p>
                  )}
                </Tile>
              ))}
              {editing && (
                <button className="tile add" onClick={() => setAdding(true)}>
                  <span className="tile-icon">＋</span>
                  <span className="tile-name">Add</span>
                </button>
              )}
            </div>
          ) : (
            empty("No apps yet. Put an app with a space.yaml under apps/, or long-press the background to add one from a link.")
          )}
        </section>
        <section>
          <h2>Agents</h2>
          {agents.length ? (
            <div className={`launcher ${editing ? "editing" : ""}`}>
              {agents.map((a, i) => (
                <Tile
                  key={a.id}
                  icon={a.avatar}
                  fallback="🦾"
                  name={a.title}
                  editing={editing}
                  onOpen={() => {
                    setChatAgent(a);
                    setChatOpen(true);
                  }}
                  showPop={!prefs.noPop}
                  dragProps={dragProps("agents", setAgents, i)}
                >
                  <p className="pop-title">
                    {a.title}
                    <span className="status">
                      <i />
                      {a.app === "space" ? "space" : a.id}
                    </span>
                  </p>
                  {a.description && <p className="pop-body">{a.description}</p>}
                  <p className="pop-hint">Click to chat</p>
                </Tile>
              ))}
            </div>
          ) : (
            empty("No agents yet.")
          )}
        </section>
        {widgets.length > 0 && !prefs.noWidget && (
          <section>
            <h2>Widgets</h2>
            <div className={`widgets ${editing ? "editing" : ""}`}>
              {widgets.map((w, i) => (
                <Widget key={w.id} w={w} theme={theme} dragProps={dragProps("widgets", setWidgets, i)} />
              ))}
            </div>
          </section>
        )}
      </div>
      {!prefs.noPet && <Pet />}
      {adding && (
        <AddForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      <button className="fab set-btn" title="Settings" onClick={() => setSetsOpen((v) => !v)}>
        ⚙️
      </button>
      {setsOpen && (
        <div className="setpop">
          <label className="setrow">
            Hover details
            <input type="checkbox" checked={!prefs.noPop} onChange={() => togglePref("noPop")} />
          </label>
          <label className="setrow">
            Desk pet
            <input type="checkbox" checked={!prefs.noPet} onChange={() => togglePref("noPet")} />
          </label>
          <label className="setrow">
            Widgets
            <input type="checkbox" checked={!prefs.noWidget} onChange={() => togglePref("noWidget")} />
          </label>
          <label className="setrow">
            Dark mode
            <input type="checkbox" checked={theme === "dark"} onChange={() => setTheme(theme === "dark" ? "light" : "dark")} />
          </label>
          <p className="sethead">Services</p>
          {services === null ? (
            <p className="setnote">Loading…</p>
          ) : services.length ? (
            services.map((s) => (
              <div key={s.app} className="svcrow" title={`${s.app} · 127.0.0.1:${s.port}${s.headless ? " · no page" : ""}${s.hidden ? " · hidden" : ""}`}>
                <span className="svc-ico">
                  <Icon icon={s.icon} fallback="📦" />
                </span>
                <span className="svc-name">{s.title}</span>
                <span className="svc-port">:{s.port}</span>
                <span className={`status ${s.status === "active" ? s.health : s.status}`}>
                  <i />
                  {s.status === "active" ? HEALTH[s.health] || "?" : STATUS[s.status]}
                </span>
              </div>
            ))
          ) : (
            <p className="setnote">No services registered</p>
          )}
        </div>
      )}
      <Chat
        open={chatOpen}
        agent={chatAgent}
        onClose={() => setChatOpen(false)}
        onSwitch={(a) => {
          setChatAgent(a);
          setChatOpen(true);
        }}
      />
      <button
        className="fab chat-btn"
        title="Chat"
        onClick={() => {
          if (chatOpen) return setChatOpen(false);
          setChatAgent(agents.find((a) => a.id === "space/assistant") || chatAgent);
          setChatOpen(true);
        }}
      >
        ✨
      </button>
    </>
  );
}
