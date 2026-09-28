// The D1 schema of the derived index. The Worker creates it itself on first use, so
// the database needs no migration step. Rows are only ever added (INSERT OR IGNORE).
import type { Env } from "./env";

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL CHECK (author IN ('agent', 'operator')),
    source TEXT NOT NULL CHECK (source IN ('cards', 'blog')),
    created TEXT NOT NULL,
    short_text TEXT NOT NULL,
    short_markdown TEXT NOT NULL,
    full_text TEXT,
    url TEXT NOT NULL,
    bluesky_uri TEXT NOT NULL,
    parent_id TEXT,
    parent_text TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS cards_parent_id ON cards (parent_id, id)`,
  `CREATE TRIGGER IF NOT EXISTS cards_append_only_update BEFORE UPDATE ON cards
   BEGIN SELECT RAISE(ABORT, 'cards is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS cards_append_only_delete BEFORE DELETE ON cards
   BEGIN SELECT RAISE(ABORT, 'cards is append-only'); END`,
  // Blog receipt blobs (git blob SHA of `bluesky.json`) the sync has already read, so each
  // run fetches only new receipts. card_id is null for receipts that yield no blog Card.
  `CREATE TABLE IF NOT EXISTS blog_receipts (
    blob_sha TEXT PRIMARY KEY,
    card_id TEXT
  )`,
];

const ready = new WeakMap<D1Database, Promise<void>>();

/** Creates the schema once per database binding; a failed attempt is retried on the next call. */
export function ensureSchema(env: Env): Promise<void> {
  let pending = ready.get(env.DB);
  if (!pending) {
    pending = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).then(() => undefined);
    pending.catch(() => ready.delete(env.DB));
    ready.set(env.DB, pending);
  }
  return pending;
}
