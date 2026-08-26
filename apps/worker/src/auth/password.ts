import { tokenEquals } from "../lib/crypto.ts";

export const PBKDF2_ITERATIONS = 210_000;
const HASH_PREFIX = "pbkdf2-sha256";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${HASH_PREFIX}$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(derived)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return false;
  const iterations = Number(parts[1]);
  const salt = hexToBytes(parts[2] ?? "");
  const expected = parts[3] ?? "";
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 2_000_000 || !salt || !expected) return false;
  const derived = await pbkdf2(password, salt, iterations);
  return tokenEquals(bytesToHex(derived), expected);
}

let dummyHashPromise: Promise<string> | null = null;

export async function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("foxwatch-dummy-password");
  return dummyHashPromise;
}

export function parseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function parsePassword(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length < 12 || raw.length > 128) return null;
  return raw;
}
