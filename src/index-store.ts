// Derived index of Cards: D1 rows plus Vectorize embeddings. Rebuildable from the
// repositories; only ever appended to.
import { blueskyUrl, cardPageUrl, type Author, type Env } from "./env";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";

export interface IndexedCard {
  id: string;
  author: Author;
  source: "cards" | "blog";
  created: string;
  short_text: string;
  short_markdown: string;
  full_text: string | null;
  url: string;
  bluesky_uri: string;
  parent_id: string | null;
  parent_text: string | null;
}

const COLUMNS = [
  "id",
  "author",
  "source",
  "created",
  "short_text",
  "short_markdown",
  "full_text",
  "url",
  "bluesky_uri",
  "parent_id",
  "parent_text",
] as const satisfies readonly (keyof IndexedCard)[];

const INSERT_SQL = `INSERT OR IGNORE INTO cards (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;
// D1 caps bound parameters per statement at 100.
const MAX_BOUND = 100;

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const result = (await env.AI.run(EMBEDDING_MODEL, { text: texts, truncate_inputs: true })) as { data?: number[][] };
  if (!result.data || result.data.length !== texts.length) throw new Error("embedding model returned no vectors");
  return result.data;
}

/**
 * Adds a Card to the index. Vectors go first and the D1 row last, so a row in D1
 * means the Card is fully indexed; the sync retries anything without a row.
 */
export async function indexCard(env: Env, card: IndexedCard): Promise<void> {
  const texts = card.full_text ? [card.short_text, card.full_text] : [card.short_text];
  const [shortVector, fullVector] = await embed(env, texts);
  // The author is the Vectorize namespace, so the author filter needs no metadata index.
  const metadata = { id: card.id, author: card.author };
  const namespace = card.author;
  const vectors: VectorizeVector[] = [{ id: `${card.id}#short`, values: shortVector, metadata, namespace }];
  if (fullVector) vectors.push({ id: `${card.id}#full`, values: fullVector, metadata, namespace });
  await env.VECTORS.insert(vectors);
  await env.DB.prepare(INSERT_SQL)
    .bind(...COLUMNS.map((column) => card[column]))
    .run();
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function loadCards(env: Env, ids: string[]): Promise<Map<string, IndexedCard>> {
  const found = new Map<string, IndexedCard>();
  for (const chunk of chunks([...new Set(ids)], MAX_BOUND)) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM cards WHERE id IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(...chunk)
      .all<IndexedCard>();
    for (const row of results) {
      // Rows are never updated and keep the host they were indexed under
      // (cards.smith.wiki before the move); a Card page lives on the current host.
      if (row.source === "cards") row.url = cardPageUrl(env, row.id);
      found.set(row.id, row);
    }
  }
  return found;
}

export async function existingIds(env: Env, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunks(ids, MAX_BOUND)) {
    const { results } = await env.DB.prepare(`SELECT id FROM cards WHERE id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of results) found.add(row.id);
  }
  return found;
}

export interface CardSummary {
  id: string;
  author: Author;
  created: string;
  short_text: string;
  url: string;
}

export async function searchCards(
  env: Env,
  query: string,
  author: Author | undefined,
  limit: number,
): Promise<CardSummary[]> {
  const [vector] = await embed(env, [query]);
  // Every vector lives in its author's namespace. Query each namespace explicitly rather
  // than relying on how Vectorize treats a query without one.
  const namespaces: Author[] = author ? [author] : ["agent", "operator"];
  const results = await Promise.all(
    namespaces.map((namespace) =>
      // Each Card has up to two vectors; over-fetch so dedupe still fills the limit.
      env.VECTORS.query(vector, { topK: Math.min(100, limit * 2), namespace }),
    ),
  );
  const best = new Map<string, number>();
  for (const match of results.flatMap((result) => result.matches)) {
    const id = match.id.split("#")[0];
    if (!best.has(id) || best.get(id)! < match.score) best.set(id, match.score);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  const rows = await loadCards(env, ranked);
  return ranked.flatMap((id) => {
    const row = rows.get(id);
    return row ? [{ id, author: row.author, created: row.created, short_text: row.short_text, url: row.url }] : [];
  });
}

export interface CardDetails extends CardSummary {
  bluesky_url: string;
  parent: { id: string; short_text: string } | null;
  replies: { id: string; author: Author; short_text: string }[];
  full_text?: string | null;
}

export async function getCards(
  env: Env,
  ids: string[],
  full: boolean,
): Promise<{ cards: CardDetails[]; not_found: string[] }> {
  const rows = await loadCards(env, ids);
  const known = ids.filter((id) => rows.has(id));
  const replies = new Map<string, CardDetails["replies"]>();
  for (const chunk of chunks(known, MAX_BOUND)) {
    const { results } = await env.DB.prepare(
      `SELECT id, author, short_text, parent_id FROM cards WHERE parent_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY id`,
    )
      .bind(...chunk)
      .all<{ id: string; author: Author; short_text: string; parent_id: string }>();
    for (const row of results) {
      const list = replies.get(row.parent_id) ?? [];
      list.push({ id: row.id, author: row.author, short_text: row.short_text });
      replies.set(row.parent_id, list);
    }
  }
  const cards = known.map((id): CardDetails => {
    const row = rows.get(id)!;
    return {
      id,
      author: row.author,
      created: row.created,
      short_text: row.short_text,
      url: row.url,
      bluesky_url: blueskyUrl(row.bluesky_uri),
      parent: row.parent_id ? { id: row.parent_id, short_text: row.parent_text ?? "" } : null,
      replies: replies.get(id) ?? [],
      ...(full ? { full_text: row.full_text } : {}),
    };
  });
  return { cards, not_found: ids.filter((id) => !rows.has(id)) };
}
