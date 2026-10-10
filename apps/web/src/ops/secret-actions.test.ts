import { describe, expect, it } from "vitest";
import { secretActions } from "./secret-actions.ts";

describe("secret controls", () => {
  it("offers Remove only for a name with no value, since the server refuses to remove a set secret", () => {
    expect(secretActions("superadmin", { set: true }, true)).toEqual({ rotate: true, remove: false });
    expect(secretActions("superadmin", { set: false }, true)).toEqual({ rotate: false, remove: true });
  });

  it("offers Rotate only where Worker secrets can be managed", () => {
    expect(secretActions("superadmin", { set: true }, false)).toEqual({ rotate: false, remove: false });
  });

  it("offers nothing to an admin, whose changes the server rejects", () => {
    expect(secretActions("admin", { set: true }, true)).toEqual({ rotate: false, remove: false });
    expect(secretActions("admin", { set: false }, true)).toEqual({ rotate: false, remove: false });
  });
});
