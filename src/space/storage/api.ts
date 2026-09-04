import { parseBackend, parseName } from "./spec.ts";
import type { StorageService } from "./storage.ts";

/**
 * HTTP surface for storage, shaped as a Bun.serve `routes` table and merged
 * with the scheduler's routes by the entry point.
 *
 *   GET  /api/apps/:app/storage      provisioned databases (no passwords)
 *   POST /api/apps/:app/databases    { name, backend? }  provision a database at runtime
 *
 * Mutating routes require `Authorization: Bearer <token>` when a token is configured.
 */

export type StorageApiOptions = {
  storage: StorageService;
  token?: string;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

export function createStorageRoutes(opts: StorageApiOptions): Routes {
  const { storage } = opts;
  const token = opts.token?.trim() ?? "";

  const guard =
    (h: Handler): Handler =>
    async (req) => {
      if (token && req.headers.get("authorization") !== `Bearer ${token}`) return error(401, "unauthorized");
      try {
        return await h(req);
      } catch (e) {
        return error(400, (e as Error).message ?? String(e));
      }
    };

  return {
    "/api/apps/:app/storage": {
      GET: async (req) => {
        try {
          return json({ ok: true, ...(await storage.describe(parseName(req.params.app, "app"))) });
        } catch (e) {
          return error(400, (e as Error).message);
        }
      },
    },
    "/api/apps/:app/databases": {
      POST: guard(async (req) => {
        const body = (await req.json().catch(() => ({}))) as { name?: unknown; backend?: unknown };
        const name = parseName(body.name, "name");
        const backend = body.backend === undefined ? "sqlite" : parseBackend(body.backend, "backend");
        const d = await storage.addDatabase(parseName(req.params.app, "app"), name, backend);
        return json({ ok: true, database: { name: d.name, backend: d.backend, source: d.source, env: envOf(d.name) } }, 201);
      }),
    },
  };
}

function envOf(name: string): string {
  return name === "main" ? "DATABASE_URL" : `DATABASE_URL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
