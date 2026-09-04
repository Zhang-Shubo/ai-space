import type { Database } from "bun:sqlite";
import type { PeerSnapshot } from "./client.ts";

/**
 * The last good snapshot per peer, kept in ai-space's own database so a hub
 * that restarts while a peer is down still lists that peer's apps (muted).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peer_snapshots (
  peer  TEXT PRIMARY KEY,
  json  TEXT NOT NULL,
  as_of TEXT NOT NULL
);
`;

export class PeerStore {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
  }

  get(peer: string): PeerSnapshot | undefined {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM peer_snapshots WHERE peer = ?").get(peer);
    if (!row) return undefined;
    try {
      return JSON.parse(row.json) as PeerSnapshot;
    } catch {
      return undefined;
    }
  }

  set(peer: string, snapshot: PeerSnapshot): void {
    this.db.query("INSERT INTO peer_snapshots (peer, json, as_of) VALUES (?, ?, ?) ON CONFLICT(peer) DO UPDATE SET json = excluded.json, as_of = excluded.as_of").run(peer, JSON.stringify(snapshot), snapshot.asOf);
  }

  /** Drop snapshots of peers that are no longer configured. */
  prune(keep: string[]): void {
    const names = new Set(keep);
    for (const { peer } of this.db.query<{ peer: string }, []>("SELECT peer FROM peer_snapshots").all()) {
      if (!names.has(peer)) this.db.query("DELETE FROM peer_snapshots WHERE peer = ?").run(peer);
    }
  }
}
