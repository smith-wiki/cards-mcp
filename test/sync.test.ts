import { afterEach, describe, expect, it, vi } from "vitest";
import { renderCardFiles } from "../src/card-file";
import { getCards } from "../src/index-store";
import { sync } from "../src/sync";
import { tidCreated } from "../src/tid";
import { FakeRepo, fakeFetch, makeEnv } from "./fakes";

afterEach(() => {
  vi.unstubAllGlobals();
});

const BLOG_ID = "3lxyz2abcdefg";
const CARD_ID = "3m5xk2abcdefg";

describe("scheduled sync", () => {
  it("indexes Cards and published blog posts missing from the index, once", async () => {
    const { env, vectors } = makeEnv();
    const cards = new FakeRepo(
      "smith-wiki/cards",
      renderCardFiles({
        id: CARD_ID,
        author: "agent",
        created: "2026-09-28T14:03:22.417Z",
        parent: {
          id: BLOG_ID,
          uri: `at://did:plc:operator/app.bsky.feed.post/${BLOG_ID}`,
          url: "https://andysmith.ai/2026/Sep/7/on-cards/",
          text: "Cards beat pages.",
        },
        attachment: { type: "article", markdown: "Why cards work." },
        body: "Because they are short.",
      }),
    );
    const blog = new FakeRepo("andysmith-ai/andysmith.ai", {
      "src/2026/Sep/7/on-cards/index.md": "---\ntitle: On cards\nannouncements:\n  bluesky: Cards beat pages.\n---\nThe post.\n",
      "src/2026/Sep/7/on-cards/bluesky.json": JSON.stringify({
        status: "published",
        post: { uri: `at://did:plc:operator/app.bsky.feed.post/${BLOG_ID}`, cid: "c", url: "u" },
      }),
      "src/2026/Sep/8/draft/index.md": "---\ntitle: Draft\nannouncements:\n  bluesky: Not yet.\n---\nDraft.\n",
      "src/2026/Sep/8/draft/bluesky.json": JSON.stringify({ status: "failed" }),
    });
    const fetch = vi.fn(fakeFetch([cards, blog]));
    vi.stubGlobal("fetch", fetch);

    expect(await sync(env)).toEqual({ cards: 1, blog: 1, failures: [] });
    const { cards: indexed } = await getCards(env, [BLOG_ID, CARD_ID], true);
    expect(indexed).toMatchObject([
      {
        id: BLOG_ID,
        author: "operator",
        url: "https://andysmith.ai/2026/Sep/7/on-cards/",
        full_text: "The post.",
        replies: [{ id: CARD_ID, author: "agent", short_text: "Because they are short." }],
      },
      { id: CARD_ID, parent: { id: BLOG_ID, short_text: "Cards beat pages." }, full_text: "Why cards work." },
    ]);
    expect([...vectors.keys()].sort()).toEqual([`${BLOG_ID}#full`, `${BLOG_ID}#short`, `${CARD_ID}#full`, `${CARD_ID}#short`]);

    fetch.mockClear();
    expect(await sync(env)).toEqual({ cards: 0, blog: 0, failures: [] });
    // Second run lists both trees and reads no blobs: receipts already seen are skipped by SHA.
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/repos/smith-wiki/cards/git/trees/main",
      "/repos/andysmith-ai/andysmith.ai/git/trees/main",
    ]);
  });

  it("ignores blog posts announced before BLOG_SINCE", async () => {
    const since = new Date(Date.parse(tidCreated(BLOG_ID)) + 1).toISOString();
    const { env, vectors } = makeEnv({ BLOG_SINCE: since });
    const blog = new FakeRepo("andysmith-ai/andysmith.ai", {
      "src/2026/Sep/7/on-cards/index.md": "---\ntitle: On cards\nannouncements:\n  bluesky: Cards beat pages.\n---\nThe post.\n",
      "src/2026/Sep/7/on-cards/bluesky.json": JSON.stringify({
        status: "published",
        post: { uri: `at://did:plc:operator/app.bsky.feed.post/${BLOG_ID}`, cid: "c", url: "u" },
      }),
    });
    vi.stubGlobal("fetch", fakeFetch([new FakeRepo("smith-wiki/cards", {}), blog]));

    expect(await sync(env)).toEqual({ cards: 0, blog: 0, failures: [] });
    expect(vectors.size).toBe(0);
  });
});
