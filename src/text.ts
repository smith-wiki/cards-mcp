import { TID_PATTERN } from "./tid";

export const SHORT_TEXT_MAX = 300;

/** Typographic characters allowed beyond ASCII and Latin-1/Latin Extended-A. */
export const EXTRA_ALLOWED = "‘’“”–—…•·×÷±≤≥≠≈→←↔°";
const EXTRA_CODE_POINTS = new Set(Array.from(EXTRA_ALLOWED, (char) => char.codePointAt(0)!));
const MAX_REPORTED_PER_FIELD = 20;

function isAllowed(cp: number): boolean {
  return (
    (cp >= 0x20 && cp <= 0x7e) ||
    cp === 0x0a ||
    cp === 0xa0 ||
    (cp >= 0xc0 && cp <= 0x17f) ||
    EXTRA_CODE_POINTS.has(cp)
  );
}

/**
 * One problem per character outside the allowed set, naming the character,
 * its code point, and its 1-based position (in code points) within the field.
 */
export function characterProblems(field: string, value: string): string[] {
  const problems: string[] = [];
  let position = 0;
  let rejected = 0;
  for (const char of value) {
    position++;
    const cp = char.codePointAt(0)!;
    if (isAllowed(cp)) continue;
    rejected++;
    if (rejected > MAX_REPORTED_PER_FIELD) continue;
    const code = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    const shown = cp < 0x20 || cp === 0x7f ? JSON.stringify(char) : `"${char}"`;
    problems.push(`${field}: character ${shown} (${code}) at position ${position} is not allowed`);
  }
  if (rejected > MAX_REPORTED_PER_FIELD) {
    problems.push(`${field}: ${rejected - MAX_REPORTED_PER_FIELD} more characters are not allowed`);
  }
  return problems;
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export interface CardLink {
  /** Offset of the `[` in the Short text. */
  start: number;
  /** Offset just past the `)`. */
  end: number;
  anchor: string;
  id: string;
}

export interface ParsedShortText {
  /** Trimmed Short text with `[anchor](card:<id>)` links. */
  text: string;
  /** Links replaced by their anchors. */
  plain: string;
  links: CardLink[];
  problems: string[];
}

const LINK = /\[([^[\]\n]*)\]\(([^()\s]*)\)/g;
const BARE_URL = /[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.[a-z0-9-]\S*|\bmailto:\S+/i;

export function parseShortText(input: string): ParsedShortText {
  const text = normalizeNewlines(input).trim();
  const problems = characterProblems("short_text", text);
  const links: CardLink[] = [];
  let plain = "";
  let cursor = 0;

  for (const match of text.matchAll(LINK)) {
    const [whole, anchor, target] = match;
    const start = match.index;
    plain += text.slice(cursor, start) + anchor;
    cursor = start + whole.length;

    if (!anchor.trim() || anchor !== anchor.trim()) {
      problems.push(`short_text: link ${whole} needs a non-empty anchor without leading or trailing spaces`);
    }
    const id = /^card:(.*)$/.exec(target)?.[1];
    if (id === undefined) {
      problems.push(
        `short_text: link ${whole} points to "${target}"; Short text links must be [anchor](card:<id>). ` +
          "Put an external URL in a Link Attachment instead.",
      );
    } else if (!TID_PATTERN.test(id)) {
      problems.push(`short_text: link ${whole} has "${id}", which is not a Card ID (13 characters, e.g. 3m5xk2abcdefg)`);
    } else {
      links.push({ start, end: cursor, anchor, id });
    }
  }
  plain += text.slice(cursor);

  if (!plain.trim()) problems.push("short_text: must not be empty");
  if (/\]\s*\(/.test(plain)) {
    problems.push("short_text: contains a malformed link; write links exactly as [anchor](card:<id>) with no spaces in the target");
  }
  const bare = BARE_URL.exec(plain)?.[0];
  if (bare) {
    problems.push(
      `short_text: contains the URL "${bare}"; Short text must not contain URLs. ` +
        "Put an external URL in a Link Attachment, or link a Card as [anchor](card:<id>).",
    );
  }
  const length = Array.from(plain).length;
  if (length > SHORT_TEXT_MAX) {
    problems.push(
      `short_text: ${length} characters without link markup; the limit is ${SHORT_TEXT_MAX} (shorten by ${length - SHORT_TEXT_MAX})`,
    );
  }
  return { text, plain, links, problems };
}

/** Short text as written in the Card file: each `card:<id>` target replaced by the Card's URL. */
export function resolveShortText(parsed: ParsedShortText, urls: Map<string, string>): string {
  let out = "";
  let cursor = 0;
  for (const link of parsed.links) {
    const url = urls.get(link.id);
    if (!url) throw new Error(`unresolved Card link: ${link.id}`);
    out += `${parsed.text.slice(cursor, link.start)}[${link.anchor}](${url})`;
    cursor = link.end;
  }
  return out + parsed.text.slice(cursor);
}

/** Plain text of a Card file body: `[anchor](url)` replaced by `anchor`. */
export function plainFromMarkdown(markdown: string): string {
  return markdown.replace(LINK, "$1");
}
