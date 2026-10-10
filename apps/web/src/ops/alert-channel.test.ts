import { describe, expect, it } from "vitest";
import { ID_RE } from "@foxwatch/config";
import { uniqueChannelId } from "./alert-channel.ts";

describe("alert channel names", () => {
  it("keeps a free name as it is", () => {
    expect(uniqueChannelId("primary-alerts", [])).toBe("primary-alerts");
    expect(uniqueChannelId("primary-alerts", ["oncall"])).toBe("primary-alerts");
  });

  it("moves to the first free number when the name is taken", () => {
    expect(uniqueChannelId("primary-alerts", ["primary-alerts"])).toBe("primary-alerts-2");
    expect(uniqueChannelId("primary-alerts", ["primary-alerts", "primary-alerts-2"])).toBe("primary-alerts-3");
    expect(uniqueChannelId("primary-alerts-2", ["primary-alerts", "primary-alerts-2"])).toBe("primary-alerts-3");
  });

  it("stays a valid id at the length limit", () => {
    const long = "a".repeat(63);
    const next = uniqueChannelId(long, [long]);
    expect(next).toBe(`${"a".repeat(61)}-2`);
    expect(ID_RE.test(next)).toBe(true);
  });
});
