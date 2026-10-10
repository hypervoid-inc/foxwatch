import { describe, expect, it } from "vitest";
import { tokenizeMarkup } from "./markup.ts";

const join = (source: string) => tokenizeMarkup(source).map((t) => t.text).join("");

describe("markup highlighting", () => {
  it("marks tag names, attribute names and attribute values", () => {
    expect(tokenizeMarkup('<a href="/x" class=\'y\' hidden>ok</a>')).toEqual([
      { kind: "text", text: "<" },
      { kind: "tag", text: "a" },
      { kind: "text", text: " " },
      { kind: "attr", text: "href" },
      { kind: "text", text: '="' },
      { kind: "val", text: "/x" },
      { kind: "text", text: '" ' },
      { kind: "attr", text: "class" },
      { kind: "text", text: "='" },
      { kind: "val", text: "y" },
      { kind: "text", text: "' " },
      { kind: "attr", text: "hidden" },
      { kind: "text", text: ">ok</" },
      { kind: "tag", text: "a" },
      { kind: "text", text: ">" },
    ]);
  });

  it("leaves a plain tag as a tag, with none of its own markup in the output", () => {
    expect(tokenizeMarkup("<p>ok</p>")).toEqual([
      { kind: "text", text: "<" },
      { kind: "tag", text: "p" },
      { kind: "text", text: ">ok</" },
      { kind: "tag", text: "p" },
      { kind: "text", text: ">" },
    ]);
  });

  it("always joins back into the source, whatever the response holds", () => {
    for (const source of [
      "",
      "plain text with a=1 and \"quotes\"",
      '<!doctype html>\n<html lang="en">\n  <body class=markup-tag>a < b && c > d</body>\n</html>',
      '<span class="markup-val">&lt;script&gt;</span>',
      '<a href="unterminated',
      "<svg:rect x=1 y='2' /><br/>",
      "<<>><a b=>< /p>",
    ]) {
      expect(join(source)).toBe(source);
    }
  });

  it("does not highlight attribute-looking text outside a tag", () => {
    expect(tokenizeMarkup('<p>x class="y"</p>').filter((t) => t.kind === "attr" || t.kind === "val")).toEqual([]);
  });
});
