import { describe, expect, it, vi } from "vitest";
import { dummyPasswordHash, hashPassword, parseEmail, parsePassword, passwordNeedsRehash, verifyPassword } from "./password.ts";

// Builds a stored hash with an iteration count other than the one hashPassword writes.
const LEGACY_SALT = "000102030405060708090a0b0c0d0e0f";

async function legacyHash(password: string, iterations: number): Promise<string> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(LEGACY_SALT.match(/../g)!.map((h) => Number.parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, 256);
  const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2-sha256$${iterations}$${LEGACY_SALT}$${hex}`;
}

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

describe("verifyPassword", () => {
  it("keeps verifying hashes stored with another iteration count", async () => {
    const stored = await legacyHash("correct-horse-battery", 1000);
    expect(await verifyPassword("correct-horse-battery", stored)).toBe(true);
    expect(await verifyPassword("wrong-password-xx", stored)).toBe(false);
  });

  it("fails cleanly when the runtime refuses the stored iteration count", async () => {
    const stored = await legacyHash("correct-horse-battery", 1000);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const derive = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("iteration counts above 100000 are not supported"));
    try {
      expect(await verifyPassword("correct-horse-battery", stored.replace("$1000$", "$600000$"))).toBe(false);
      expect(log).toHaveBeenCalledOnce();
    } finally {
      derive.mockRestore();
      log.mockRestore();
    }
  });

  it("rejects malformed counts without deriving", async () => {
    for (const count of ["0", "-5", "1.5", "abc", "2000001", ""]) {
      expect(await verifyPassword("x", `pbkdf2-sha256$${count}$${LEGACY_SALT}$00`)).toBe(false);
    }
  });
});

describe("passwordNeedsRehash", () => {
  it("flags only valid hashes weaker than the current parameters", async () => {
    expect(passwordNeedsRehash(await legacyHash("correct-horse-battery", 1000))).toBe(true);
    expect(passwordNeedsRehash(await hashPassword("correct-horse-battery"))).toBe(false);
    expect(passwordNeedsRehash(`pbkdf2-sha256$600000$${LEGACY_SALT}$00`)).toBe(false);
    expect(passwordNeedsRehash("not-a-hash")).toBe(false);
  });
});
