import { describe, expect, it } from "vitest";
import { activityPath, mergeActivityById } from "./Activity.tsx";

describe("activity list paging", () => {
  it("asks the audit API for a 100-item page and a cursor", () => {
    expect(activityPath()).toBe("/api/ops/audit?limit=100");
    expect(activityPath("1700000000123:abc")).toBe("/api/ops/audit?limit=100&cursor=1700000000123%3Aabc");
  });

  it("appends without replacing and skips duplicate ids", () => {
    const a = { id: "a", actor: "x", action: "login", createdAt: 3 };
    const b = { id: "b", actor: "x", action: "mute", createdAt: 2 };
    const c = { id: "c", actor: "x", action: "unmute", createdAt: 1 };
    expect(mergeActivityById([a], [b, a, c], "append").map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("prepends live items by id without resetting older rows", () => {
    const older = { id: "old", actor: "x", action: "login", createdAt: 1 };
    const newer = { id: "new", actor: "x", action: "mute", createdAt: 2 };
    expect(mergeActivityById([older], [newer, older], "prepend").map((e) => e.id)).toEqual(["new", "old"]);
  });
});
