import { describe, expect, it } from "vitest";
import { validateCardInput } from "../src/cards";

describe("create_card validation", () => {
  it("requires Operator Cards to have a parent", () => {
    const { problems } = validateCardInput({ author: "operator", short_text: "I think so." });
    expect(problems).toEqual(["parent_id: Operator Cards must reply to an existing Card; give parent_id"]);
  });

  it("never lets an Operator Card carry an Article", () => {
    const { problems } = validateCardInput({
      author: "operator",
      parent_id: "3m5xk2abcdefg",
      short_text: "My view.",
      attachment: { type: "article", markdown: "Long text." },
    });
    expect(problems).toEqual([
      "attachment: Operator Cards never carry an Article; the Operator's long texts are Blog posts",
    ]);
  });

  it("allows a root Agent Card with an Article", () => {
    const { problems } = validateCardInput({
      author: "agent",
      short_text: "A finding.",
      attachment: { type: "article", markdown: "Details, citing https://example.com." },
    });
    expect(problems).toEqual([]);
  });

  it("reports every problem at once", () => {
    const { problems } = validateCardInput({
      author: "operator",
      short_text: "\u041f\u0440\u0438\u0432\u0435\u0442 https://x.y",
      attachment: { type: "images", images: [{ url: "ftp://x", alt: "" }] },
    });
    expect(problems.join("\n")).toMatch(/U\+041F/);
    expect(problems.join("\n")).toMatch(/must not contain URLs/);
    expect(problems.join("\n")).toMatch(/parent_id: Operator Cards must reply/);
    expect(problems.join("\n")).toMatch(/images\[0\]\.url: "ftp:\/\/x" is not an http\(s\) URL/);
    expect(problems.join("\n")).toMatch(/images\[0\]\.alt: alt text is required/);
  });

  it("limits images to four", () => {
    const image = { url: "https://example.com/a.png", alt: "A" };
    const { problems } = validateCardInput({
      author: "agent",
      short_text: "Pictures.",
      attachment: { type: "images", images: [image, image, image, image, image] },
    });
    expect(problems).toEqual(["attachment.images: give 1 to 4 images, not 5"]);
  });
});
