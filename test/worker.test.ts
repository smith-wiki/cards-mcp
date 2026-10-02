import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { indexCard } from "../src/index-store";
import { tidCreated } from "../src/tid";
import { FakeFixedLengthStream, FakeRepo, fakeFetch, makeEnv } from "./fakes";

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
    // Indexed before the site moved; new Cards must still link to the current host.
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
      page_url: `https://andy.smith.wiki/${id}/`,
      bluesky_url: `https://bsky.app/profile/did:plc:operator/post/${id}`,
      status: "pending",
    });

    // Shrunk through the JPEG quality ladder until at most 1,000,000 bytes, stored once by hash.
    expect(fakes.transcodes).toEqual([85, 75, 65, 55, 45]);
    const [key] = [...fakes.files.keys()];
    expect(key).toMatch(/^cards\/[0-9a-f]{64}\.jpg$/);
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
  - src: https://files.smith.wiki/${key}
    alt: "Reading time chart"
    mime: image/jpeg
---
Agreed, and [short units get read](https://andy.smith.wiki/${AGENT_CARD}/).
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

  it("copies a video and an HTML page into R2 and links the Card files there, never to the source", async () => {
    const fakes = makeEnv({ DEV_AUTH_BYPASS: "1" });
    const { env } = fakes;
    await seedParents(env);
    const repo = new FakeRepo("smith-wiki/cards");
    const video = new Uint8Array(4096).fill(3);
    const page = new TextEncoder().encode("<!doctype html><title>Demo</title><p>Hi</p>");
    vi.stubGlobal("FixedLengthStream", FakeFixedLengthStream);
    vi.stubGlobal(
      "fetch",
      fakeFetch([repo], {
        // Temporary signed URLs often answer with a generic type; the extension decides.
        "https://tmp.example.com/clip.mp4?sig=1": () =>
          new Response(video, { headers: { "content-type": "application/octet-stream", "content-length": String(video.byteLength) } }),
        "https://tmp.example.com/demo.html?sig=2": () => new Response(page, { headers: { "content-type": "text/plain; charset=utf-8" } }),
      }),
    );

    const create = async (id: number, attachment: unknown) => {
      const call = await rpc(env, id, "tools/call", {
        name: "create_card",
        arguments: { author: "agent", short_text: "A demo.", attachment },
      });
      const result = call.message?.result as { isError?: boolean; content: { text: string }[]; structuredContent: { id: string } };
      expect(result.isError, result.content[0].text).toBeFalsy();
      return result.structuredContent.id;
    };
    const videoCard = await create(1, { type: "video", url: "https://tmp.example.com/clip.mp4?sig=1", alt: "A short demo" });
    const htmlCard = await create(2, { type: "html", url: "https://tmp.example.com/demo.html?sig=2", title: "Demo page" });

    const videoKey = [...fakes.files.keys()].find((key) => key.endsWith(".mp4"))!;
    expect(videoKey).toMatch(/^cards\/[0-9a-f-]{36}\.mp4$/);
    expect(fakes.files.get(videoKey)).toEqual({ bytes: video, contentType: "video/mp4" });
    const htmlKey = [...fakes.files.keys()].find((key) => key.endsWith(".html"))!;
    expect(htmlKey).toMatch(/^cards\/[0-9a-f]{64}\.html$/);
    expect(fakes.files.get(htmlKey)).toEqual({ bytes: page, contentType: "text/html; charset=utf-8" });

    const files = Object.assign({}, ...repo.commits.map((commit) => commit.files)) as Record<string, string>;
    expect(files[`cards/${videoCard}/index.md`]).toContain(
      `video:\n  src: https://files.smith.wiki/${videoKey}\n  mime: video/mp4\n  alt: "A short demo"\n---`,
    );
    expect(files[`cards/${htmlCard}/index.md`]).toContain(`html:\n  src: https://files.smith.wiki/${htmlKey}\n  title: "Demo page"\n---`);
  });

  it("refuses files it cannot publish and commits nothing", async () => {
    const { env } = makeEnv({ DEV_AUTH_BYPASS: "1" });
    await seedParents(env);
    const repo = new FakeRepo("smith-wiki/cards");
    vi.stubGlobal("FixedLengthStream", FakeFixedLengthStream);
    vi.stubGlobal(
      "fetch",
      fakeFetch([repo], {
        "https://example.com/logo.svg": () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
        "https://example.com/big.mp4": () =>
          new Response("x", { headers: { "content-type": "video/mp4", "content-length": "100000001" } }),
      }),
    );
    const problem = async (id: number, attachment: unknown) => {
      const call = await rpc(env, id, "tools/call", { name: "create_card", arguments: { author: "agent", short_text: "Look.", attachment } });
      const result = call.message?.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      return result.content[0].text;
    };

    expect(await problem(1, { type: "images", images: [{ url: "https://example.com/logo.svg", alt: "Logo" }] })).toContain(
      "attachment.images[0].url: image https://example.com/logo.svg is an SVG",
    );
    expect(await problem(2, { type: "video", url: "https://example.com/big.mp4", alt: "Clip" })).toContain(
      "is 100000001 bytes; the limit is 100000000",
    );
    expect(repo.commits).toEqual([]);
  });

  it("declares files as an Apps SDK file param and fills url-less file slots from it in order", async () => {
    const fakes = makeEnv({ DEV_AUTH_BYPASS: "1" });
    const { env } = fakes;
    await seedParents(env);
    const repo = new FakeRepo("smith-wiki/cards");
    const png = new Uint8Array(2048).fill(5);
    const video = new Uint8Array(3000).fill(9);
    vi.stubGlobal(
      "fetch",
      fakeFetch([repo], {
        // ChatGPT download URLs carry no extension and a generic type; the file's mime_type decides.
        "https://files.oaiusercontent.com/a?sig=1": () => new Response(png, { headers: { "content-type": "application/octet-stream" } }),
        "https://example.com/b.png": () => new Response(png, { headers: { "content-type": "image/png" } }),
        // No Content-Length: the video goes up to R2 in parts.
        "https://files.oaiusercontent.com/v?sig=2": () => new Response(new Blob([video]).stream()),
      }),
    );

    const list = await rpc(env, 1, "tools/list", {});
    const tools = list.message?.result?.tools as { name: string; inputSchema: { properties: Record<string, any> }; _meta?: unknown }[];
    const createCard = tools.find((tool) => tool.name === "create_card")!;
    expect(createCard._meta).toEqual({ "openai/fileParams": ["files"] });
    // ChatGPT's tool scan rejects a file object schema that differs from this.
    expect(createCard.inputSchema.properties.files.items).toMatchObject({
      type: "object",
      properties: { download_url: { type: "string" }, file_id: { type: "string" }, mime_type: { type: "string" }, file_name: { type: "string" } },
      required: ["download_url", "file_id"],
      additionalProperties: false,
    });

    const create = async (id: number, args: Record<string, unknown>) => {
      const call = await rpc(env, id, "tools/call", { name: "create_card", arguments: { author: "agent", short_text: "Look.", ...args } });
      return call.message?.result as { isError?: boolean; content: { text: string }[]; structuredContent: { id: string } };
    };
    const images = await create(2, {
      attachment: { type: "images", images: [{ alt: "From ChatGPT" }, { url: "https://example.com/b.png", alt: "From a URL" }] },
      files: [{ download_url: "https://files.oaiusercontent.com/a?sig=1", file_id: "file_a", mime_type: "image/png" }],
    });
    expect(images.isError, images.content[0].text).toBeFalsy();
    const clip = await create(3, {
      attachment: { type: "video", alt: "A clip" },
      files: [{ download_url: "https://files.oaiusercontent.com/v?sig=2", file_id: "file_v", file_name: "clip.mp4" }],
    });
    expect(clip.isError, clip.content[0].text).toBeFalsy();

    const pngKey = [...fakes.files.keys()].find((key) => key.endsWith(".png"))!;
    const videoKey = [...fakes.files.keys()].find((key) => key.endsWith(".mp4"))!;
    expect(fakes.files.get(videoKey)).toEqual({ bytes: video, contentType: "video/mp4" });
    const files = Object.assign({}, ...repo.commits.map((commit) => commit.files)) as Record<string, string>;
    // Both images have the same bytes, so both name the one stored copy.
    expect(files[`cards/${images.structuredContent.id}/index.md`]).toContain(
      `images:\n  - src: https://files.smith.wiki/${pngKey}\n    alt: "From ChatGPT"\n    mime: image/png\n  - src: https://files.smith.wiki/${pngKey}\n    alt: "From a URL"`,
    );
    expect(files[`cards/${clip.structuredContent.id}/index.md`]).toContain(`src: https://files.smith.wiki/${videoKey}`);
    expect(Object.values(files).join("\n")).not.toContain("oaiusercontent");

    const unused = await create(4, {
      attachment: { type: "images", images: [{ url: "https://example.com/b.png", alt: "A" }] },
      files: [{ download_url: "https://files.oaiusercontent.com/a?sig=1", file_id: "file_a" }],
    });
    expect(unused.isError).toBe(true);
    expect(unused.content[0].text).toContain("files: 1 attached, but the attachment takes 0");
    const missing = await create(5, { attachment: { type: "video", alt: "A clip" } });
    expect(missing.content[0].text).toContain("attachment.url: give a url, or attach the file in files");
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
