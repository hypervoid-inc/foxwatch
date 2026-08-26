import { describe, expect, it } from "vitest";
import { fileFromDrop, fitIconSize, isImageFile } from "./prepare-icon.ts";

describe("site icon prep", () => {
  it("fits to the long edge without upscaling", () => {
    expect(fitIconSize(2048, 1024, 512)).toEqual({ width: 512, height: 256 });
    expect(fitIconSize(100, 80, 512)).toEqual({ width: 100, height: 80 });
    expect(fitIconSize(0, 0, 512)).toEqual({ width: 1, height: 1 });
  });

  it("treats HEIC and extension-only files as images", () => {
    expect(isImageFile(new File([], "logo.heic"))).toBe(true);
    expect(isImageFile(new File([], "shot.AVIF"))).toBe(true);
    expect(isImageFile(new File([], "mark.svg"))).toBe(true);
    expect(isImageFile(new File([], "notes.pdf"))).toBe(false);
    expect(isImageFile(new File([], "blob", { type: "image/jpeg" }))).toBe(true);
  });

  it("picks the first image from a drop, even if it is not first in the list", () => {
    const dt = {
      files: [new File([], "readme.txt"), new File([], "brand.heic")],
    } as unknown as DataTransfer;
    expect(fileFromDrop(dt)?.name).toBe("brand.heic");
  });
});
