import { describe, expect, it } from "vitest";
import { characterProblems, parseShortText, resolveShortText } from "../src/text";

const ID = "3m5xk2abcdefg";

describe("allowed characters", () => {
  it("accepts ASCII, Latin letters, NBSP, newlines, and the typographic list", () => {
    const text = "Plain ASCII ~!@#$%^&*()_+{}|:\"<>?\ncafé Ærø Łódź ß\u00a0‘single’ “double” – — … • · × ÷ ± ≤ ≥ ≠ ≈ → ← ↔ °";
    expect(characterProblems("short_text", text)).toEqual([]);
  });

  it("names each rejected character with its code point and position", () => {
    expect(characterProblems("short_text", "Hi \u041f\u0440 😀\t")).toEqual([
      'short_text: character "\u041f" (U+041F) at position 4 is not allowed',
      'short_text: character "\u0440" (U+0440) at position 5 is not allowed',
      'short_text: character "😀" (U+1F600) at position 7 is not allowed',
      'short_text: character "\\t" (U+0009) at position 8 is not allowed',
    ]);
  });

  it("rejects characters just outside the allowed ranges", () => {
    expect(characterProblems("f", "\u00bf\u0180\u2010")).toHaveLength(3);
  });
});

describe("Short text", () => {
  const link = `[see this](card:${ID})`;

  it("counts 300 characters without link markup as within the limit", () => {
    const parsed = parseShortText(`${link} ${"x".repeat(291)}`);
    expect(Array.from(parsed.plain)).toHaveLength(300);
    expect(parsed.problems).toEqual([]);
  });

  it("rejects 301 characters without link markup", () => {
    const parsed = parseShortText(`${link} ${"x".repeat(292)}`);
    expect(parsed.problems).toEqual([
      "short_text: 301 characters without link markup; the limit is 300 (shorten by 1)",
    ]);
  });

  it("rejects bare URLs", () => {
    for (const text of ["read https://example.com/paper", "at www.example.com today", "mail mailto:a@b.c"]) {
      expect(parseShortText(text).problems.join("\n")).toMatch(/must not contain URLs/);
    }
  });

  it("rejects links that are not card links, pointing to the Link Attachment", () => {
    const problems = parseShortText("see [paper](https://example.com) and [x](card:nope)").problems;
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/must be \[anchor\]\(card:<id>\).*Link Attachment/);
    expect(problems[1]).toMatch(/"nope", which is not a Card ID/);
  });

  it("rejects malformed links instead of publishing markup", () => {
    expect(parseShortText(`see [x](card: ${ID})`).problems.join("\n")).toMatch(/malformed link/);
  });

  it("resolves card links to page URLs and keeps anchors in plain text", () => {
    const parsed = parseShortText(`  Builds on [the earlier finding](card:${ID}).\n`);
    expect(parsed.problems).toEqual([]);
    expect(parsed.plain).toBe("Builds on the earlier finding.");
    const urls = new Map([[ID, `https://cards.smith.wiki/${ID}/`]]);
    expect(resolveShortText(parsed, urls)).toBe(`Builds on [the earlier finding](https://cards.smith.wiki/${ID}/).`);
  });
});
