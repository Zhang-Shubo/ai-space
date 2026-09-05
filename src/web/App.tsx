import { type ReactNode, useEffect, useRef, useState } from "react";
import Chat from "./Chat.tsx";
import Pet, { DEFAULT_SHEET } from "./Pet.tsx";
import Tasks from "./Tasks.tsx";
import { getJson, isImgIcon, relTime, repoUrl, sendJson, type AgentInfo, type AppInfo, type PeerInfo, type ServiceInfo, type WidgetInfo } from "./api.ts";
import { type Key, LANGS, type Lang, localized, saveLang, useLang, withLang } from "./i18n.ts";
import { type PetChoice, type PetdexPet, loadPetdex, resolvePet, suggestPets } from "./petdex.ts";

// Launcher-style panel: App and Agent tiles with hover details, widget cards, a chat window.
// Settings is a built-in tile at the end of the Apps grid; it, the chat and the tasks list open as
// floating panels over the page (an overlay that closes on a click outside).
// Edit mode (long-press the background): add an app from a link, hide or delete, drag to reorder.
// Everything comes from the apps' manifests through the panel API; the browser holds no secrets.
// Entries from peer machines say where they run in their hover details and are muted while that peer is down.
// Every string the panel owns goes through `t` (i18n.ts); manifest text is picked with `localized`.

const STATUS: Record<string, Key> = { active: "status.active", paused: "status.paused", archived: "status.archived" };
const HEALTH: Record<string, Key | undefined> = { ok: "status.up", down: "status.down", unknown: undefined };

type DragProps = Partial<Record<"draggable" | "onDragStart" | "onDragOver" | "onDragEnd" | "data-drop", unknown>> | undefined;

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
  editing,
  onRemove,
  removeTitle,
  onOpen,
  showPop = true,
  dragProps,
  stale,
  corner,
  className,
  children,
}: {
  icon: string;
  fallback: string;
  name: string;
  href?: string;
  editing: boolean;
  onRemove?: () => void;
  removeTitle?: string;
  onOpen?: () => void;
  showPop?: boolean;
  dragProps?: DragProps;
  /** The peer is not answering: the entry is its last known state. */
  stale?: boolean;
  /** A small icon over the icon's bottom-right corner: the app an agent belongs to. */
  corner?: string;
  className?: string;
  children?: ReactNode;
}) {
  // onOpen wins over href: agent tiles open the chat window; links move into the pop-over.
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
      <span className={`tile-icon ${isImgIcon(icon) ? "" : "solid"}`}>
        <Icon icon={icon} fallback={fallback} />
        {corner && (
          <span className={`tile-corner ${isImgIcon(corner) ? "" : "solid"}`}>
            <Icon icon={corner} fallback="📦" />
          </span>
        )}
      </span>
      <span className="tile-name">{name}</span>
      {!editing && !popHidden && showPop && <div className="pop">{children}</div>}
    </>
  );
  const common = {
    className: `tile${stale ? " stale" : ""}${className ? ` ${className}` : ""}`,
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

/** Grid gap of `.widgets`, for turning a drag distance into columns and rows. */
const WIDGET_GAP = 20;
const MAX_COLS = 2;
const MAX_ROWS = 2;

function Widget({ w, dragProps, theme, onResize }: { w: WidgetInfo; dragProps?: DragProps; theme: string; onResize?: (size: string, commit: boolean) => void }) {
  const { lang, t } = useLang();
  const title = localized(lang, w).title;
  const embed = `${w.peer ? `/api/peers/${encodeURIComponent(w.peer)}` : "/api"}/widgets/${encodeURIComponent(w.app)}/${encodeURIComponent(w.name)}/embed?theme=${theme}&lang=${lang}`;
  const link = w.link ? withLang(w.link, lang) : "";
  const tall = w.size.endsWith("x2");
  const card = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  // Edit mode: the handle in the bottom-right corner resizes by dragging (pointer events, so the
  // HTML5 drag that reorders cards does not start). One cell is the card's current width divided by
  // its columns; crossing half a cell snaps to the next size, and the size is saved on release.
  const startResize = (e: React.PointerEvent) => {
    if (!onResize || !card.current) return;
    e.preventDefault();
    e.stopPropagation();
    const [cols0, rows0] = w.size.split("x").map(Number) as [number, number];
    const rect = card.current.getBoundingClientRect();
    const cellW = (rect.width - WIDGET_GAP * (cols0 - 1)) / cols0;
    const cellH = (rect.height - WIDGET_GAP * (rows0 - 1)) / rows0;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last = w.size;
    const sizeAt = (ev: PointerEvent) => {
      const cols = Math.min(MAX_COLS, Math.max(1, cols0 + Math.round((ev.clientX - x0) / (cellW + WIDGET_GAP))));
      const rows = Math.min(MAX_ROWS, Math.max(1, rows0 + Math.round((ev.clientY - y0) / (cellH + WIDGET_GAP))));
      return `${cols}x${rows}`;
    };
    const move = (ev: PointerEvent) => {
      const next = sizeAt(ev);
      setResizing(next);
      if (next !== last) {
        last = next;
        onResize(next, false);
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setResizing(null);
      onResize(sizeAt(ev), true);
      // The release also produces a click, wherever the pointer ended up; a click on the
      // background would leave edit mode, so the one that follows this drag is swallowed.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    <div ref={card} className={`widget s${w.size}${w.stale ? " stale" : ""}${resizing ? " resizing" : ""}`} {...(dragProps as object)} title={w.stale ? t("widget.stale", { peer: w.peer ?? "" }) : undefined}>
      <div className="widget-head">
        <span className="widget-ico">
          <Icon icon={w.icon} fallback="📦" />
        </span>
        <b>{title}</b>
        {w.peer && <span className="widget-peer">{w.peer}</span>}
        {onResize && <span className="widget-size">{(resizing ?? w.size).replace("x", "×")}</span>}
      </div>
      {onResize && <span className="widget-grip" title={t("widget.resizeHint")} draggable={false} onPointerDown={startResize} onDragStart={(e) => e.preventDefault()} />}
      {w.kind === "embed" ? (
        <iframe title={title} src={embed} sandbox="allow-scripts" loading="lazy" />
      ) : w.ok ? (
        <div className="widget-list">
          {w.items.slice(0, tall ? 14 : 6).map((it, i) => (
            <a key={i} href={it.url || link} target="_blank" rel="noopener noreferrer">
              <span className="wi-text">{it.text}</span>
              {it.time && <span className="wi-time">{relTime(it.time, lang)}</span>}
            </a>
          ))}
          {!w.items.length && <p className="widget-err">{t("widget.empty")}</p>}
        </div>
      ) : (
        <p className="widget-err">{t("common.unavailable", { error: w.error })}</p>
      )}
      {link && (
        <a className="widget-more" href={link} target="_blank" rel="noopener noreferrer">
          {t("widget.viewAll")}
        </a>
      )}
    </div>
  );
}

function AddForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useLang();
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!/^https?:\/\//.test(link.trim())) return setErr(t("add.needLink"));
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
          {t("add.title")}<span className="modal-sub">{t("add.sub")}</span>
        </h3>
        <div className="field">
          <label>{t("add.link")}</label>
          <input value={link} onChange={(e) => setLink(e.target.value)} disabled={busy} placeholder={t("add.placeholder")} onKeyDown={(e) => e.key === "Enter" && !busy && save()} />
        </div>
        <div className="form-hint">{t("add.hint")}</div>
        {err && <div className="form-err">{err}</div>}
        <div className="actions">
          <button className="btn2" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn2 primary" onClick={save} disabled={busy}>
            {busy ? t("add.resolving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The confirmation behind the uninstall zone: says what will happen to this app (service, directory,
 * data) and sends the DELETE, to the hub route for a peer's app.
 */
function UninstallForm({ app, onClose, onDone }: { app: AppInfo; onClose: () => void; onDone: () => void }) {
  const { lang, t } = useLang();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const path = app.peer ? `/api/peers/${encodeURIComponent(app.peer)}/apps/${encodeURIComponent(app.name)}` : `/api/apps/${encodeURIComponent(app.name)}`;
  const run = async () => {
    setErr("");
    setBusy(true);
    try {
      await sendJson("DELETE", path);
      onDone();
    } catch (e) {
      setErr(String((e as Error).message || e));
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {t("uninstall.title", { title: localized(lang, app).title })}
          {app.peer && <span className="modal-sub">{t("common.onPeer", { peer: app.peer })}</span>}
        </h3>
        <ul className="modal-list">
          {app.service ? <li>{t("uninstall.stopService", { port: app.service.port })}</li> : <li>{t("uninstall.noService")}</li>}
          {app.manifestOnly ? <li>{t("uninstall.deleteLink")}</li> : <li>{t("uninstall.moveDir")}</li>}
          <li>{t("uninstall.forget")}</li>
        </ul>
        {err && <div className="form-err">{err}</div>}
        <div className="actions">
          <button className="btn2" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn2 danger" onClick={run} disabled={busy}>
            {busy ? t("uninstall.busy") : t("uninstall.action")}
          </button>
        </div>
      </div>
    </div>
  );
}

type Prefs = { noPop?: boolean; noPet?: boolean; noWidget?: boolean; pet?: PetChoice };

/**
 * The pet picker in the settings pop-over: type a name from petdex.dev, the sheet URL is looked up in
 * the public manifest and kept in the preferences. Empty means the bundled default.
 */
function PetField({ pet, onChange }: { pet: PetChoice | undefined; onChange: (p: PetChoice | undefined) => void }) {
  const { t } = useLang();
  const [query, setQuery] = useState(pet?.slug || "");
  const [pets, setPets] = useState<PetdexPet[] | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "error"; text: string }>({ kind: "idle" });
  useEffect(() => setQuery(pet?.slug || ""), [pet?.slug]);
  const warm = () => {
    if (pets) return;
    loadPetdex()
      .then(setPets)
      .catch(() => {});
  };
  const apply = () => {
    const q = query.trim();
    if (q === (pet?.slug || "")) return;
    if (!q) {
      setState({ kind: "idle" });
      return onChange(undefined);
    }
    setState({ kind: "busy" });
    resolvePet(q)
      .then((p) => {
        if (!p) return setState({ kind: "error", text: t("pet.notFound", { name: q }) });
        setState({ kind: "idle" });
        onChange(p);
      })
      .catch(() => setState({ kind: "error", text: t("pet.unreachable") }));
  };
  const note = state.kind === "busy" ? t("pet.lookingUp") : state.kind === "error" ? state.text : pet ? (pet.by ? t("pet.by", { name: pet.name, by: pet.by }) : pet.name) : t("pet.default");
  return (
    <div className="setfield">
      <div className="setinput">
        <input
          list="petdex-pets"
          placeholder={t("pet.placeholder")}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onFocus={warm}
          onChange={(e) => {
            setQuery(e.target.value);
            warm();
          }}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {/* Always in the DOM so the row keeps its width; hidden until there is something to clear. */}
        <button
          type="button"
          title={t("pet.reset")}
          style={{ visibility: pet || query ? "visible" : "hidden" }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery("");
            setState({ kind: "idle" });
            onChange(undefined);
          }}
        >
          ×
        </button>
        <datalist id="petdex-pets">
          {suggestPets(pets || [], query).map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </datalist>
      </div>
      <p className={`setnote${state.kind === "error" ? " err" : ""}`}>{note}</p>
    </div>
  );
}

/** `onLang` changes the language of the whole page; the root (main.tsx) owns the value and provides it. */
export default function App({ onLang }: { onLang: (lang: Lang) => void }) {
  const { lang, t } = useLang();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("panel-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  // The app dropped on the uninstall zone, awaiting confirmation; `zoneHot` while a tile hovers the zone.
  const [uninstalling, setUninstalling] = useState<AppInfo | null>(null);
  const [zoneHot, setZoneHot] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // One floating panel at a time: opening the settings, the chat or the tasks closes the others.
  const [tasksOpen, setTasksOpen] = useState(false);
  // The chat opens on the space agent by default; an agent tile switches to that agent.
  const [chatAgent, setChatAgent] = useState<AgentInfo>({ id: "space/assistant", app: "space", name: "assistant", title: "Base", i18n: { zh: { title: "基础" } }, avatar: "✨", appIcon: "✨", runtime: "claude" });
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      return (JSON.parse(localStorage.getItem("panel-prefs") || "{}") as Prefs) || {};
    } catch {
      return {};
    }
  });
  const [setsOpen, setSetsOpen] = useState(false);
  // Services: every app that runs a process, with or without a page, plus the peer machines whose
  // panels this one merges. Loaded each time the settings open so the health dots are fresh (the
  // server caches probes for 15 s and peer snapshots for their refresh period).
  const [services, setServices] = useState<{ services: ServiceInfo[]; peers: PeerInfo[] } | null>(null);
  useEffect(() => {
    if (!setsOpen) return;
    getJson<{ services: ServiceInfo[]; peers: PeerInfo[] }>("/api/services")
      .then((d) => setServices({ services: d.services || [], peers: d.peers || [] }))
      .catch(() => setServices({ services: [], peers: [] }));
  }, [setsOpen]);
  const savePrefs = (n: Prefs) => {
    localStorage.setItem("panel-prefs", JSON.stringify(n));
    return n;
  };
  const togglePref = (k: "noPop" | "noPet" | "noWidget") => setPrefs((p) => savePrefs({ ...p, [k]: !p[k] }));
  const setPet = (pet: PetChoice | undefined) => setPrefs((p) => savePrefs({ ...p, pet }));
  // A chosen sheet that no longer loads (the pet was re-uploaded, or petdex is down): look the name up
  // again and keep the new URL; until then the default pet stands in. The choice itself is kept.
  const [petBroken, setPetBroken] = useState<string | null>(null);
  const petSheet = prefs.pet && prefs.pet.url !== petBroken ? prefs.pet.url : DEFAULT_SHEET;
  const onPetError = (url: string) => {
    setPetBroken(url);
    const slug = prefs.pet?.slug;
    if (!slug) return;
    resolvePet(slug)
      .then((p) => {
        if (p && p.url !== url) setPet(p);
      })
      .catch(() => {});
  };
  useEffect(() => {
    if (!setsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSetsOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setsOpen]);
  const openSettings = () => {
    setChatOpen(false);
    setTasksOpen(false);
    setSetsOpen(true);
  };
  const openChat = (a: AgentInfo) => {
    setChatAgent(a);
    setSetsOpen(false);
    setTasksOpen(false);
    setChatOpen(true);
  };

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

  // Long-press (550 ms, under 8 px of movement) on the background enters edit mode; a click on the
  // background leaves it. The listeners mount once and read `editing` through a ref: remounting on
  // every change would reset the `fired` flag and mistake the long-press release for an exit click.
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  useEffect(() => {
    const blank = (e: MouseEvent) => e.button === 0 && !(e.target as Element).closest(".tile, .modal, .overlay, .pop, .empty, .pet, .widget, a, button, input, select, textarea");
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

  // Remove from the panel: manifest-only apps are deleted, apps with code are hidden; a peer's app is
  // hidden on this panel only (the peer is never changed from here).
  const removeApp = async (app: AppInfo) => {
    try {
      if (app.peer) await sendJson("PATCH", `/api/peers/${encodeURIComponent(app.peer)}/apps/${encodeURIComponent(app.name)}`, { hidden: true });
      else if (app.manifestOnly) await sendJson("DELETE", `/api/apps/${encodeURIComponent(app.name)}`);
      else await sendJson("PATCH", `/api/apps/${encodeURIComponent(app.name)}`, { hidden: true });
    } catch {
      /* the reload shows the real state */
    }
    reload();
  };

  // Drag to reorder in edit mode (HTML5 DnD). The list is not reordered while the drag is in
  // progress: moving the dragged node in the DOM makes the browser end the drag, which limited a
  // drag to one step. The tile under the pointer is marked instead (`data-drop`), and the move
  // happens when the tile is dropped.
  const dragRef = useRef<{ kind: string; index: number; over: number } | null>(null);
  const [dragOver, setDragOver] = useState<{ kind: string; index: number } | null>(null);
  const arrMove = <T,>(arr: T[], from: number, to: number) => {
    const a = arr.slice();
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x as T);
    return a;
  };
  const saveOrder = (kind: string, ids: string[]) => sendJson("PUT", "/api/panel/layout", { order: { [kind]: ids } }).catch(() => {});
  // A widget size dragged in edit mode: shown while the drag goes on, stored in the layout (as an
  // override of the manifest's) when the handle is released.
  const resizeWidget = (w: WidgetInfo, size: string, commit: boolean) => {
    setWidgets((cur) => cur.map((x) => (x.id === w.id ? { ...x, size } : x)));
    if (commit) sendJson("PUT", "/api/panel/layout", { sizes: { [w.id]: size } }).catch(() => {});
  };
  const dragProps = <T extends { name?: string; id?: string }>(kind: string, setItems: (fn: (cur: T[]) => T[]) => void, i: number): DragProps =>
    editing
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            dragRef.current = { kind, index: i, over: i };
            e.dataTransfer.effectAllowed = "move";
          },
          onDragOver: (e: React.DragEvent) => {
            const d = dragRef.current;
            if (!d || d.kind !== kind) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (d.over === i) return;
            d.over = i;
            setDragOver(i === d.index ? null : { kind, index: i });
          },
          onDragEnd: () => {
            const d = dragRef.current;
            dragRef.current = null;
            setDragOver(null);
            if (!d || d.over === d.index) return;
            setItems((cur) => {
              const next = arrMove(cur, d.index, d.over);
              saveOrder(
                kind,
                next.map((x) => x.id ?? x.name ?? ""),
              );
              return next;
            });
          },
          "data-drop": dragOver?.kind === kind && dragOver.index === i ? (i < (dragRef.current?.index ?? -1) ? "before" : "after") : undefined,
        }
      : undefined;

  const empty = (text: string) => (loaded ? <div className="empty">{text}</div> : null);
  const pickLang = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as Lang;
    saveLang(next);
    onLang(next);
  };

  return (
    <>
      <div className="aurora">
        <i />
        <i />
        <i />
      </div>
      <div className="shell">
        <section>
          <h2>{t("apps.heading")}</h2>
          <div className={`launcher ${editing ? "editing" : ""}`}>
              {apps.map((p, i) => {
                const shown = localized(lang, p);
                const statusKey = p.service ? HEALTH[p.service.health] ?? STATUS[p.status] : STATUS[p.status];
                return (
                <Tile
                  key={p.id}
                  icon={p.icon}
                  fallback="📦"
                  name={shown.title}
                  href={p.url ? withLang(p.url, lang) : undefined}
                  editing={editing}
                  onRemove={() => removeApp(p)}
                  removeTitle={p.manifestOnly ? t("common.delete") : t("common.hide")}
                  showPop={!prefs.noPop}
                  dragProps={dragProps("apps", setApps, i)}
                  stale={p.stale}
                >
                  <p className="pop-title">
                    {shown.title}
                    <span className={`status ${p.service?.health ?? p.status}`}>
                      <i />
                      {statusKey ? t(statusKey) : p.status}
                    </span>
                  </p>
                  {p.peer && <p className="pop-hint">{t(p.stale ? "common.onPeerStale" : "common.onPeer", { peer: p.peer })}</p>}
                  {shown.description && <p className="pop-body">{shown.description}</p>}
                  {p.repo && (
                    <p className="pop-entry">
                      <a href={repoUrl(p.repo)} target="_blank" rel="noopener noreferrer">
                        {t("apps.repo")}
                      </a>
                    </p>
                  )}
                </Tile>
                );
              })}
              <Tile icon="/settings.svg" fallback="⚙️" name={t("settings.title")} editing={editing} onOpen={openSettings} showPop={!prefs.noPop} className="builtin">
                <p className="pop-title">
                  {t("settings.title")}
                  <span className="status">
                    <i />
                    {t("status.builtIn")}
                  </span>
                </p>
                <p className="pop-body">{t("settings.blurb")}</p>
              </Tile>
              {editing && (
                <button className="tile add" onClick={() => setAdding(true)}>
                  <span className="tile-icon">＋</span>
                  <span className="tile-name">{t("apps.add")}</span>
                </button>
              )}
          </div>
          {!apps.length && empty(t("apps.empty"))}
          {editing && (
            <div
              className={`dropzone${zoneHot ? " hot" : ""}`}
              onDragOver={(e) => {
                const d = dragRef.current;
                if (d?.kind !== "apps") return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                d.over = d.index;
                setDragOver(null);
                setZoneHot(true);
              }}
              onDragLeave={() => setZoneHot(false)}
              onDrop={(e) => {
                e.preventDefault();
                setZoneHot(false);
                const d = dragRef.current;
                if (d?.kind === "apps") {
                  d.over = d.index;
                  setUninstalling(apps[d.index] ?? null);
                }
              }}
            >
              <span className="dropzone-icon">🗑</span>
              <span>
                <b>{t("uninstall.action")}</b> · {t("uninstall.zoneHint")}
              </span>
            </div>
          )}
        </section>
        <section>
          <h2>{t("agents.heading")}</h2>
          {agents.length ? (
            <div className={`launcher ${editing ? "editing" : ""}`}>
              {agents.map((a, i) => {
                const shown = localized(lang, a);
                return (
                <Tile
                  key={a.id}
                  icon={a.avatar}
                  fallback="🦾"
                  name={shown.title}
                  editing={editing}
                  onOpen={() => openChat(a)}
                  showPop={!prefs.noPop}
                  dragProps={dragProps("agents", setAgents, i)}
                  corner={a.app !== "space" && a.appIcon !== a.avatar ? a.appIcon : undefined}
                >
                  <p className="pop-title">
                    {shown.title}
                    <span className="status">
                      <i />
                      {a.app === "space" ? t("status.base") : a.id}
                    </span>
                  </p>
                  {a.peer && <p className="pop-hint">{t("common.onPeer", { peer: a.peer })}</p>}
                  {shown.description && <p className="pop-body">{shown.description}</p>}
                  <p className="pop-hint">{t("agents.clickToChat")}</p>
                </Tile>
                );
              })}
            </div>
          ) : (
            empty(t("agents.empty"))
          )}
        </section>
        {widgets.length > 0 && !prefs.noWidget && (
          <section>
            <h2>{t("widgets.heading")}</h2>
            <div className={`widgets ${editing ? "editing" : ""}`}>
              {widgets.map((w, i) => (
                <Widget key={w.id} w={w} theme={theme} dragProps={dragProps("widgets", setWidgets, i)} onResize={editing ? (size, commit) => resizeWidget(w, size, commit) : undefined} />
              ))}
            </div>
          </section>
        )}
      </div>
      {!prefs.noPet && <Pet sheet={petSheet} onError={onPetError} />}
      {uninstalling && (
        <UninstallForm
          app={uninstalling}
          onClose={() => setUninstalling(null)}
          onDone={() => {
            setUninstalling(null);
            reload();
          }}
        />
      )}
      {adding && (
        <AddForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {setsOpen && (
        <div className="overlay top" onClick={() => setSetsOpen(false)}>
          <div className="panel settings" role="dialog" aria-label={t("settings.title")} onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <b>{t("settings.title")}</b>
              <button className="chat-hbtn" title={t("common.close")} onClick={() => setSetsOpen(false)}>
                ✕
              </button>
            </div>
            <div className="setbody">
              <label className="setrow">
                {t("settings.hover")}
                <input type="checkbox" role="switch" checked={!prefs.noPop} onChange={() => togglePref("noPop")} />
              </label>
              <label className="setrow">
                {t("settings.pet")}
                <input type="checkbox" role="switch" checked={!prefs.noPet} onChange={() => togglePref("noPet")} />
              </label>
              {!prefs.noPet && <PetField pet={prefs.pet} onChange={setPet} />}
              <label className="setrow">
                {t("settings.widgets")}
                <input type="checkbox" role="switch" checked={!prefs.noWidget} onChange={() => togglePref("noWidget")} />
              </label>
              <label className="setrow">
                {t("settings.dark")}
                <input type="checkbox" role="switch" checked={theme === "dark"} onChange={() => setTheme(theme === "dark" ? "light" : "dark")} />
              </label>
              <label className="setrow">
                {t("settings.language")}
                <select className="setselect" value={lang} onChange={pickLang}>
                  {LANGS.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="sethead">{t("settings.scheduler")}</p>
              <button
                className="setrow setlink"
                onClick={() => {
                  setSetsOpen(false);
                  setChatOpen(false);
                  setTasksOpen(true);
                }}
              >
                {t("settings.tasks")}
                <span>›</span>
              </button>
              {services && services.peers.length > 0 && (
                <>
                  <p className="sethead">{t("settings.peers")}</p>
                  {services.peers.map((p) => (
                    <div key={p.name} className="svcrow" title={`${p.url}\n${t("settings.peerCounts", { apps: p.apps, agents: p.agents, widgets: p.widgets, services: p.services })}${p.asOf ? `\n${t("settings.snapshot", { time: relTime(p.asOf, lang) })}` : ""}${p.error ? `\n${p.error}` : ""}`}>
                      <span className="svc-ico">🛰</span>
                      <span className="svc-name">{p.name}</span>
                      {p.health !== "ok" && p.asOf && <span className="svc-port">{relTime(p.asOf, lang)}</span>}
                      <span className={`status ${p.health}`}>
                        <i />
                        {t(p.health === "ok" ? "status.up" : "status.down")}
                      </span>
                    </div>
                  ))}
                </>
              )}
              <p className="sethead">{t("settings.services")}</p>
              {services === null ? (
                <p className="setnote">{t("common.loading")}</p>
              ) : services.services.length ? (
                services.services.map((s) => {
                  const statusKey = s.status === "active" ? HEALTH[s.health] : STATUS[s.status];
                  return (
                  <div key={`${s.peer ?? ""}/${s.app}`} className="svcrow" title={`${s.peer ? `${s.peer}/` : ""}${s.app} · 127.0.0.1:${s.port}${s.hidden ? ` · ${t("status.hidden")}` : ""}`}>
                    <span className="svc-ico">
                      <Icon icon={s.icon} fallback="📦" />
                    </span>
                    <span className="svc-name">{localized(lang, s).title}</span>
                    {s.peer && <span className="svc-peer">{s.peer}</span>}
                    <span className="svc-port">:{s.port}</span>
                    <span className={`status ${s.status === "active" ? s.health : s.status}`}>
                      <i />
                      {statusKey ? t(statusKey) : "?"}
                    </span>
                  </div>
                  );
                })
              ) : (
                <p className="setnote">{t("settings.noServices")}</p>
              )}
            </div>
          </div>
        </div>
      )}
      <Tasks open={tasksOpen} onClose={() => setTasksOpen(false)} />
      <Chat
        open={chatOpen}
        agent={chatAgent}
        onClose={() => setChatOpen(false)}
        onSwitch={openChat}
      />
    </>
  );
}
