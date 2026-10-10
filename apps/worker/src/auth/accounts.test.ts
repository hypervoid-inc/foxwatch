import { describe, expect, it } from "vitest";
import type { Env } from "../env.ts";
import { authorizeOps, type OpsActor } from "./ops.ts";
import { hasSqlite, testDb, type TestDb } from "../../test/sqlite-d1.ts";
import {
  AUDIT_RETENTION_MS,
  changeOwnPassword,
  createOperator,
  createSession,
  deleteOperator,
  loginUser,
  needsSetup, pruneAuthTables, reserveThrottleAudit, setupFirstUser, setupTokenRequired,
  throttleBucket,
} from "./accounts.ts";

const EMAIL = "owner@example.com";
const PASSWORD = "correct-horse-battery";

async function instance(vars: Partial<Env> = {}): Promise<{ env: Env; db: TestDb }> {
  const db = await testDb();
  const env = { DB: db.DB, ...vars } as unknown as Env;
  return { env, db };
}

async function claimed(vars: Partial<Env> = {}) {
  const made = await instance(vars);
  const setup = await setupFirstUser(made.env, EMAIL, PASSWORD);
  if (!setup.ok) throw new Error(`setup failed: ${setup.error}`);
  return { ...made, owner: setup.user, token: setup.token };
}

function throttleCount(db: TestDb, key: string): number | undefined {
  return db.query<{ count: number }>("SELECT count FROM ops_auth_throttle WHERE key = ?", key)[0]?.count;
}

describe("throttleBucket", () => {
  it("keeps IPv4 whole and folds IPv6 to its /64", () => {
    expect(throttleBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(throttleBucket("")).toBe("unknown");
    expect(throttleBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(throttleBucket("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(throttleBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(throttleBucket("::1")).toBe("0:0:0:0::/64");
    expect(throttleBucket("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
    expect(throttleBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd", 3)).toBe("2001:db8:1::/48");
    expect(throttleBucket("2001:db8::1", 3)).toBe("2001:db8:0::/48");
    expect(throttleBucket("203.0.113.9", 3)).toBe("203.0.113.9");
  });
});

describe.skipIf(!hasSqlite)("login throttle", () => {
  it("counts a parallel burst once per request", async () => {
    const { env } = await claimed();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => loginUser(env, EMAIL, "wrong-password-xx", "203.0.113.9")),
    );
    const errors = results.map((r) => (r.ok ? "ok" : r.error));
    expect(errors.filter((e) => e === "credentials")).toHaveLength(8);
    expect(errors.filter((e) => e === "rate")).toHaveLength(22);
    const trips = results.filter((r) => !r.ok && r.trip);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ error: "rate", trip: { scope: "pair", email: EMAIL } });
    // The limit holds for the right password too, until the window ends.
    expect(await loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).toEqual({ ok: false, error: "rate", scope: "pair", trip: undefined });
  });

  it("counts every /64 of one IPv6 /48 against the same account allowance", async () => {
    const { env, db } = await claimed();
    for (let i = 0; i < 12; i++) await loginUser(env, EMAIL, "wrong-password-xx", `2001:db8:77:${i.toString(16)}::1`);
    expect(throttleCount(db, `login:${EMAIL}`)).toBe(8);
    expect(await loginUser(env, EMAIL, PASSWORD, "2001:db8:77:ffff::1")).toMatchObject({ ok: false, error: "rate", scope: "pair" });
    expect((await loginUser(env, EMAIL, PASSWORD, "2001:db8:78::1")).ok).toBe(true);
  });

  it("never lets the account-wide count keep the right password out", async () => {
    const { env, db } = await claimed();
    const spend = (count: number) =>
      db.query("INSERT OR REPLACE INTO ops_auth_throttle (key, count, reset_at) VALUES (?, ?, ?)", `login:${EMAIL}`, count, Date.now() + 60_000);
    spend(200);
    // The attempt that crosses the limit is reported, and still checked.
    expect(await loginUser(env, EMAIL, "wrong-password-xx", "198.51.100.7")).toEqual({
      ok: false,
      error: "credentials",
      trip: { scope: "email", email: EMAIL },
    });
    spend(5000);
    expect((await loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).ok).toBe(true);
    // Past the limit a network gets three tries at the account, not eight.
    for (let i = 0; i < 2; i++) expect(await loginUser(env, EMAIL, "wrong-password-xx", "198.51.100.7")).toEqual({ ok: false, error: "credentials" });
    expect(await loginUser(env, EMAIL, PASSWORD, "198.51.100.7")).toEqual({ ok: false, error: "rate", scope: "email", trip: undefined });
    expect((await loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).ok).toBe(true);
  });

  it("caps the audit rows signed-out callers can cause, per kind of limit", async () => {
    const { env, db } = await claimed();
    const allowed = [];
    for (let i = 0; i < 6; i++) allowed.push(await reserveThrottleAudit(env, "pair"));
    expect(allowed).toEqual([true, true, true, false, false, false]);
    expect(await reserveThrottleAudit(env, "email")).toBe(true);
    db.query("UPDATE ops_auth_throttle SET reset_at = 1");
    expect(await reserveThrottleAudit(env, "pair")).toBe(true);
  });

  it("does not let one address lock an operator out", async () => {
    const { env } = await claimed();
    for (let i = 0; i < 20; i++) await loginUser(env, EMAIL, "wrong-password-xx", "198.51.100.7");
    expect(await loginUser(env, EMAIL, "wrong-password-xx", "198.51.100.7")).toMatchObject({ ok: false, error: "rate" });
    expect((await loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).ok).toBe(true);
  });

  it("stops a limited address before it can add rows or spend the account-wide count", async () => {
    const { env, db } = await claimed();
    const ip = "198.51.100.7";
    for (let i = 0; i < 12; i++) await loginUser(env, EMAIL, "wrong-password-xx", ip);
    // Eight counted against the account, the rest stopped at the address-and-account limit.
    expect(throttleCount(db, `login:${EMAIL}`)).toBe(8);
    for (let i = 0; i < 40; i++) await loginUser(env, `nobody${i}@example.com`, "wrong-password-xx", ip);
    const rows = db.query("SELECT key FROM ops_auth_throttle").length;
    const more = await loginUser(env, "fresh@example.com", "wrong-password-xx", ip);
    expect(more).toMatchObject({ ok: false, error: "rate", scope: "ip" });
    await loginUser(env, "fresher@example.com", "wrong-password-xx", ip);
    expect(db.query("SELECT key FROM ops_auth_throttle")).toHaveLength(rows);
  });

  it("counts only failures and starts over when the window ends", async () => {
    const { env, db } = await claimed();
    const ip = "203.0.113.9";
    for (let i = 0; i < 3; i++) await loginUser(env, EMAIL, "wrong-password-xx", ip);
    expect((await loginUser(env, EMAIL, PASSWORD, ip)).ok).toBe(true);
    expect(throttleCount(db, `login-pair:${ip}|${EMAIL}`)).toBeUndefined();
    expect(throttleCount(db, `login-ip:${ip}`)).toBe(3);
    expect(throttleCount(db, `login:${EMAIL}`)).toBe(3);

    for (let i = 0; i < 9; i++) await loginUser(env, EMAIL, "wrong-password-xx", ip);
    expect(await loginUser(env, EMAIL, PASSWORD, ip)).toMatchObject({ ok: false, error: "rate" });
    db.query("UPDATE ops_auth_throttle SET reset_at = 1");
    expect((await loginUser(env, EMAIL, PASSWORD, ip)).ok).toBe(true);
    expect(throttleCount(db, `login-ip:${ip}`)).toBe(0);
  });
});

describe.skipIf(!hasSqlite)("loginUser", () => {
  it("upgrades a weaker stored hash on the next successful sign-in", async () => {
    const { env, db, owner } = await claimed();
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(PASSWORD), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new Uint8Array(16), iterations: 1000, hash: "SHA-256" }, material, 256);
    const hex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const weak = `pbkdf2-sha256$1000$${"00".repeat(16)}$${hex}`;
    db.query("UPDATE ops_users SET password_hash = ? WHERE id = ?", weak, owner.id);
    const stored = () => db.query<{ password_hash: string }>("SELECT password_hash FROM ops_users WHERE id = ?", owner.id)[0]!.password_hash;

    await loginUser(env, EMAIL, "wrong-password-xx", "203.0.113.9");
    expect(stored()).toBe(weak);
    expect((await loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).ok).toBe(true);
    expect(stored()).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect((await loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).ok).toBe(true);
  });
});

describe.skipIf(!hasSqlite)("pruneAuthTables", () => {
  it("drops ended throttle windows, expired sessions and old audit entries only", async () => {
    const { env, db } = await claimed();
    const now = Date.now();
    await loginUser(env, EMAIL, "wrong-password-xx", "203.0.113.9");
    db.query("INSERT INTO ops_auth_throttle (key, count, reset_at) VALUES ('login-ip:old', 3, ?)", now - 1);
    db.query("INSERT INTO ops_sessions (id, user_id, token_hash, created_at, expires_at) VALUES ('old', 'u', 'h', 1, ?)", now - 1);
    db.query("INSERT INTO audit_log (id, actor, action, created_at) VALUES ('old', 'a', 'login', ?)", now - AUDIT_RETENTION_MS - 1);
    db.query("INSERT INTO audit_log (id, actor, action, created_at) VALUES ('kept', 'a', 'login', ?)", now - AUDIT_RETENTION_MS + 60_000);

    await pruneAuthTables(env, now);

    expect(db.query<{ key: string }>("SELECT key FROM ops_auth_throttle").map((r) => r.key).sort()).toEqual([
      "login-ip:203.0.113.9",
      `login-pair:203.0.113.9|${EMAIL}`,
      `login:${EMAIL}`,
    ]);
    expect(db.query<{ id: string }>("SELECT id FROM ops_sessions").map((r) => r.id)).not.toContain("old");
    expect(db.query("SELECT id FROM ops_sessions")).toHaveLength(1);
    expect(db.query<{ id: string }>("SELECT id FROM audit_log").map((r) => r.id)).toEqual(["kept"]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('idx_ops_sessions_expires', 'idx_ops_auth_throttle_reset')")).toHaveLength(2);
  });
});

describe.skipIf(!hasSqlite)("setupFirstUser", () => {
  it("stays open when no setup token is configured", async () => {
    const { env } = await instance();
    expect(setupTokenRequired(env)).toBe(false);
    expect((await setupFirstUser(env, EMAIL, PASSWORD)).ok).toBe(true);
    expect(await setupFirstUser(env, "second@example.com", PASSWORD)).toEqual({ ok: false, error: "exists" });
  });

  it("requires the configured setup token", async () => {
    const { env, db } = await instance({ FOXWATCH_SETUP_TOKEN: "deploy-owner-token\n" });
    expect(setupTokenRequired(env)).toBe(true);
    expect(await setupFirstUser(env, EMAIL, PASSWORD)).toEqual({ ok: false, error: "setup_token" });
    expect(await setupFirstUser(env, EMAIL, PASSWORD, "guess", "203.0.113.9")).toEqual({ ok: false, error: "setup_token" });
    expect(await setupFirstUser(env, EMAIL, PASSWORD, 7, "203.0.113.9")).toEqual({ ok: false, error: "setup_token" });
    expect(db.query("SELECT id FROM ops_users")).toHaveLength(0);
    expect((await setupFirstUser(env, EMAIL, PASSWORD, " deploy-owner-token ", "203.0.113.9")).ok).toBe(true);
  });

  it("limits token guesses per address", async () => {
    const { env } = await instance({ FOXWATCH_SETUP_TOKEN: "deploy-owner-token" });
    for (let i = 0; i < 8; i++) await setupFirstUser(env, EMAIL, PASSWORD, `guess-${i}`, "198.51.100.7");
    expect(await setupFirstUser(env, EMAIL, PASSWORD, "deploy-owner-token", "198.51.100.7")).toEqual({ ok: false, error: "rate" });
    expect((await setupFirstUser(env, EMAIL, PASSWORD, "deploy-owner-token", "203.0.113.9")).ok).toBe(true);
  });
});

function withToken(token: string): Request {
  return new Request("https://status.example.com/api/ops/overview", { headers: { Authorization: `Bearer ${token}` } });
}

describe.skipIf(!hasSqlite)("changeOwnPassword", () => {
  const NEXT = "a-brand-new-password";

  it("needs the current password and a valid new one", async () => {
    const { env, owner, token } = await claimed();
    const actor: OpsActor = { actor: owner.email, userId: owner.id, role: "superadmin" };
    expect(await changeOwnPassword(env, actor, PASSWORD, "short", token)).toEqual({ ok: false, error: "invalid_password" });
    expect(await changeOwnPassword(env, actor, "wrong-password-xx", NEXT, token)).toEqual({ ok: false, error: "current_password" });
    expect(await changeOwnPassword(env, actor, undefined, NEXT, token)).toEqual({ ok: false, error: "current_password" });
    expect((await loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).ok).toBe(true);
  });

  it("rotates the hash and signs out the caller's other sessions only", async () => {
    const { env, db, owner, token } = await claimed();
    const actor: OpsActor = { actor: owner.email, userId: owner.id, role: "superadmin" };
    const stolen = await createSession(env, owner.id);
    db.query("INSERT INTO ops_users (id, email, password_hash, role, created_at) VALUES ('other', 'other@example.com', 'x', 'admin', 1)");
    const colleague = await createSession(env, "other");

    expect(await changeOwnPassword(env, actor, PASSWORD, NEXT, token)).toEqual({ ok: true });

    expect(await authorizeOps(withToken(token), env)).toMatchObject({ userId: owner.id });
    expect(await authorizeOps(withToken(stolen), env)).toBeNull();
    expect(await authorizeOps(withToken(colleague), env)).toMatchObject({ userId: "other" });
    expect(await loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).toMatchObject({ ok: false, error: "credentials" });
    expect((await loginUser(env, EMAIL, NEXT, "203.0.113.9")).ok).toBe(true);
  });

  it("limits guesses at the current password per session", async () => {
    const { env, db, owner, token } = await claimed();
    const actor: OpsActor = { actor: owner.email, userId: owner.id, role: "superadmin" };
    const stolen = await createSession(env, owner.id);
    for (let i = 0; i < 8; i++) {
      expect(await changeOwnPassword(env, actor, `wrong-password-${i}`, NEXT, stolen)).toEqual({ ok: false, error: "current_password" });
    }
    expect(await changeOwnPassword(env, actor, PASSWORD, NEXT, stolen)).toEqual({ ok: false, error: "rate" });
    // A session past its limit stops there and adds nothing to the account-wide count.
    for (let i = 0; i < 20; i++) await changeOwnPassword(env, actor, `wrong-password-${i}`, NEXT, stolen);
    expect(throttleCount(db, `password:${owner.id}`)).toBe(8);

    // The owner's own session is not held back by the stolen one, and rotating ends it.
    expect(await changeOwnPassword(env, actor, PASSWORD, NEXT, token)).toEqual({ ok: true });
    expect(await authorizeOps(withToken(stolen), env)).toBeNull();
    expect(throttleCount(db, `password:${owner.id}`)).toBeUndefined();
  });

  it("never lets the account-wide count keep the owner from rotating", async () => {
    const { env, db, owner, token } = await claimed();
    const actor: OpsActor = { actor: owner.email, userId: owner.id, role: "superadmin" };
    // Several stolen sessions between them push the account past its count.
    for (let s = 0; s < 6; s++) {
      const stolen = await createSession(env, owner.id);
      for (let i = 0; i < 8; i++) await changeOwnPassword(env, actor, `wrong-password-${i}`, NEXT, stolen);
    }
    expect(throttleCount(db, `password:${owner.id}`)).toBe(48);

    // Past it, a session gets the guarded allowance, not the full one.
    const late = await createSession(env, owner.id);
    for (let i = 0; i < 3; i++) {
      expect(await changeOwnPassword(env, actor, `wrong-password-${i}`, NEXT, late)).toEqual({ ok: false, error: "current_password" });
    }
    expect(await changeOwnPassword(env, actor, PASSWORD, NEXT, late)).toEqual({ ok: false, error: "rate" });

    expect(await changeOwnPassword(env, actor, PASSWORD, NEXT, token)).toEqual({ ok: true });
    expect(await authorizeOps(withToken(late), env)).toBeNull();
  });
});

describe.skipIf(!hasSqlite)("database errors and recovery", () => {
  it("reports an unavailable database as an error, not as setup or signed out", async () => {
    const { env, db, token } = await claimed();
    db.failing = true;
    await expect(needsSetup(env)).rejects.toThrow();
    await expect(authorizeOps(withToken(token), env)).rejects.toThrow();
    await expect(loginUser(env, EMAIL, PASSWORD, "203.0.113.9")).rejects.toThrow();
    db.failing = false;
    expect(await needsSetup(env)).toBe(false);
    expect(await authorizeOps(withToken(token), env)).toMatchObject({ actor: EMAIL });
  });

  it("treats a mangled session cookie as signed out", async () => {
    const { env } = await claimed();
    const request = new Request("https://status.example.com/api/ops/auth", { headers: { Cookie: "foxwatch_ops=%E0%A4%A" } });
    expect(await authorizeOps(request, env)).toBeNull();
  });

  it("lets exactly one of two racing setups win", async () => {
    const { env, db } = await instance();
    const results = await Promise.all([
      setupFirstUser(env, "one@example.com", PASSWORD),
      setupFirstUser(env, "two@example.com", PASSWORD),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "exists" });
    expect(db.query("SELECT id FROM ops_users")).toHaveLength(1);
    expect(db.query("SELECT id FROM ops_sessions")).toHaveLength(1);
  });

  it("can be claimed again once every account is gone", async () => {
    const { env, db } = await claimed();
    // Instances set up by earlier versions also carry this marker row.
    db.query("INSERT INTO meta (key, value) VALUES ('ops_bootstrapped', 'old-user')");
    db.query("DELETE FROM ops_users");
    expect(await needsSetup(env)).toBe(true);
    expect((await setupFirstUser(env, "new-owner@example.com", PASSWORD)).ok).toBe(true);
  });

  it("never removes the last superadmin, even when two remove each other at once", async () => {
    const { env, db, owner } = await claimed();
    const a: OpsActor = { actor: owner.email, userId: owner.id, role: "superadmin" };
    const made = await createOperator(env, a, "second@example.com", PASSWORD, "superadmin");
    if (!made.ok) throw new Error(made.error);
    const b: OpsActor = { actor: made.user.email, userId: made.user.id, role: "superadmin" };
    const kept = await createSession(env, b.userId);

    const results = await Promise.all([deleteOperator(env, a, b.userId), deleteOperator(env, b, a.userId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "last_superadmin" });
    expect(db.query("SELECT id FROM ops_users WHERE role = 'superadmin'")).toHaveLength(1);
    // Sessions go with the removed account and stay with the surviving one.
    const survivor = db.query<{ id: string }>("SELECT id FROM ops_users")[0]!.id;
    expect(db.query<{ user_id: string }>("SELECT user_id FROM ops_sessions").every((s) => s.user_id === survivor)).toBe(true);
    expect((await authorizeOps(withToken(kept), env)) === null).toBe(survivor !== b.userId);
  });

  it("removes an admin and their sessions, and reports a duplicate email", async () => {
    const { env, db, owner } = await claimed();
    const actor: OpsActor = { actor: owner.email, userId: owner.id, role: "superadmin" };
    const made = await createOperator(env, actor, "admin@example.com", PASSWORD, "admin");
    if (!made.ok) throw new Error(made.error);
    expect(await createOperator(env, actor, "admin@example.com", PASSWORD, "admin")).toEqual({ ok: false, error: "exists" });
    const racing = await Promise.all([
      createOperator(env, actor, "unique@example.com", PASSWORD, "admin"),
      createOperator(env, actor, "unique@example.com", PASSWORD, "admin"),
    ]);
    expect(racing.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(racing.find((r) => !r.ok)).toEqual({ ok: false, error: "exists" });
    db.failing = true;
    await expect(createOperator(env, actor, "unique-two@example.com", PASSWORD, "admin")).rejects.toThrow();
    db.failing = false;
    const session = await createSession(env, made.user.id);
    expect(await deleteOperator(env, actor, made.user.id)).toEqual({ ok: true });
    expect(await authorizeOps(withToken(session), env)).toBeNull();
    expect(db.query("SELECT id FROM ops_sessions WHERE user_id = ?", made.user.id)).toHaveLength(0);
    expect(await deleteOperator(env, actor, made.user.id)).toEqual({ ok: false, error: "not_found" });
    expect(await deleteOperator(env, actor, owner.id)).toEqual({ ok: false, error: "self" });
  });
});
