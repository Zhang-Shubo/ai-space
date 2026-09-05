import { useEffect, useMemo, useState } from "react";
import { type AppInfo, type RunInfo, type TaskInfo, fmtDuration, getJson, isImgIcon, relTime, scheduleText, untilTime } from "./api.ts";

// Tasks window (a floating panel): a read-only view of the scheduler, grouped by app.
// - Reads `GET /api/tasks` when opened and every 30 s while open; the list is small (tens of tasks).
// - A row shows the effective schedule, the next run, the last outcome; clicking it loads run history.
// - App titles and icons come from `GET /api/apps?all=1` so headless and hidden apps still get a name.
// Nothing here mutates: the mutating task routes need the operator token, which the browser never holds.

type AppLabel = { title: string; icon: string };

function Ico({ icon }: { icon: string }) {
  const [broken, setBroken] = useState(false);
  if (isImgIcon(icon) && !broken) return <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <>{isImgIcon(icon) ? "📦" : icon || "📦"}</>;
}

/** Status class of a row: the dot colour follows the last outcome; off and orphaned rows are muted. */
function rowStatus(t: TaskInfo): { cls: string; text: string } {
  if (t.orphaned) return { cls: "off", text: "orphaned" };
  if (!t.enabled) return { cls: "off", text: "off" };
  if (t.state.runningAt) return { cls: "running", text: "running" };
  switch (t.state.lastStatus) {
    case "ok":
      return { cls: "ok", text: "ok" };
    case "error":
      return { cls: "down", text: t.state.consecutiveErrors > 1 ? `error ×${t.state.consecutiveErrors}` : "error" };
    case "skipped":
      return { cls: "paused", text: "skipped" };
    default:
      return { cls: "", text: "never ran" };
  }
}

function Runs({ taskId }: { taskId: string }) {
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setRuns(null);
    getJson<{ runs: RunInfo[] }>(`/api/tasks/${encodeURIComponent(taskId)}/runs?limit=20`)
      .then((d) => setRuns(d.runs || []))
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [taskId]);
  if (err) return <p className="task-note">Unavailable: {err}</p>;
  if (runs === null) return <p className="task-note">Loading…</p>;
  if (!runs.length) return <p className="task-note">No runs yet</p>;
  return (
    <div className="runs">
      {runs.map((r) => (
        <div key={r.id} className="runrow">
          <div className="run-line">
            <span className={`status ${r.status === "ok" ? "ok" : r.status === "error" ? "down" : "paused"}`}>
              <i />
              {r.status}
            </span>
            <span className="run-time" title={new Date(r.startedAt).toLocaleString()}>
              {relTime(r.startedAt)}
            </span>
            <span className="run-dur">{fmtDuration(r.endedAt - r.startedAt)}</span>
          </div>
          {r.error && <div className="run-err">{r.error}</div>}
          {r.output && <pre className="run-out">{r.output}</pre>}
        </div>
      ))}
    </div>
  );
}

function TaskRow({ t, open, onToggle }: { t: TaskInfo; open: boolean; onToggle: () => void }) {
  const st = rowStatus(t);
  const next = t.enabled && !t.orphaned && t.state.nextRunAt ? untilTime(t.state.nextRunAt) : "";
  const last = t.state.lastRunAt ? relTime(t.state.lastRunAt) : "";
  const badges = [t.source === "api" ? "api" : "", t.overrides.enabled !== undefined || t.overrides.schedule ? "override" : ""].filter(Boolean);
  return (
    <div className={`taskrow ${st.cls} ${open ? "open" : ""}`}>
      <button className="task-main" onClick={onToggle} title={t.description || `${t.app}/${t.name}`}>
        <span className={`status ${st.cls}`}>
          <i />
        </span>
        <span className="task-text">
          <span className="task-line">
            <span className="task-name">{t.name}</span>
            {badges.map((b) => (
              <span key={b} className="task-badge">
                {b}
              </span>
            ))}
            <span className="task-sched">{scheduleText(t.schedule)}</span>
          </span>
          <span className="task-meta">
            <span>{st.text}</span>
            {t.state.lastDurationMs !== undefined && <span>{fmtDuration(t.state.lastDurationMs)}</span>}
            {last && <span title={t.state.lastRunAt && new Date(t.state.lastRunAt).toLocaleString()}>{last}</span>}
            {next && <span title={t.state.nextRunAt && new Date(t.state.nextRunAt).toLocaleString()}>next {next}</span>}
            <span className="task-kind">{t.target.kind}</span>
          </span>
        </span>
      </button>
      {open && (
        <div className="task-detail">
          {t.description && <p className="task-desc">{t.description}</p>}
          <Runs taskId={t.id} />
        </div>
      )}
    </div>
  );
}

export default function Tasks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [apps, setApps] = useState<Record<string, AppLabel>>({});
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const load = () =>
      getJson<{ tasks: TaskInfo[] }>("/api/tasks")
        .then((d) => {
          setTasks(d.tasks || []);
          setErr("");
        })
        .catch((e) => setErr(String((e as Error).message || e)));
    load();
    getJson<{ apps: AppInfo[] }>("/api/apps?all=1")
      .then((d) => setApps(Object.fromEntries((d.apps || []).map((a) => [a.name, { title: a.title, icon: a.icon }]))))
      .catch(() => {});
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const groups = useMemo(() => {
    const byApp = new Map<string, TaskInfo[]>();
    for (const t of tasks || []) byApp.set(t.app, [...(byApp.get(t.app) || []), t]);
    const label = (app: string) => apps[app]?.title || app;
    return [...byApp.entries()]
      .sort(([a], [b]) => label(a).localeCompare(label(b)))
      .map(([app, list]) => ({ app, title: label(app), icon: apps[app]?.icon || "📦", list: list.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [tasks, apps]);

  const total = tasks?.length ?? 0;
  const active = tasks?.filter((t) => t.enabled && !t.orphaned).length ?? 0;
  const failing = tasks?.filter((t) => t.enabled && !t.orphaned && t.state.lastStatus === "error").length ?? 0;

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks" role="dialog" aria-label="Tasks">
      <div className="task-head">
        <b>Tasks</b>
        <span className="chat-sub">
          {tasks === null ? "" : `${active} of ${total} active${failing ? ` · ${failing} failing` : ""}`}
        </span>
        <button className="chat-hbtn" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="task-body">
        {err && <p className="task-note">Unavailable: {err}</p>}
        {tasks === null && !err && <p className="task-note">Loading…</p>}
        {tasks !== null && !total && <p className="task-note">No scheduled tasks. Declare some under tasks: in an app's space.yaml.</p>}
        {groups.map((g) => (
          <section key={g.app} className="task-group">
            <div className="task-app">
              <span className="svc-ico">
                <Ico icon={g.icon} />
              </span>
              <span className="svc-name">{g.title}</span>
              <span className="svc-port">{g.list.length}</span>
            </div>
            {g.list.map((t) => (
              <TaskRow key={t.id} t={t} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)} />
            ))}
          </section>
        ))}
      </div>
      </div>
    </div>
  );
}
