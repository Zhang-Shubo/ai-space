import type { Database } from "bun:sqlite";

/**
 * Panel layout: the order of tiles and cards and the set of hidden apps.
 * Panel-owned state, kept in ai-space's own database so it follows the
 * workspace and never touches an app's repository.
 */

export type Layout = {
  order: { apps: string[]; agents: string[]; widgets: string[] };
  /** App names hidden from the panel; the apps stay registered and scheduled. */
  hidden: string[];
};

export type LayoutPatch = Partial<{ order: Partial<Layout["order"]>; hidden: string[] }>;

const EMPTY: Layout = { order: { apps: [], agents: [], widgets: [] }, hidden: [] };
const KEY = "layout";
const MAX_NAMES = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS panel_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class LayoutStore {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
  }

  read(): Layout {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM panel_kv WHERE key = ?").get(KEY);
    if (!row) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(row.value) as Partial<Layout>;
      return {
        order: {
          apps: names(parsed.order?.apps),
          agents: names(parsed.order?.agents),
          widgets: names(parsed.order?.widgets),
        },
        hidden: names(parsed.hidden),
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Merge a patch into the stored layout; lists given replace the stored ones. */
  update(patch: LayoutPatch): Layout {
    const cur = this.read();
    if (patch.order !== undefined) {
      if (typeof patch.order !== "object" || patch.order === null) throw new Error("order must be an object");
      for (const k of ["apps", "agents", "widgets"] as const) {
        const v = patch.order[k];
        if (v === undefined) continue;
        if (!Array.isArray(v)) throw new Error(`order.${k} must be a list of names`);
        cur.order[k] = names(v);
      }
    }
    if (patch.hidden !== undefined) {
      if (!Array.isArray(patch.hidden)) throw new Error("hidden must be a list of names");
      cur.hidden = names(patch.hidden);
    }
    this.db.query("INSERT INTO panel_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(cur));
    return cur;
  }

  hide(app: string, hidden: boolean): Layout {
    const cur = this.read();
    const set = new Set(cur.hidden);
    if (hidden) set.add(app);
    else set.delete(app);
    return this.update({ hidden: [...set] });
  }
}

/** Sort by a stored order; names not in it follow, alphabetically. */
export function orderBy<T>(items: T[], order: string[], nameOf: (item: T) => string): T[] {
  const pos = new Map(order.map((n, i) => [n, i]));
  return items.slice().sort((a, b) => {
    const pa = pos.get(nameOf(a)) ?? Number.MAX_SAFE_INTEGER;
    const pb = pos.get(nameOf(b)) ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || nameOf(a).localeCompare(nameOf(b));
  });
}

function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200))].slice(0, MAX_NAMES);
}
