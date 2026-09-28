import { describe, expect, it } from "vitest";
import { blogCard, publishedPost } from "../src/blog";

const PATH = "src/2026/Sep/7/on-cards/index.md";
const POST = `---
title: On cards
date: 2026-09-07
announcements:
  bluesky: "  Cards beat pages.  "
  telegram: Other channel
---

First paragraph.

Second paragraph.
`;
const RECEIPT = JSON.stringify({
  status: "published",
  published_at: "2026-09-07T10:00:00.000Z",
  post: {
    uri: "at://did:plc:operator/app.bsky.feed.post/3lxyz2abcdefg",
    cid: "bafy",
    url: "https://bsky.app/profile/andysmith.ai/post/3lxyz2abcdefg",
  },
});

describe("blog Cards", () => {
  it("derives an Operator Card from a published Bluesky receipt", () => {
    const post = publishedPost(RECEIPT)!;
    expect(blogCard(PATH, POST, post, "https://andysmith.ai/")).toMatchObject({
      id: "3lxyz2abcdefg",
      author: "operator",
      source: "blog",
      short_text: "Cards beat pages.",
      short_markdown: "Cards beat pages.",
      full_text: "First paragraph.\n\nSecond paragraph.",
      url: "https://andysmith.ai/2026/Sep/7/on-cards/",
      bluesky_uri: "at://did:plc:operator/app.bsky.feed.post/3lxyz2abcdefg",
      parent_id: null,
    });
  });

  it("ignores receipts that are not published", () => {
    expect(publishedPost(JSON.stringify({ status: "failed", error: "rate limited" }))).toBeNull();
    expect(publishedPost(JSON.stringify({ status: "published", post: { uri: "at://x/app.bsky.feed.like/3lxyz2abcdefg" } }))).toBeNull();
  });

  it("ignores posts outside the blog path layout or without an announcement", () => {
    const post = publishedPost(RECEIPT)!;
    expect(blogCard("src/drafts/on-cards/index.md", POST, post, "https://andysmith.ai")).toBeNull();
    expect(blogCard(PATH, "---\ntitle: No announcement\n---\nBody\n", post, "https://andysmith.ai")).toBeNull();
  });
});
