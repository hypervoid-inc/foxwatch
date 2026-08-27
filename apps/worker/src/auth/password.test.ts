import { describe, expect, it } from "vitest";
import { dummyPasswordHash, hashPassword, parseEmail, parsePassword, verifyPassword } from "./password.ts";

describe("parseEmail", () => {
  it("normalizes and rejects junk", () => {
    expect(parseEmail("  Admin@Example.COM ")).toBe("admin@example.com");
    expect(parseEmail("ankush@construct.computer")).toBe("ankush@construct.computer");
    expect(parseEmail("not-an-email")).toBeNull();
    expect(parseEmail("")).toBeNull();
    expect(parseEmail("a@b")).toBeNull();
  });
});

describe("parsePassword", () => {
  it("requires 12–128 characters", () => {
    expect(parsePassword("short")).toBeNull();
    expect(parsePassword("long-enough-pw")).toBe("long-enough-pw");
    expect(parsePassword("x".repeat(129))).toBeNull();
  });
});

describe("hashPassword", () => {
  it("verifies the same password and rejects another", async () => {
    const stored = await hashPassword("correct-horse-battery");
    expect(stored.startsWith("pbkdf2-sha256$100000$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", stored)).toBe(true);
    expect(await verifyPassword("wrong-password-xx", stored)).toBe(false);
    expect(await verifyPassword("correct-horse-battery", "not-a-hash")).toBe(false);
  });

  it("dummy hash is a valid encoded hash", async () => {
    const dummy = await dummyPasswordHash();
    expect(await verifyPassword("foxwatch-dummy-password", dummy)).toBe(true);
  });
});
