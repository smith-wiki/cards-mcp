import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { indexCard } from "../src/index-store";
import { tidCreated } from "../src/tid";
import { FakeRepo, fakeFetch, makeEnv } from "./fakes";

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const BLOG_CARD = "3lxyz2abcdefg";
const AGENT_CARD = "3lzzz2abcdefg";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface RpcResponse {
  status: number;
  message?: { result?: Record<string, unknown>; error?: unknown };
}

async function rpc(env: Env, id: number, method: string, params: unknown, headers: Record<string, string> = {}): Promise<RpcResponse> {
  const response = await worker.fetch(
    new Request("https://cards-mcp.smith.wiki/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
    env,
    ctx,
  );
  if (!response.ok) return { status: response.status };
  const text = await response.text();
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .at(-1)!
    : text;
  return { status: response.status, message: JSON.parse(json) };
}

const INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
};

async function seedParents(env: Env): Promise<void> {
  await indexCard(env, {
    id: BLOG_CARD,
    author: "operator",
    source: "blog",
    created: "2025-09-07T10:00:00.000Z",
    short_text: "Cards beat pages.",
    short_markdown: "Cards beat pages.",
    full_text: "The whole post.",
    url: "https://andysmith.ai/2025/Sep/7/on-cards/",
    bluesky_uri: `at://did:plc:operator/app.bsky.feed.post/${BLOG_CARD}`,
    parent_id: null,
    parent_text: null,
  });
  await indexCard(env, {
    id: AGENT_CARD,
    author: "agent",
    source: "cards",
    created: "2025-10-01T00:00:00.000Z",
    short_text: "Short units get read.",
    short_markdown: "Short units get read.",
    full_text: null,
    url: `https://cards.smith.wiki/${AGENT_CARD}/`,
    bluesky_uri: `at://did:plc:agent/app.bsky.feed.post/${AGENT_CARD}`,
    parent_id: null,
    parent_text: null,
  });
}

describe("MCP over the Worker fetch handler", () => {
  it("initializes, lists the tools, and creates a Card in one commit", async () => {
    const fakes = makeEnv({ DEV_AUTH_BYPASS: "1" });
    const { env } = fakes;
    await seedParents(env);
    const repo = new FakeRepo("smith-wiki/cards", { "README.md": "cards\n" });
    repo.rejectUpdates = 1; // someone else pushed between our read and our ref update
    const bigPng = new Uint8Array(1_500_000).fill(7);
    vi.stubGlobal(
      "fetch",
      fakeFetch([repo], {
        "https://example.com/chart.png": () => new Response(bigPng, { headers: { "content-type": "image/png" } }),
      }),
    );

    const init = await rpc(env, 1, "initialize", INITIALIZE);
    expect(init.message?.result).toMatchObject({ serverInfo: { name: "smith-wiki-cards" } });

    const list = await rpc(env, 2, "tools/list", {});
    const tools = list.message?.result?.tools as { name: string; annotations: Record<string, boolean> }[];
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toMatchObject({
      create_card: { readOnlyHint: false, destructiveHint: false },
      search_cards: { readOnlyHint: true },
      get_cards: { readOnlyHint: true },
    });

    const call = await rpc(env, 3, "tools/call", {
      name: "create_card",
      arguments: {
        author: "operator",
        parent_id: BLOG_CARD,
        short_text: `Agreed, and [short units get read](card:${AGENT_CARD}).`,
        attachment: { type: "images", images: [{ url: "https://example.com/chart.png", alt: "Reading time chart" }] },
      },
    });
    const result = call.message?.result as { isError?: boolean; structuredContent: Record<string, string> };
    expect(result.isError).toBeFalsy();
    const id = result.structuredContent.id;
    expect(result.structuredContent).toEqual({
      id,
      page_url: `https://cards.smith.wiki/${id}/`,
      bluesky_url: `https://bsky.app/profile/did:plc:operator/post/${id}`,
      status: "pending",
    });

    // Shrunk through the JPEG quality ladder until at most 1,000,000 bytes, stored once by hash.
    expect(fakes.transcodes).toEqual([85, 75, 65, 55, 45]);
    const [key] = [...fakes.files.keys()];
    expect(key).toMatch(/^[0-9a-f]{64}\.jpg$/);
    expect(fakes.files.get(key)?.contentType).toBe("image/jpeg");

    expect(repo.commits).toHaveLength(1);
    expect(Object.keys(repo.commits[0].files)).toEqual([`cards/${id}/index.md`]);
    expect(repo.commits[0].files[`cards/${id}/index.md`]).toBe(`---
id: ${id}
author: operator
created: ${tidCreated(id)}
parent:
  id: ${BLOG_CARD}
  uri: at://did:plc:operator/app.bsky.feed.post/${BLOG_CARD}
  url: https://andysmith.ai/2025/Sep/7/on-cards/
  text: "Cards beat pages."
images:
  - src: https://cards-files.smith.wiki/${key}
    alt: "Reading time chart"
    mime: image/jpeg
---
Agreed, and [short units get read](https://cards.smith.wiki/${AGENT_CARD}/).
`);

    // Indexed: the new Card is a reply of its parent and findable by meaning.
    const got = await rpc(env, 4, "tools/call", { name: "get_cards", arguments: { ids: [BLOG_CARD] } });
    const cards = (got.message?.result as { structuredContent: { cards: { replies: unknown[] }[] } }).structuredContent.cards;
    expect(cards[0].replies).toEqual([{ id, author: "operator", short_text: "Agreed, and short units get read." }]);
    expect(fakes.vectors.has(`${id}#short`)).toBe(true);
  });

  it("returns every validation problem as a tool error and commits nothing", async () => {
    const { env } = makeEnv({ DEV_AUTH_BYPASS: "1" });
    await seedParents(env);
    const repo = new FakeRepo("smith-wiki/cards");
    vi.stubGlobal("fetch", fakeFetch([repo]));

    const call = await rpc(env, 1, "tools/call", {
      name: "create_card",
      arguments: {
        author: "operator",
        parent_id: "3kaaa2abcdefg",
        short_text: `See [this](card:3kbbb2abcdefg).`,
        attachment: { type: "article", markdown: "Long." },
      },
    });
    const result = call.message?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Operator Cards never carry an Article");
    // Lookup problems are reported once the static rules pass.
    expect(repo.commits).toEqual([]);

    const lookup = await rpc(env, 2, "tools/call", {
      name: "create_card",
      arguments: { author: "operator", parent_id: "3kaaa2abcdefg", short_text: "See [this](card:3kbbb2abcdefg)." },
    });
    const text = (lookup.message?.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("parent_id: no Card with ID 3kaaa2abcdefg");
    expect(text).toContain("short_text: link to card:3kbbb2abcdefg, but no Card has that ID");
    expect(repo.commits).toEqual([]);
  });
});

describe("Cloudflare Access", () => {
  it("rejects /mcp requests without a valid Access token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input) === "https://team.cloudflareaccess.com/cdn-cgi/access/certs") return Response.json({ keys: [jwk] });
      throw new TypeError(`unexpected fetch ${String(input)}`);
    });
    const sign = (audience: string, expires = "5m") =>
      new SignJWT({ email: "operator@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer("https://team.cloudflareaccess.com")
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expires)
        .sign(privateKey);
    const { env } = makeEnv();

    expect((await rpc(env, 1, "initialize", INITIALIZE)).status).toBe(401);
    const wrongAudience = await sign("other-app");
    expect((await rpc(env, 1, "initialize", INITIALIZE, { "Cf-Access-Jwt-Assertion": wrongAudience })).status).toBe(401);
    const expired = await sign("aud-tag", "-1m");
    expect((await rpc(env, 1, "initialize", INITIALIZE, { "Cf-Access-Jwt-Assertion": expired })).status).toBe(401);
    const valid = await sign("aud-tag");
    expect((await rpc(env, 1, "initialize", INITIALIZE, { "Cf-Access-Jwt-Assertion": valid })).status).toBe(200);
  });
});
