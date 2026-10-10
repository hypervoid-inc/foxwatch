import { describe, expect, it } from "vitest";
import { THEME_KEY } from "./theme.ts";

describe("theme", () => {
  it("stores appearance under a key shared by admin and the public page", () => {
    expect(THEME_KEY).toBe("foxwatch-theme");
  });
});
