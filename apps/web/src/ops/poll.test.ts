import { describe, expect, it } from "vitest";
import type { ApiResult } from "./api.ts";
import { loadVerdict, pollDelay } from "./poll.ts";

const failed = (status: number): ApiResult<never> => ({ ok: false, status, error: "x" });
const signedIn: ApiResult<{ me: unknown }> = { ok: true, data: { me: { id: "u1" } } };

describe("admin refresh", () => {
  it("backs off after failures and caps the wait", () => {
    expect(pollDelay(0)).toBe(30_000);
    expect(pollDelay(1)).toBe(60_000);
    expect(pollDelay(2)).toBe(120_000);
    expect(pollDelay(4)).toBe(300_000);
    expect(pollDelay(400)).toBe(300_000);
    expect(pollDelay(-1)).toBe(30_000);
  });

  it("signs out only when the server says the session is gone", () => {
    expect(loadVerdict({ ok: true, data: { me: null } }, null)).toBe("signed-out");
    expect(loadVerdict(signedIn, failed(401))).toBe("signed-out");
    expect(loadVerdict(signedIn, { ok: true, data: {} })).toBe("ready");
  });

  it("treats server errors and dropped requests as a connection problem", () => {
    expect(loadVerdict(failed(500), null)).toBe("unreachable");
    expect(loadVerdict(failed(0), null)).toBe("unreachable");
    expect(loadVerdict(signedIn, failed(500))).toBe("unreachable");
    expect(loadVerdict(signedIn, failed(503))).toBe("unreachable");
    expect(loadVerdict(signedIn, failed(0))).toBe("unreachable");
    expect(loadVerdict(signedIn, failed(200))).toBe("unreachable");
  });
});
