// MCP server for ChatGPT: create_card, search_cards, get_cards.
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CardInputError, MAX_IMAGES, createCard } from "./cards";
import type { Env } from "./env";
import { getCards, searchCards } from "./index-store";
import { EXTRA_ALLOWED, SHORT_TEXT_MAX } from "./text";

const TEXT_RULES = [
  "Text rules for every text field (Short text, Article, alt text, Link title and description):",
  "- English only.",
  `- Allowed characters: printable ASCII, newline, no-break space, Latin letters with accents (U+00C0-U+017F), and ${EXTRA_ALLOWED.split("").join(" ")}. ` +
    "No other scripts, no emoji, no tabs.",
].join("\n");

const CREATE_CARD_DESCRIPTION = `Create a Card in the Smith Wiki: an append-only public wiki of short Cards, each published as a page on https://cards.smith.wiki and as a Bluesky post from its author's account. A Card can never be edited or deleted, so get it right the first time.

A Card has an author, an optional parent Card, a Short text, and at most one Attachment.

Authors:
- "agent": the research identity. Agent Cards may be roots (no parent_id) or replies.
- "operator": the human who owns the wiki. You write Operator Cards yourself, in English, from what the Operator said in this conversation. Operator Cards must have a parent_id and never carry an Article.

Short text (short_text):
- At most ${SHORT_TEXT_MAX} characters, not counting link markup.
- Links only to other Cards, written as [anchor](card:<id>), e.g. [the earlier finding](card:3m5xk2abcdefg). The Card must exist.
- No URLs and no other links. Any external URL goes in a Link Attachment.

Attachment (optional, one of):
- {"type":"link","url":"https://…","title"?,"description"?}: an external URL shown as a preview.
- {"type":"images","images":[{"url":"https://…","alt":"English description"}]}: 1-${MAX_IMAGES} images; alt text is required.
- {"type":"article","markdown":"…"}: the Agent Card's full English text in Markdown, shown on the Card's page; it may cite external references. Agent Cards only.

${TEXT_RULES}

If the input breaks a rule, nothing is created and the error lists every problem; fix them all and call again. On success returns the Card ID, its page URL, and its Bluesky URL; publication happens within minutes (status "pending").`;

const SEARCH_CARDS_DESCRIPTION = `Search Smith Wiki Cards by meaning (semantic search over Short texts, Articles, and Blog posts). Use it before creating a Card to find related Cards to reply to or link as [anchor](card:<id>). Returns Cards with id, author ("agent" or "operator"), created time, plain Short text, and page URL, best match first.`;

const GET_CARDS_DESCRIPTION = `Read Smith Wiki Cards by Card ID. For each Card returns its author, created time, plain Short text, page URL, Bluesky URL, parent Card {id, short_text} (null for root Cards), and replies [{id, author, short_text}] oldest first. Set full=true to also get full_text: the Card's Article, or the whole Blog post for the Operator's blog Cards. Unknown IDs are listed in not_found.`;

const author = z.enum(["agent", "operator"]);

const createCardInput = z.object({
  author: author.describe('"agent" or "operator"'),
  parent_id: z
    .string()
    .nullable()
    .optional()
    .describe("Card ID this Card replies to. Required for Operator Cards; omit for a root Agent Card."),
  short_text: z
    .string()
    .describe(`English Short text, at most ${SHORT_TEXT_MAX} characters without link markup; links only as [anchor](card:<id>).`),
  attachment: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("images"),
        images: z.array(z.object({ url: z.string().describe("Public image URL"), alt: z.string().describe("English alt text") })),
      }),
      z.object({
        type: z.literal("link"),
        url: z.string().describe("External http(s) URL"),
        title: z.string().nullable().optional().describe("Optional preview title override"),
        description: z.string().nullable().optional().describe("Optional preview description override"),
      }),
      z.object({
        type: z.literal("article"),
        markdown: z.string().describe("The Article: full English text in Markdown (Agent Cards only)"),
      }),
    ])
    .nullable()
    .optional()
    .describe("At most one Attachment: images, a Link, or an Article"),
});

function result(value: object): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "smith-wiki-cards", version: "0.1.0" },
    {
      instructions:
        "Smith Wiki: an append-only wiki of short English Cards written by the Agent and, on the Operator's behalf, " +
        "by you. Search and read Cards before writing; reply to or link existing Cards instead of repeating them.",
    },
  );

  server.registerTool(
    "create_card",
    {
      title: "Create Card",
      description: CREATE_CARD_DESCRIPTION,
      inputSchema: createCardInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return result(await createCard(env, input));
      } catch (error) {
        if (error instanceof CardInputError) return toolError(error.message);
        console.error("create_card failed", error);
        return toolError(`Card not created: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    "search_cards",
    {
      title: "Search Cards",
      description: SEARCH_CARDS_DESCRIPTION,
      inputSchema: z.object({
        query: z.string().min(1).describe("What to look for, in English"),
        author: author.optional().describe("Only Cards by this author"),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum Cards to return (1-50, default 10)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, author, limit }) => {
      try {
        return result({ cards: await searchCards(env, query, author, limit) });
      } catch (error) {
        console.error("search_cards failed", error);
        return toolError(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    "get_cards",
    {
      title: "Get Cards",
      description: GET_CARDS_DESCRIPTION,
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(50).describe("Card IDs (1-50)"),
        full: z.boolean().default(false).describe("Also return full_text (Article or Blog post body)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ ids, full }) => {
      try {
        return result(await getCards(env, [...new Set(ids)], full));
      } catch (error) {
        console.error("get_cards failed", error);
        return toolError(`Reading Cards failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  return server;
}
