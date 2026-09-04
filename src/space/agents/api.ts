import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type LayoutStore, orderBy } from "../panel/layout.ts";
import type { AppRegistry } from "../panel/registry.ts";
import { type AgentView, agentView } from "../panel/view.ts";
import type { PeerHub } from "../peers/hub.ts";
import type { Manifest, ManifestAgent } from "../scheduler/manifest.ts";
import { loadAppEnv } from "../scheduler/targets.ts";
import type { Workspace } from "../workspace.ts";
import { MODEL_RE, SESSION_ID_RE, chatResponse } from "./runtime.ts";
import type { SessionStore } from "./sessions.ts";
import { readTranscript } from "./transcript.ts";

/**
 * HTTP surface for agents, shaped as a Bun.serve `routes` table.
 *
 *   GET  /api/agents                              every agent of every visible app, plus the space agent, then the peers' agents
 *   POST /api/agents/:app/:agent/chat             { message, sessionId?, model?, permissionMode? } → SSE
 *   GET  /api/agents/:app/:agent/sessions         recent sessions
 *   GET  /api/agents/:app/:agent/sessions/:sid    restored transcript
 *
 * Like the panel routes these carry no bearer token; see docs/panel.md.
 */

export type AgentsApiOptions = {
  ws: Workspace;
  registry: AppRegistry;
  layout: LayoutStore;
  sessions: SessionStore;
  /** Model when neither the request nor the manifest names one (SPACE_CHAT_MODEL). */
  defaultModel?: string;
  /** Extra runtime arguments (SPACE_CHAT_ARGS). */
  extraArgs?: string[];
  /** Provisioned variables for an app, merged into the session environment. */
  envFor?: (app: string) => Promise<Record<string, string>>;
  /** Home directory for transcripts; default: the process's. */
  home?: string;
  /** Other machines whose agents this panel lists; chat with them is forwarded by the peer routes. */
  peers?: PeerHub;
};

/** The space's own agent: the default chat identity, working in the workspace root. */
export const SPACE_APP = "space";
export const SPACE_AGENT = "assistant";

export function spaceAgentView(): AgentView {
  return { id: `${SPACE_APP}/${SPACE_AGENT}`, app: SPACE_APP, name: SPACE_AGENT, title: "Base", description: "The workspace assistant: knows the apps, reads their manifests and files, helps operate the space.", avatar: "✨", runtime: "claude" };
}

function spaceAgentPrompt(ws: Workspace): string {
  return [
    `You are the assistant of an ai-space workspace at ${ws.home}.`,
    "Apps live under apps/<name>/, each with a space.yaml manifest (spec in core/docs/app-spec.md when ai-space is deployed here). Runtime data is under data/<name>/. Answer questions about the space, inspect manifests and files, and help operate apps.",
    "Be honest: say when you cannot find or verify something instead of guessing.",
  ].join("\n");
}

type ResolvedAgent = {
  id: string;
  runtime: ManifestAgent["runtime"];
  model?: string;
  cwd: string;
  systemPrompt?: string;
  tools: string[];
  app: string;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

const MAX_MESSAGE = 20_000;
const MAX_CONTEXT = 24_000;

export function createAgentRoutes(opts: AgentsApiOptions): Routes {
  const { registry, layout, sessions } = opts;

  const wrap =
    (h: Handler): Handler =>
    async (req) => {
      try {
        return await h(req);
      } catch (e) {
        return e instanceof NotFound ? error(404, e.message) : error(400, (e as Error).message ?? String(e));
      }
    };

  const resolveAgent = async (app: string, name: string): Promise<ResolvedAgent> => {
    if (app === SPACE_APP && name === SPACE_AGENT) {
      return { id: `${SPACE_APP}/${SPACE_AGENT}`, runtime: "claude", cwd: opts.ws.home, systemPrompt: spaceAgentPrompt(opts.ws), tools: [], app: SPACE_APP };
    }
    const entry = registry.get(app);
    const a = entry?.manifest.agents.find((x) => x.name === name);
    if (!entry || !a) throw new NotFound(`unknown agent: ${app}/${name}`);
    return {
      id: `${app}/${name}`,
      runtime: a.runtime,
      ...(a.model ? { model: a.model } : {}),
      // The real path: the runtime files its transcripts under the directory it actually runs in,
      // and an app directory may be a symlink into the repository checkout.
      cwd: await realDir(resolve(entry.manifest.dir, a.cwd)),
      systemPrompt: await systemPromptFor(entry.manifest, a),
      tools: a.tools,
      app,
    };
  };

  return {
    "/api/agents": {
      GET: () => {
        const lay = layout.read();
        const hidden = new Set(lay.hidden);
        const agents: AgentView[] = [spaceAgentView()];
        for (const { manifest } of registry.list()) {
          if (hidden.has(manifest.app) || manifest.status === "archived") continue;
          for (const a of manifest.agents) agents.push(agentView(manifest, a));
        }
        agents.push(...(opts.peers?.agents(hidden) ?? []));
        return json({ ok: true, agents: orderBy(agents, lay.order.agents, (a) => a.id, (a) => (a.peer ? 1 : 0)) });
      },
    },

    "/api/agents/:app/:agent/chat": {
      POST: wrap(async (req) => {
        const agent = await resolveAgent(req.params.app ?? "", req.params.agent ?? "");
        if (agent.runtime !== "claude") return error(501, `chat with the ${agent.runtime} runtime is not supported yet`);
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return error(400, "body must be JSON");
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) return error(400, "message is required");
        if (message.length > MAX_MESSAGE) return error(400, `message is longer than ${MAX_MESSAGE} characters`);
        const sessionId = typeof body.sessionId === "string" && SESSION_ID_RE.test(body.sessionId) ? body.sessionId : undefined;
        const reqModel = typeof body.model === "string" && MODEL_RE.test(body.model) ? body.model : undefined;
        const model = reqModel ?? agent.model ?? opts.defaultModel;
        const permissionMode = typeof body.permissionMode === "string" ? body.permissionMode : undefined;
        const env: Record<string, string | undefined> = { ...process.env, ...(await loadAppEnv(agent.cwd)), ...(opts.envFor && agent.app !== SPACE_APP ? await opts.envFor(agent.app) : {}) };
        return chatResponse(
          { message, sessionId, model, permissionMode, systemPrompt: agent.systemPrompt, allowedTools: agent.tools, extraArgs: opts.extraArgs, cwd: agent.cwd, env },
          { onSession: (sid) => sessions.record(agent.id, sid, sessionId, message.slice(0, 40)) },
        );
      }),
    },

    "/api/agents/:app/:agent/sessions": {
      GET: wrap(async (req) => {
        const agent = await resolveAgent(req.params.app ?? "", req.params.agent ?? "");
        return json({ ok: true, sessions: sessions.list(agent.id) });
      }),
    },

    "/api/agents/:app/:agent/sessions/:sid": {
      GET: wrap(async (req) => {
        const agent = await resolveAgent(req.params.app ?? "", req.params.agent ?? "");
        const sid = req.params.sid ?? "";
        if (!SESSION_ID_RE.test(sid)) return error(400, "invalid session id");
        const messages = await readTranscript(agent.cwd, sid, opts.home);
        if (!messages) return error(404, "transcript not found");
        return json({ ok: true, messages });
      }),
    },
  };
}

/** The prompt file, then the app context (title, description, AGENTS.md) so the agent knows its app. */
async function systemPromptFor(m: Manifest, a: ManifestAgent): Promise<string | undefined> {
  const parts: string[] = [];
  if (a.prompt) {
    const file = Bun.file(join(m.dir, a.prompt));
    if (await file.exists()) parts.push((await file.text()).trim());
    else parts.push(`(prompt file ${a.prompt} is missing)`);
  }
  const ctx = [`You are the agent "${a.name}" of the app "${m.title ?? m.app}" in an ai-space workspace.`];
  if (m.description) ctx.push(m.description);
  ctx.push(`App directory: ${m.dir}`);
  parts.push(ctx.join(" "));
  const agentsMd = Bun.file(join(m.dir, "AGENTS.md"));
  if (await agentsMd.exists()) parts.push(`--- AGENTS.md ---\n${(await agentsMd.text()).slice(0, MAX_CONTEXT)}`);
  return parts.join("\n\n");
}

async function realDir(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

class NotFound extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
