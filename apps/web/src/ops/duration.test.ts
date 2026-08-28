import { describe, expect, it } from "vitest";
import {
  clampDuration,
  convertDuration,
  durationMs,
  maxAmount,
  sanitizeInt,
  splitDuration,
  unitsForCap,
} from "./duration.ts";

describe("duration field", () => {
  it("splits ms into the coarsest exact unit", () => {
    expect(splitDuration(10_000)).toEqual({ value: "10", unit: "s" });
    expect(splitDuration(8_500)).toEqual({ value: "8500", unit: "ms" });
    expect(splitDuration(120_000)).toEqual({ value: "2", unit: "m" });
  });

  it("only accepts whole numbers times a unit", () => {
    expect(durationMs("10", "s")).toBe(10_000);
    expect(durationMs("1", "m")).toBe(60_000);
    expect(durationMs("0", "s")).toBeNull();
    expect(durationMs("10s", "s")).toBeNull();
    expect(durationMs("1e3", "ms")).toBeNull();
    expect(durationMs("-2", "s")).toBeNull();
    expect(durationMs("1.5", "s")).toBeNull();
  });

  it("hides units that cannot fit the cap", () => {
    expect(unitsForCap(15_000)).toEqual(["ms", "s"]);
    expect(unitsForCap(60_000)).toEqual(["ms", "s", "m"]);
    expect(maxAmount("m", 15_000)).toBe(0);
  });

  it("strips junk and clamps", () => {
    expect(sanitizeInt("12", 15)).toBe("12");
    expect(sanitizeInt("99", 15)).toBe("15");
    expect(sanitizeInt("0", 15, 1)).toBe("1");
    expect(sanitizeInt("", 15)).toBe("");
    expect(sanitizeInt("e3", 15)).toBeUndefined();
    expect(sanitizeInt("1.2", 15)).toBeUndefined();
    expect(sanitizeInt("+1", 15)).toBeUndefined();
    expect(sanitizeInt("10s", 15)).toBeUndefined();
  });

  it("converts between units without inventing minutes over a 15s cap", () => {
    expect(convertDuration("10", "s", "ms", 15_000)).toBe("10000");
    expect(convertDuration("10000", "ms", "s", 15_000)).toBe("10");
    expect(convertDuration("10", "s", "m", 15_000)).toBe("");
  });

  it("clamps a duration down to the cap", () => {
    expect(clampDuration("40", "s", 30_000)).toEqual({ value: "30", unit: "s" });
    expect(clampDuration("200", "ms", 30_000)).toEqual({ value: "200", unit: "ms" });
    expect(clampDuration("", "s", 30_000)).toEqual({ value: "", unit: "s" });
  });
});
