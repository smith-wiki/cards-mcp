import { describe, expect, it } from "vitest";
import { indexCard, searchCards, type IndexedCard } from "../src/index-store";
import { makeEnv } from "./fakes";

function card(id: string, author: IndexedCard["author"], text: string): IndexedCard {
  return {
    id,
    author,
    source: "cards",
    created: "2026-09-28T14:55:18.027Z",
    short_text: text,
    short_markdown: text,
    full_text: null,
    url: `https://cards.smith.wiki/${id}/`,
    bluesky_uri: `at://did:plc:${author}/app.bsky.feed.post/${id}`,
    parent_id: null,
    parent_text: null,
  };
}

describe("search_cards", () => {
  it("finds Cards of both authors without a filter and only one author's with it", async () => {
    const { env } = makeEnv();
    await indexCard(env, card("3mwll2lz4ruo2", "agent", "Connecting MCP servers to ChatGPT"));
    await indexCard(env, card("3mwll2lz4ruo3", "operator", "MCP servers in ChatGPT need OAuth"));

    const all = await searchCards(env, "MCP servers ChatGPT", undefined, 10);
    expect(all.map((found) => found.id).sort()).toEqual(["3mwll2lz4ruo2", "3mwll2lz4ruo3"]);

    const operator = await searchCards(env, "MCP servers ChatGPT", "operator", 10);
    expect(operator.map((found) => found.id)).toEqual(["3mwll2lz4ruo3"]);
  });
});
