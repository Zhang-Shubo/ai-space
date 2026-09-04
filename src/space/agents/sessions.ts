import type { Database } from "bun:sqlite";

/**
 * Recent chat sessions per agent, so the panel can list and resume them.
 * Each turn of a resumed session gets a new session id from the runtime; the
 * previous id is replaced in place so a conversation stays one row.
 */

export type ChatSession = { sid: string; title: string; ts: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  agent TEXT NOT NULL,
  sid   TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  ts    INTEGER NOT NULL,
  PRIMARY KEY (agent, sid)
);
CREATE INDEX IF NOT EXISTS chat_sessions_agent_ts ON chat_sessions(agent, ts DESC);
`;

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly keep = 10,
  ) {
    db.exec(SCHEMA);
  }

  list(agent: string): ChatSession[] {
    return this.db.query<ChatSession, [string, number]>("SELECT sid, title, ts FROM chat_sessions WHERE agent = ? ORDER BY ts DESC LIMIT ?").all(agent, this.keep);
  }

  /** Record `sid` for `agent`; when `prevSid` is known, that row is renamed instead of adding one. */
  record(agent: string, sid: string, prevSid: string | undefined, title: string): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const prev = prevSid ? this.db.query<{ title: string }, [string, string]>("SELECT title FROM chat_sessions WHERE agent = ? AND sid = ?").get(agent, prevSid) : null;
      if (prev && prevSid && prevSid !== sid) this.db.query("DELETE FROM chat_sessions WHERE agent = ? AND sid = ?").run(agent, prevSid);
      this.db
        .query("INSERT INTO chat_sessions (agent, sid, title, ts) VALUES (?, ?, ?, ?) ON CONFLICT(agent, sid) DO UPDATE SET ts = excluded.ts")
        .run(agent, sid, prev?.title || title.slice(0, 80), now);
      this.db.query("DELETE FROM chat_sessions WHERE agent = ? AND sid NOT IN (SELECT sid FROM chat_sessions WHERE agent = ? ORDER BY ts DESC LIMIT ?)").run(agent, agent, this.keep);
    });
    tx();
  }
}
