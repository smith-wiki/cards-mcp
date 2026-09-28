import { describe, expect, it } from "vitest";
import { cardFromFiles, renderCardFiles } from "../src/card-file";
import { makeEnv } from "./fakes";

const PARENT = {
  id: "3m5xj2abcdefg",
  uri: "at://did:plc:operator/app.bsky.feed.post/3m5xj2abcdefg",
  url: "https://cards.smith.wiki/3m5xj2abcdefg/",
  text: 'The Operator asked: "why?"',
};

describe("Card files", () => {
  it("renders index.md in the contract's frontmatter layout", () => {
    const files = renderCardFiles({
      id: "3m5xk2abcdefg",
      author: "agent",
      created: "2026-09-28T14:03:22.417Z",
      parent: PARENT,
      attachment: {
        type: "images",
        images: [{ src: "https://files.smith.wiki/cards/ab12.jpg", alt: "A chart\nof growth", mime: "image/jpeg" }],
      },
      body: "Because of [the earlier finding](https://cards.smith.wiki/3m5xh2abcdefg/).",
    });
    expect(files).toEqual({
      "cards/3m5xk2abcdefg/index.md": `---
id: 3m5xk2abcdefg
author: agent
created: 2026-09-28T14:03:22.417Z
parent:
  id: 3m5xj2abcdefg
  uri: at://did:plc:operator/app.bsky.feed.post/3m5xj2abcdefg
  url: https://cards.smith.wiki/3m5xj2abcdefg/
  text: "The Operator asked: \\"why?\\""
images:
  - src: https://files.smith.wiki/cards/ab12.jpg
    alt: "A chart\\nof growth"
    mime: image/jpeg
---
Because of [the earlier finding](https://cards.smith.wiki/3m5xh2abcdefg/).
`,
    });
  });

  it("renders a Link Attachment with only the overrides given", () => {
    const files = renderCardFiles({
      id: "3m5xk2abcdefg",
      author: "operator",
      created: "2026-09-28T14:03:22.417Z",
      parent: PARENT,
      attachment: { type: "link", url: "https://example.com/paper", title: "Paper" },
      body: "Worth reading.",
    });
    expect(files["cards/3m5xk2abcdefg/index.md"]).toContain(
      '\nlink:\n  url: https://example.com/paper\n  title: "Paper"\n---\nWorth reading.\n',
    );
  });

  it("renders a root Card with an Article as index.md plus article.md", () => {
    const files = renderCardFiles({
      id: "3m5xk2abcdefg",
      author: "agent",
      created: "2026-09-28T14:03:22.417Z",
      attachment: { type: "article", markdown: "# Heading\n\nBody.\n\n" },
      body: "Summary.",
    });
    expect(files).toEqual({
      "cards/3m5xk2abcdefg/index.md":
        "---\nid: 3m5xk2abcdefg\nauthor: agent\ncreated: 2026-09-28T14:03:22.417Z\narticle: true\n---\nSummary.\n",
      "cards/3m5xk2abcdefg/article.md": "# Heading\n\nBody.\n",
    });
  });

  it("reads back what it writes into the same index row", () => {
    const { env } = makeEnv();
    const files = renderCardFiles({
      id: "3m5xk2abcdefg",
      author: "agent",
      created: "2026-09-28T14:03:22.417Z",
      parent: PARENT,
      attachment: { type: "article", markdown: "Full text." },
      body: "See [this](https://cards.smith.wiki/3m5xh2abcdefg/).",
    });
    expect(
      cardFromFiles(env, "3m5xk2abcdefg", files["cards/3m5xk2abcdefg/index.md"], files["cards/3m5xk2abcdefg/article.md"]),
    ).toEqual({
      id: "3m5xk2abcdefg",
      author: "agent",
      source: "cards",
      created: "2026-09-28T14:03:22.417Z",
      short_text: "See this.",
      short_markdown: "See [this](https://cards.smith.wiki/3m5xh2abcdefg/).",
      full_text: "Full text.",
      url: "https://cards.smith.wiki/3m5xk2abcdefg/",
      bluesky_uri: "at://did:plc:agent/app.bsky.feed.post/3m5xk2abcdefg",
      parent_id: "3m5xj2abcdefg",
      parent_text: 'The Operator asked: "why?"',
    });
  });
});
