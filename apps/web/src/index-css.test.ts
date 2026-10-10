import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

describe("admin stylesheet", () => {
  it("uses one dark palette whether the theme is chosen or follows the system", () => {
    const declarations = (selector: string) => {
      const start = css.indexOf(selector);
      expect(start, selector).toBeGreaterThan(-1);
      const open = css.indexOf("{", start);
      return css.slice(open + 1, css.indexOf("}", open)).split(";").map((line) => line.trim()).filter(Boolean);
    };
    const chosen = declarations('html[data-theme="dark"] {');
    expect(chosen.length).toBeGreaterThan(20);
    expect(declarations(':root:not([data-theme="light"]) {')).toEqual(chosen);
  });

  it("styles every state the header pill can take", () => {
    for (const mark of ["ok", "warn", "bad", "empty"]) expect(css).toContain(`.pill-${mark} {`);
  });
});
