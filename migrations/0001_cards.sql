-- Derived index of every Card: cards-repo Cards and blog Cards.
-- Rebuildable from the repositories; rows are only ever added (INSERT OR IGNORE).
CREATE TABLE cards (
  id TEXT PRIMARY KEY,                 -- Card ID (TID)
  author TEXT NOT NULL CHECK (author IN ('agent', 'operator')),
  source TEXT NOT NULL CHECK (source IN ('cards', 'blog')),
  created TEXT NOT NULL,               -- ISO 8601, UTC
  short_text TEXT NOT NULL,            -- plain: links replaced by their anchors
  short_markdown TEXT NOT NULL,        -- as written in the Card file (links as page URLs)
  full_text TEXT,                      -- Article or Blog post body
  url TEXT NOT NULL,                   -- Card page, or Blog post URL for blog Cards
  bluesky_uri TEXT NOT NULL,           -- at://<author DID>/app.bsky.feed.post/<id>
  parent_id TEXT,
  parent_text TEXT                     -- parent's plain Short text
);

CREATE INDEX cards_parent_id ON cards (parent_id, id);

CREATE TRIGGER cards_append_only_update BEFORE UPDATE ON cards
BEGIN
  SELECT RAISE(ABORT, 'cards is append-only');
END;

CREATE TRIGGER cards_append_only_delete BEFORE DELETE ON cards
BEGIN
  SELECT RAISE(ABORT, 'cards is append-only');
END;

-- Blog receipt blobs (git blob SHA of `bluesky.json`) the sync has already read, so
-- each run fetches only new receipts. card_id is null for receipts that are not published.
CREATE TABLE blog_receipts (
  blob_sha TEXT PRIMARY KEY,
  card_id TEXT
);
