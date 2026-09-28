import YAML from "yaml";
import { authorDid, cardPageUrl, postUri, type Author, type Env } from "./env";
import type { IndexedCard } from "./index-store";
import { plainFromMarkdown } from "./text";

export interface CardParent {
  id: string;
  uri: string;
  url: string;
  text: string;
}

export type CardAttachment =
  | { type: "link"; url: string; title?: string; description?: string }
  | { type: "images"; images: { src: string; alt: string; mime: string }[] }
  | { type: "article"; markdown: string };

export interface CardFile {
  id: string;
  author: Author;
  created: string;
  parent?: CardParent;
  attachment?: CardAttachment;
  /** Short text with links resolved to page URLs. */
  body: string;
}

// Free text is written as a YAML double-quoted scalar; JSON string syntax is a subset of it.
const quoted = JSON.stringify;

/** `cards/<id>/index.md`, plus `cards/<id>/article.md` when the Card has an Article. */
export function renderCardFiles(card: CardFile): Record<string, string> {
  const lines = ["---", `id: ${card.id}`, `author: ${card.author}`, `created: ${card.created}`];
  if (card.parent) {
    lines.push(
      "parent:",
      `  id: ${card.parent.id}`,
      `  uri: ${card.parent.uri}`,
      `  url: ${card.parent.url}`,
      `  text: ${quoted(card.parent.text)}`,
    );
  }
  const attachment = card.attachment;
  if (attachment?.type === "link") {
    lines.push("link:", `  url: ${attachment.url}`);
    if (attachment.title !== undefined) lines.push(`  title: ${quoted(attachment.title)}`);
    if (attachment.description !== undefined) lines.push(`  description: ${quoted(attachment.description)}`);
  } else if (attachment?.type === "images") {
    lines.push("images:");
    for (const image of attachment.images) {
      lines.push(`  - src: ${image.src}`, `    alt: ${quoted(image.alt)}`, `    mime: ${image.mime}`);
    }
  } else if (attachment?.type === "article") {
    lines.push("article: true");
  }
  lines.push("---", card.body, "");

  const dir = `cards/${card.id}`;
  const files: Record<string, string> = { [`${dir}/index.md`]: lines.join("\n") };
  if (attachment?.type === "article") files[`${dir}/article.md`] = `${attachment.markdown.trim()}\n`;
  return files;
}

export function parseFrontmatter(source: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source.replace(/\r\n?/g, "\n"));
  if (!match) throw new Error("missing YAML frontmatter");
  const data: unknown = YAML.parse(match[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter must be a mapping");
  return { data: data as Record<string, unknown>, body: match[2].trim() };
}

/** Index row of a Card read back from the cards repo. */
export function cardFromFiles(env: Env, id: string, indexMd: string, articleMd: string | undefined): IndexedCard {
  const { data, body } = parseFrontmatter(indexMd);
  if (data.id !== id) throw new Error(`cards/${id}/index.md: id is ${String(data.id)}`);
  const author = data.author;
  if (author !== "agent" && author !== "operator") throw new Error(`cards/${id}/index.md: invalid author`);
  const created = data.created instanceof Date ? data.created.toISOString() : String(data.created);
  const parent = data.parent as Partial<CardParent> | undefined;
  return {
    id,
    author,
    source: "cards",
    created,
    short_text: plainFromMarkdown(body),
    short_markdown: body,
    full_text: data.article === true && articleMd !== undefined ? articleMd.trim() : null,
    url: cardPageUrl(env, id),
    bluesky_uri: postUri(authorDid(env, author), id),
    parent_id: typeof parent?.id === "string" ? parent.id : null,
    parent_text: typeof parent?.text === "string" ? parent.text : null,
  };
}
