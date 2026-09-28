export interface Env {
  DB: D1Database;
  VECTORS: Vectorize;
  AI: Ai;
  FILES: R2Bucket;
  IMAGES: ImagesBinding;

  CARDS_REPO: string;
  CARDS_BRANCH: string;
  CARD_SITE_URL: string;
  FILES_BASE_URL: string;
  BLOG_REPO: string;
  BLOG_BRANCH: string;
  BLOG_SITE_URL: string;
  /** ISO time; only blog Cards created at or after it are indexed (the wiki starts from zero). */
  BLOG_SINCE: string;
  AGENT_DID: string;
  OPERATOR_DID: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  GITHUB_TOKEN: string;
  /** Dev-only: "1" disables the Cloudflare Access check (for `wrangler dev`). */
  DEV_AUTH_BYPASS?: string;
}

export type Author = "agent" | "operator";

export function authorDid(env: Env, author: Author): string {
  const did = author === "agent" ? env.AGENT_DID : env.OPERATOR_DID;
  if (!did) throw new Error(`${author === "agent" ? "AGENT_DID" : "OPERATOR_DID"} is not configured`);
  return did;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function cardPageUrl(env: Env, id: string): string {
  return `${trimSlash(env.CARD_SITE_URL)}/${id}/`;
}

export function postUri(did: string, id: string): string {
  return `at://${did}/app.bsky.feed.post/${id}`;
}

/** https://bsky.app URL of an app.bsky.feed.post record URI. */
export function blueskyUrl(uri: string): string {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  if (!match) throw new Error(`not a Bluesky post URI: ${uri}`);
  return `https://bsky.app/profile/${match[1]}/post/${match[2]}`;
}
