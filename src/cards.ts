// create_card: validation, resolution, file storage, commit, and indexing.
import { renderCardFiles, type CardAttachment, type CardParent } from "./card-file";
import { authorDid, blueskyUrl, cardPageUrl, postUri, type Author, type Env } from "./env";
import { storeHtml, storeVideo, type FileSource } from "./files";
import { GitHub } from "./github";
import { storeImage } from "./images";
import { indexCard, loadCards } from "./index-store";
import { characterProblems, normalizeNewlines, parseShortText, resolveShortText, type ParsedShortText } from "./text";
import { TID_PATTERN, generateTid, tidCreated } from "./tid";

/** A file ChatGPT attaches to the call (Apps SDK `openai/fileParams`); its URL is temporary. */
export interface FileInput {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export type AttachmentInput =
  | { type: "images"; images: { url?: string | null; alt: string }[] }
  | { type: "link"; url: string; title?: string | null; description?: string | null }
  | { type: "article"; markdown: string }
  | { type: "video"; url?: string | null; alt: string }
  | { type: "html"; url?: string | null; title: string; description?: string | null };

export interface CreateCardInput {
  author: Author;
  parent_id?: string | null;
  short_text: string;
  attachment?: AttachmentInput | null;
  /** Files for the Attachment's file slots without a url, in order. */
  files?: FileInput[] | null;
}

export interface CreateCardResult {
  id: string;
  page_url: string;
  bluesky_url: string;
  status: "pending";
}

/** Input the Agent can fix; carries every problem found. */
export class CardInputError extends Error {
  constructor(readonly problems: string[]) {
    super(`Card not created. Fix these problems and call create_card again:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
}

export const MAX_IMAGES = 4;
/** `app.bsky.embed.video` alt text limit, in graphemes. */
export const VIDEO_ALT_MAX = 1000;

function httpUrl(value: string): URL | null {
  if (/\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Optional free-text field: absent when null/undefined, otherwise checked like any text. */
function optionalText(field: string, value: string | null | undefined, problems: string[]): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = normalizeNewlines(value).trim();
  if (!text) problems.push(`${field}: must not be empty when given (omit it instead)`);
  problems.push(...characterProblems(field, text));
  return text;
}

/** Required free-text field, checked like any text. */
function requiredText(field: string, value: string, missing: string, problems: string[]): string {
  const text = normalizeNewlines(value).trim();
  if (!text) problems.push(`${field}: ${missing}`);
  problems.push(...characterProblems(field, text));
  return text;
}

/** Where one Attachment file comes from, and the field its problems are reported under. */
interface SourcedFile {
  source: FileSource;
  field: string;
}

/** Attachment ready for the Card file, except files still at their sources. */
export type ValidatedAttachment =
  | Exclude<CardAttachment, { type: "images" | "video" | "html" }>
  | { type: "images"; images: { file: SourcedFile; alt: string }[] }
  | { type: "video"; file: SourcedFile; alt: string }
  | { type: "html"; file: SourcedFile; title: string; description?: string };

export interface ValidatedCard {
  author: Author;
  parentId?: string;
  shortText: ParsedShortText;
  attachment?: ValidatedAttachment;
}

/** Every rule that needs no lookup; returns all problems at once. */
export function validateCardInput(input: CreateCardInput): { card: ValidatedCard; problems: string[] } {
  const problems: string[] = [];
  const shortText = parseShortText(input.short_text);
  problems.push(...shortText.problems);

  const parentId = input.parent_id?.trim() || undefined;
  if (parentId !== undefined && !TID_PATTERN.test(parentId)) {
    problems.push(`parent_id: "${parentId}" is not a Card ID (13 characters, e.g. 3m5xk2abcdefg)`);
  }
  if (input.author === "operator" && parentId === undefined) {
    problems.push("parent_id: Operator Cards must reply to an existing Card; give parent_id");
  }

  const files = input.files ?? [];
  let filesUsed = 0;
  // A file slot (an image, the video, the HTML page) takes its url, else the next attached file.
  const fileFor = (field: string, url: string | null | undefined, kind: string): SourcedFile => {
    if (url !== null && url !== undefined) {
      if (!httpUrl(url)) problems.push(`${field}: "${url}" is not an http(s) URL`);
      return { field, source: { url, what: `${kind} ${url}` } };
    }
    const index = filesUsed++;
    const file = files[index];
    if (!file) {
      problems.push(`${field}: give a url, or attach the file in files`);
      return { field, source: { url: "", what: kind } };
    }
    const label = `files[${index}]`;
    if (!httpUrl(file.download_url)) problems.push(`${label}.download_url: not an http(s) URL`);
    return {
      field: label,
      source: { url: file.download_url, what: `${kind} file "${file.file_name ?? file.file_id}"`, mime: file.mime_type, name: file.file_name },
    };
  };

  let attachment: ValidatedAttachment | undefined;
  const raw = input.attachment ?? undefined;
  if (raw?.type === "images") {
    if (raw.images.length < 1 || raw.images.length > MAX_IMAGES) {
      problems.push(`attachment.images: give 1 to ${MAX_IMAGES} images, not ${raw.images.length}`);
    }
    const images = raw.images.map((image, index) => {
      const field = `attachment.images[${index}]`;
      const file = fileFor(`${field}.url`, image.url, "image");
      const alt = requiredText(`${field}.alt`, image.alt, "alt text is required (describe the image in English)", problems);
      return { file, alt };
    });
    attachment = { type: "images", images };
  } else if (raw?.type === "link") {
    const url = httpUrl(raw.url);
    if (!url) problems.push(`attachment.url: "${raw.url}" is not an http(s) URL`);
    const title = optionalText("attachment.title", raw.title, problems);
    const description = optionalText("attachment.description", raw.description, problems);
    attachment = {
      type: "link",
      url: url?.href ?? raw.url,
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  } else if (raw?.type === "article") {
    if (input.author === "operator") {
      problems.push("attachment: Operator Cards never carry an Article; the Operator's long texts are Blog posts");
    }
    const markdown = normalizeNewlines(raw.markdown).trim();
    if (!markdown) problems.push("attachment.markdown: the Article must not be empty");
    problems.push(...characterProblems("attachment.markdown", markdown));
    attachment = { type: "article", markdown };
  } else if (raw?.type === "video") {
    const file = fileFor("attachment.url", raw.url, "video");
    const alt = requiredText("attachment.alt", raw.alt, "alt text is required (describe the video in English)", problems);
    const graphemes = Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(alt)).length;
    if (graphemes > VIDEO_ALT_MAX) problems.push(`attachment.alt: ${graphemes} characters; Bluesky allows ${VIDEO_ALT_MAX}`);
    attachment = { type: "video", file, alt };
  } else if (raw?.type === "html") {
    const file = fileFor("attachment.url", raw.url, "HTML page");
    const title = requiredText("attachment.title", raw.title, "a title is required", problems);
    const description = optionalText("attachment.description", raw.description, problems);
    attachment = { type: "html", file, title, ...(description !== undefined ? { description } : {}) };
  }
  if (filesUsed < files.length) {
    problems.push(
      `files: ${files.length} attached, but the attachment takes ${filesUsed}; leave out the url of one image, the video, or the HTML page for each file`,
    );
  }

  return { card: { author: input.author, parentId, shortText, attachment }, problems };
}

/** Copies every file the Attachment names into R2; problems are the Agent's to fix. */
async function storeFiles(env: Env, attachment: ValidatedAttachment | undefined): Promise<CardAttachment | undefined> {
  const problem = (file: SourcedFile, error: unknown) => `${file.field}: ${error instanceof Error ? error.message : String(error)}`;
  if (attachment?.type === "video" || attachment?.type === "html") {
    const { file, ...rest } = attachment;
    try {
      return rest.type === "video"
        ? { type: "video", ...(await storeVideo(env, file.source)), alt: rest.alt }
        : { ...rest, src: await storeHtml(env, file.source) };
    } catch (error) {
      throw new CardInputError([problem(file, error)]);
    }
  }
  if (attachment?.type !== "images") return attachment;
  const results = await Promise.allSettled(attachment.images.map((image) => storeImage(env, image.file.source)));
  const problems = results.flatMap((result, index) =>
    result.status === "rejected" ? [problem(attachment.images[index].file, result.reason)] : [],
  );
  if (problems.length) throw new CardInputError(problems);
  return {
    type: "images",
    images: results.map((result, index) => {
      const stored = (result as PromiseFulfilledResult<{ src: string; mime: string }>).value;
      return { src: stored.src, alt: attachment.images[index].alt, mime: stored.mime };
    }),
  };
}

export async function createCard(env: Env, input: CreateCardInput): Promise<CreateCardResult> {
  const { card, problems } = validateCardInput(input);
  if (problems.length) throw new CardInputError(problems);

  const linkIds = card.shortText.links.map((link) => link.id);
  const known = await loadCards(env, card.parentId ? [card.parentId, ...linkIds] : linkIds);
  let parent: CardParent | undefined;
  if (card.parentId) {
    const row = known.get(card.parentId);
    if (!row) problems.push(`parent_id: no Card with ID ${card.parentId}; find it with search_cards or get_cards`);
    else parent = { id: row.id, uri: row.bluesky_uri, url: row.url, text: row.short_text };
  }
  for (const id of new Set(linkIds)) {
    if (!known.has(id)) problems.push(`short_text: link to card:${id}, but no Card has that ID`);
  }
  if (problems.length) throw new CardInputError(problems);

  const attachment = await storeFiles(env, card.attachment);
  const urls = new Map([...known.values()].map((row) => [row.id, row.url]));
  const body = resolveShortText(card.shortText, urls);

  const did = authorDid(env, card.author);
  const id = generateTid();
  const created = tidCreated(id);
  const files = renderCardFiles({ id, author: card.author, created, parent, attachment, body });
  const github = new GitHub(env.CARDS_REPO, env.CARDS_BRANCH, env.GITHUB_TOKEN);
  await github.addFiles(files, `Add ${card.author} Card ${id}`);

  const uri = postUri(did, id);
  try {
    await indexCard(env, {
      id,
      author: card.author,
      source: "cards",
      created,
      short_text: card.shortText.plain,
      short_markdown: body,
      full_text: attachment?.type === "article" ? attachment.markdown : null,
      url: cardPageUrl(env, id),
      bluesky_uri: uri,
      parent_id: parent?.id ?? null,
      parent_text: parent?.text ?? null,
    });
  } catch (error) {
    // The Card is committed; the scheduled sync indexes it later.
    console.error(`indexing Card ${id} failed`, error);
  }

  return { id, page_url: cardPageUrl(env, id), bluesky_url: blueskyUrl(uri), status: "pending" };
}
