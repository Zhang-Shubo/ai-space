import { createContext, useContext, useMemo } from "react";

/**
 * Languages of the panel (see docs/i18n.md). The English dictionary defines the key set; every other
 * dictionary is typed against it so a missing key fails `tsc`. `{name}` placeholders are filled by
 * `translate`. Manifest text (app, agent and widget titles) is chosen with `localized` from the
 * `i18n` field the API sends next to the plain field.
 */

export type Lang = "en" | "zh";
/** The languages the Settings row offers, with their native names. */
export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
];
/** The BCP 47 tag handed to `toLocaleString` for dates. */
export const LOCALE: Record<Lang, string> = { en: "en", zh: "zh-CN" };
const STORAGE_KEY = "panel-lang";

const en = {
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.close": "Close",
  "common.delete": "Delete",
  "common.hide": "Hide",
  "common.loading": "Loading…",
  "common.unavailable": "Unavailable: {error}",
  "common.onPeer": "On {peer}",
  "common.onPeerStale": "On {peer}, which is not answering; last known state",

  "status.active": "active",
  "status.paused": "paused",
  "status.archived": "archived",
  "status.up": "up",
  "status.down": "down",
  "status.ok": "ok",
  "status.builtIn": "built in",
  "status.base": "base",
  "status.hidden": "hidden",

  "apps.heading": "Apps",
  "apps.add": "Add",
  "apps.repo": "repository ↗",
  "apps.empty": "No apps yet. Put an app with a space.yaml under apps/, or long-press the background to add one from a link.",

  "agents.heading": "Agents",
  "agents.clickToChat": "Click to chat",
  "agents.empty": "No agents yet.",

  "widgets.heading": "Widgets",
  "widget.empty": "Nothing yet",
  "widget.viewAll": "View all →",
  "widget.resizeHint": "Drag to resize (columns × rows)",
  "widget.stale": "{peer} is not answering; last known state",

  "add.title": "Add app",
  "add.sub": "from a link, resolved by the agent",
  "add.link": "Link *",
  "add.placeholder": "https://github.com/you/my-app or https://tool.example.com",
  "add.hint": "The name, icon and description are read from the link and written to a manifest-only app under apps/.",
  "add.needLink": "Enter a link (a repository or a service address)",
  "add.resolving": "Resolving…",

  "uninstall.action": "Uninstall",
  "uninstall.title": "Uninstall {title}",
  "uninstall.busy": "Uninstalling…",
  "uninstall.stopService": "Its service is stopped (port {port}).",
  "uninstall.noService": "It has no service to stop.",
  "uninstall.deleteLink": "The link entry is deleted.",
  "uninstall.moveDir": "Its directory leaves the workspace: a symlink is removed, a checkout is moved to the workspace trash. No code is deleted.",
  "uninstall.forget": "Its tasks, agents and widgets disappear from the panel. The data directory is kept.",
  "uninstall.zoneHint": "drop an app here to stop its service and remove it from the space; its data stays",

  "settings.title": "Settings",
  "settings.blurb": "Preferences, scheduled tasks, peers and services of this space.",
  "settings.hover": "Hover details",
  "settings.pet": "Desk pet",
  "settings.widgets": "Widgets",
  "settings.dark": "Dark mode",
  "settings.language": "Language",
  "settings.scheduler": "Scheduler",
  "settings.tasks": "Scheduled tasks",
  "settings.peers": "Peers",
  "settings.peerCounts": "{apps} apps · {agents} agents · {widgets} widgets · {services} services",
  "settings.snapshot": "snapshot {time}",
  "settings.services": "Services",
  "settings.noServices": "No services registered",

  "pet.placeholder": "Pet name from petdex.dev",
  "pet.reset": "Back to the default pet",
  "pet.lookingUp": "Looking up…",
  "pet.notFound": "No pet called “{name}” on petdex.dev",
  "pet.unreachable": "petdex.dev is unreachable",
  "pet.by": "{name} · by {by}",
  "pet.default": "Capybara (built in)",
  "pet.clickMe": "Click me",

  "chat.starting": "Starting…",
  "chat.thinking": "Thinking…",
  "chat.thinkingModel": "Thinking… ({model})",
  "chat.queued": " (+{n} queued)",
  "chat.running": "Running {name}…",
  "chat.wentWrong": "Something went wrong",
  "chat.interrupted": "⏹ Interrupted",
  "chat.noOutput": "(no output)",
  "chat.inSession": "in session",
  "chat.newSession": "new session",
  "chat.interrupt": "Interrupt",
  "chat.history": "History",
  "chat.newConversation": "New conversation",
  "chat.modelTitle": "Model (next message)",
  "chat.modelDefault": "default model",
  "chat.modelHaiku": "haiku · fast",
  "chat.modelSonnet": "sonnet",
  "chat.modelOpus": "opus · strong",
  "chat.modelFable": "fable · strongest",
  "chat.permTitle": "Write access (next message)",
  "chat.permRead": "🔒 read-only",
  "chat.permEdit": "✏️ edit files",
  "chat.permAll": "⚡ all permissions",
  "chat.noSessions": "No past sessions",
  "chat.untitled": "(untitled)",
  "chat.transcriptUnavailable": "⚠️ Transcript unavailable ({error}); the session is resumed, continue from here.",
  "chat.helloSpace": "Ask about the space: apps, manifests, files.",
  "chat.denied": "⛔ {tools} was refused for lack of permission",
  "chat.grantRetry": "Grant and retry",
  "chat.retryMessage": "I have granted more permissions. Please finish the step that was refused for lack of permission.",
  "chat.latest": "Latest",
  "chat.placeholder": "Message, Enter to send",
  "chat.placeholderBusy": "Keep typing; sent when the reply finishes…",

  "tasks.title": "Tasks",
  "tasks.summary": "{active} of {total} active",
  "tasks.failing": " · {n} failing",
  "tasks.empty": "No scheduled tasks. Declare some under tasks: in an app's space.yaml.",
  "tasks.noRuns": "No runs yet",
  "tasks.next": "next {time}",
  "tasks.orphaned": "orphaned",
  "tasks.off": "off",
  "tasks.running": "running",
  "tasks.error": "error",
  "tasks.errorN": "error ×{n}",
  "tasks.skipped": "skipped",
  "tasks.neverRan": "never ran",

  "time.justNow": "just now",
  "time.minAgo": "{n} min ago",
  "time.hAgo": "{n} h ago",
  "time.dAgo": "{n} d ago",
  "time.now": "now",
  "time.inLessMin": "in <1 min",
  "time.inMin": "in {n} min",
  "time.inH": "in {n} h",
  "time.inD": "in {n} d",
  "time.ms": "{n} ms",
  "time.s": "{s}s",
  "time.m": "{m}m",
  "time.ms_": "{m}m {s}s",
  "time.h": "{h}h",
  "time.hm": "{h}h {m}m",
  "time.d": "{d}d",
  "time.dh": "{d}d {h}h",
  "time.every": "every {duration}",
  "time.onceAt": "once at {date}",
};

export type Key = keyof typeof en;

const zh: Record<Key, string> = {
  "common.cancel": "取消",
  "common.save": "保存",
  "common.close": "关闭",
  "common.delete": "删除",
  "common.hide": "隐藏",
  "common.loading": "加载中…",
  "common.unavailable": "不可用：{error}",
  "common.onPeer": "位于 {peer}",
  "common.onPeerStale": "位于 {peer}，该节点无响应；显示最后已知状态",

  "status.active": "运行中",
  "status.paused": "已暂停",
  "status.archived": "已归档",
  "status.up": "正常",
  "status.down": "宕机",
  "status.ok": "成功",
  "status.builtIn": "内置",
  "status.base": "基础",
  "status.hidden": "已隐藏",

  "apps.heading": "应用",
  "apps.add": "添加",
  "apps.repo": "代码仓库 ↗",
  "apps.empty": "还没有应用。把带 space.yaml 的应用放到 apps/ 下，或长按背景从链接添加一个。",

  "agents.heading": "Agent",
  "agents.clickToChat": "点击开始对话",
  "agents.empty": "还没有 agent。",

  "widgets.heading": "小组件",
  "widget.empty": "暂无内容",
  "widget.viewAll": "查看全部 →",
  "widget.resizeHint": "拖动调整大小（列 × 行）",
  "widget.stale": "{peer} 无响应；显示最后已知状态",

  "add.title": "添加应用",
  "add.sub": "从链接添加，由 agent 解析",
  "add.link": "链接 *",
  "add.placeholder": "https://github.com/you/my-app 或 https://tool.example.com",
  "add.hint": "名称、图标和描述从链接读取，写入 apps/ 下一个只有清单的应用。",
  "add.needLink": "请输入链接（代码仓库或服务地址）",
  "add.resolving": "解析中…",

  "uninstall.action": "卸载",
  "uninstall.title": "卸载 {title}",
  "uninstall.busy": "卸载中…",
  "uninstall.stopService": "停止它的服务（端口 {port}）。",
  "uninstall.noService": "它没有需要停止的服务。",
  "uninstall.deleteLink": "删除这条链接记录。",
  "uninstall.moveDir": "它的目录移出工作区：符号链接被移除，检出的代码移到工作区回收站。不删除任何代码。",
  "uninstall.forget": "它的任务、agent 和小组件从面板消失。数据目录保留。",
  "uninstall.zoneHint": "把应用拖到这里以停止其服务并从空间移除；数据保留",

  "settings.title": "设置",
  "settings.blurb": "这个空间的偏好、定时任务、对等节点和服务。",
  "settings.hover": "悬停详情",
  "settings.pet": "桌面宠物",
  "settings.widgets": "小组件",
  "settings.dark": "深色模式",
  "settings.language": "语言",
  "settings.scheduler": "调度器",
  "settings.tasks": "定时任务",
  "settings.peers": "对等节点",
  "settings.peerCounts": "{apps} 个应用 · {agents} 个 agent · {widgets} 个小组件 · {services} 个服务",
  "settings.snapshot": "快照 {time}",
  "settings.services": "服务",
  "settings.noServices": "没有登记的服务",

  "pet.placeholder": "petdex.dev 上的宠物名",
  "pet.reset": "恢复默认宠物",
  "pet.lookingUp": "查找中…",
  "pet.notFound": "petdex.dev 上没有叫“{name}”的宠物",
  "pet.unreachable": "无法连接 petdex.dev",
  "pet.by": "{name} · 作者 {by}",
  "pet.default": "水豚（内置）",
  "pet.clickMe": "点我",

  "chat.starting": "启动中…",
  "chat.thinking": "思考中…",
  "chat.thinkingModel": "思考中…（{model}）",
  "chat.queued": "（+{n} 条排队）",
  "chat.running": "正在运行 {name}…",
  "chat.wentWrong": "出错了",
  "chat.interrupted": "⏹ 已中断",
  "chat.noOutput": "（无输出）",
  "chat.inSession": "会话中",
  "chat.newSession": "新会话",
  "chat.interrupt": "中断",
  "chat.history": "历史",
  "chat.newConversation": "新对话",
  "chat.modelTitle": "模型（下一条消息生效）",
  "chat.modelDefault": "默认模型",
  "chat.modelHaiku": "haiku · 快",
  "chat.modelSonnet": "sonnet",
  "chat.modelOpus": "opus · 强",
  "chat.modelFable": "fable · 最强",
  "chat.permTitle": "写权限（下一条消息生效）",
  "chat.permRead": "🔒 只读",
  "chat.permEdit": "✏️ 可改文件",
  "chat.permAll": "⚡ 全部权限",
  "chat.noSessions": "没有历史会话",
  "chat.untitled": "（无标题）",
  "chat.transcriptUnavailable": "⚠️ 无法读取记录（{error}）；会话已恢复，可以从这里继续。",
  "chat.helloSpace": "问问这个空间：应用、清单、文件。",
  "chat.denied": "⛔ {tools} 因权限不足被拒绝",
  "chat.grantRetry": "授权并重试",
  "chat.retryMessage": "我已授予更多权限，请完成刚才因权限不足被拒绝的步骤。",
  "chat.latest": "最新",
  "chat.placeholder": "输入消息，回车发送",
  "chat.placeholderBusy": "可以继续输入；回复结束后发送…",

  "tasks.title": "任务",
  "tasks.summary": "{total} 个任务中 {active} 个启用",
  "tasks.failing": " · {n} 个失败",
  "tasks.empty": "没有定时任务。在应用的 space.yaml 的 tasks: 下声明。",
  "tasks.noRuns": "还没有运行记录",
  "tasks.next": "下次 {time}",
  "tasks.orphaned": "已孤立",
  "tasks.off": "已关闭",
  "tasks.running": "运行中",
  "tasks.error": "失败",
  "tasks.errorN": "失败 ×{n}",
  "tasks.skipped": "已跳过",
  "tasks.neverRan": "从未运行",

  "time.justNow": "刚刚",
  "time.minAgo": "{n} 分钟前",
  "time.hAgo": "{n} 小时前",
  "time.dAgo": "{n} 天前",
  "time.now": "现在",
  "time.inLessMin": "1 分钟内",
  "time.inMin": "{n} 分钟后",
  "time.inH": "{n} 小时后",
  "time.inD": "{n} 天后",
  "time.ms": "{n} 毫秒",
  "time.s": "{s} 秒",
  "time.m": "{m} 分",
  "time.ms_": "{m} 分 {s} 秒",
  "time.h": "{h} 小时",
  "time.hm": "{h} 小时 {m} 分",
  "time.d": "{d} 天",
  "time.dh": "{d} 天 {h} 小时",
  "time.every": "每 {duration}",
  "time.onceAt": "{date} 运行一次",
};

export const MESSAGES: Record<Lang, Record<Key, string>> = { en, zh };

export type Vars = Record<string, string | number>;

/** The text for `key` in `lang`, placeholders filled from `vars`. Unknown keys render as themselves. */
export function translate(lang: Lang, key: Key, vars?: Vars): string {
  const text = MESSAGES[lang]?.[key] ?? en[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

const isLang = (s: unknown): s is Lang => LANGS.some((l) => l.code === s);
const primary = (tag: string) => tag.split("-")[0]?.toLowerCase() ?? "";

/** The first of the browser's languages the panel has a dictionary for; English otherwise. */
export function detectLang(tags: readonly string[]): Lang {
  for (const tag of tags) {
    const p = primary(tag);
    if (isLang(p)) return p;
  }
  return "en";
}

/** The saved preference, else the browser's languages. Works without localStorage. */
export function loadLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* no storage: detect on every load */
  }
  return detectLang(typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]);
}

export function saveLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* no storage: the choice lasts for this page */
  }
}

/** Translations the API sends next to a plain `title` / `description`, by language tag. */
export type I18n = Record<string, { title?: string; description?: string }>;

/**
 * Manifest text in `lang`: the `i18n` entry for that tag, else one whose primary tag matches
 * (`zh-Hant` for `zh`), else the plain field.
 */
export function localized<T extends { title: string; description?: string; i18n?: I18n }>(lang: Lang, x: T): { title: string; description?: string } {
  const i18n = x.i18n ?? {};
  const entry = i18n[lang] ?? Object.entries(i18n).find(([tag]) => primary(tag) === lang)?.[1];
  const description = entry?.description ?? x.description;
  return { title: entry?.title ?? x.title, ...(description !== undefined ? { description } : {}) };
}

/**
 * An app URL with the `{lang}` placeholder filled (app-spec.md: an app opts in to the panel's language
 * by putting it in its `url` query). `%7Blang%7D` is the same placeholder after URL normalisation.
 */
export function withLang(url: string, lang: Lang): string {
  return url.replaceAll("{lang}", lang).replaceAll("%7Blang%7D", lang);
}

export const LangContext = createContext<Lang>("en");

/** The current language and a bound `t`. Components re-render when the provider's value changes. */
export function useLang() {
  const lang = useContext(LangContext);
  return useMemo(() => ({ lang, t: (key: Key, vars?: Vars) => translate(lang, key, vars) }), [lang]);
}
