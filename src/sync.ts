// Scheduled sync: indexes Cards that reached the repositories without passing through
// create_card (or whose indexing failed after the commit). Idempotent.
import { BLOG_POST_PATH, blogCard, publishedPost } from "./blog";
import { cardFromFiles } from "./card-file";
import type { Env } from "./env";
import { GitHub, type TreeEntry } from "./github";
import { existingIds, indexCard } from "./index-store";

const CARD_INDEX_PATH = /^cards\/([234567a-z]{13})\/index\.md$/;
/** Cards indexed per run; the rest follow on the next run (subrequest budget). */
const MAX_PER_RUN = 40;

export interface SyncReport {
  cards: number;
  blog: number;
  failures: string[];
}

async function syncCardsRepo(env: Env, report: SyncReport): Promise<void> {
  const github = new GitHub(env.CARDS_REPO, env.CARDS_BRANCH, env.GITHUB_TOKEN);
  const tree = await github.tree();
  const blobs = new Map(tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha]));
  const ids = tree.flatMap((entry) => CARD_INDEX_PATH.exec(entry.path)?.[1] ?? []);
  const indexed = await existingIds(env, ids);
  const missing = ids.filter((id) => !indexed.has(id)).sort().slice(0, MAX_PER_RUN);
  for (const id of missing) {
    try {
      const indexMd = await github.blobText(blobs.get(`cards/${id}/index.md`)!);
      const articleSha = blobs.get(`cards/${id}/article.md`);
      const articleMd = articleSha ? await github.blobText(articleSha) : undefined;
      await indexCard(env, cardFromFiles(env, id, indexMd, articleMd));
      report.cards++;
    } catch (error) {
      report.failures.push(`cards/${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function syncBlogRepo(env: Env, report: SyncReport): Promise<void> {
  const github = new GitHub(env.BLOG_REPO, env.BLOG_BRANCH, env.GITHUB_TOKEN);
  const tree = await github.tree();
  const blobs = new Map(tree.filter((entry) => entry.type === "blob").map((entry) => [entry.path, entry.sha]));
  const posts = tree.flatMap((entry: TreeEntry) => {
    if (!BLOG_POST_PATH.test(entry.path)) return [];
    const receiptSha = blobs.get(entry.path.replace(/index\.md$/, "bluesky.json"));
    return receiptSha ? [{ path: entry.path, sha: entry.sha, receiptSha }] : [];
  });

  const seen = new Set<string>();
  const shas = posts.map((post) => post.receiptSha);
  for (let i = 0; i < shas.length; i += 100) {
    const chunk = shas.slice(i, i + 100);
    const { results } = await env.DB.prepare(
      `SELECT blob_sha FROM blog_receipts WHERE blob_sha IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(...chunk)
      .all<{ blob_sha: string }>();
    for (const row of results) seen.add(row.blob_sha);
  }

  for (const post of posts.filter((candidate) => !seen.has(candidate.receiptSha)).slice(0, MAX_PER_RUN)) {
    try {
      const published = publishedPost(await github.blobText(post.receiptSha));
      let cardId: string | null = null;
      if (published) {
        const card = blogCard(post.path, await github.blobText(post.sha), published, env.BLOG_SITE_URL);
        if (card) {
          if (!(await existingIds(env, [card.id])).has(card.id)) {
            await indexCard(env, card);
            report.blog++;
          }
          cardId = card.id;
        }
      }
      await env.DB.prepare("INSERT OR IGNORE INTO blog_receipts (blob_sha, card_id) VALUES (?, ?)")
        .bind(post.receiptSha, cardId)
        .run();
    } catch (error) {
      report.failures.push(`${post.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export async function sync(env: Env): Promise<SyncReport> {
  const report: SyncReport = { cards: 0, blog: 0, failures: [] };
  for (const [name, run] of [
    ["cards repo", syncCardsRepo],
    ["blog repo", syncBlogRepo],
  ] as const) {
    try {
      await run(env, report);
    } catch (error) {
      report.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
