// Blog Cards: Blog posts the blog's CI announced on the Operator's Bluesky account.
import { parseFrontmatter } from "./card-file";
import { trimSlash } from "./env";
import type { IndexedCard } from "./index-store";
import { TID_PATTERN, tidCreated } from "./tid";

export const BLOG_POST_PATH = /^src\/(\d{4})\/([A-Z][a-z]{2})\/(\d{1,2})\/([^/]+)\/index\.md$/;

export function blogPostUrl(path: string, siteUrl: string): string | null {
  const match = BLOG_POST_PATH.exec(path);
  return match ? `${trimSlash(siteUrl)}/${match[1]}/${match[2]}/${match[3]}/${match[4]}/` : null;
}

export interface PublishedPost {
  /** Card ID: the rkey of the announcement post. */
  id: string;
  uri: string;
}

/** The announcement recorded in a blog `bluesky.json` receipt; null unless published. */
export function publishedPost(receiptJson: string): PublishedPost | null {
  const receipt = JSON.parse(receiptJson) as { status?: unknown; post?: { uri?: unknown } };
  if (receipt.status !== "published" || typeof receipt.post?.uri !== "string") return null;
  const match = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([^/]+)$/.exec(receipt.post.uri);
  return match && TID_PATTERN.test(match[1]) ? { id: match[1], uri: receipt.post.uri } : null;
}

/** Index row of a blog Card; null when the post has no Bluesky announcement text. */
export function blogCard(postPath: string, indexMd: string, post: PublishedPost, siteUrl: string): IndexedCard | null {
  const url = blogPostUrl(postPath, siteUrl);
  if (!url) return null;
  const { data, body } = parseFrontmatter(indexMd);
  const announcements = data.announcements as { bluesky?: unknown } | undefined;
  const shortText = typeof announcements?.bluesky === "string" ? announcements.bluesky.trim() : "";
  if (!shortText) return null;
  return {
    id: post.id,
    author: "operator",
    source: "blog",
    created: tidCreated(post.id),
    short_text: shortText,
    short_markdown: shortText,
    full_text: body || null,
    url,
    bluesky_uri: post.uri,
    parent_id: null,
    parent_text: null,
  };
}
