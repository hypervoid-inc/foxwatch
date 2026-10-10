import { afterEach, describe, expect, it, vi } from "vitest";
import { api, apiUpload } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respondWith(make: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async () => make()));
}

describe("api", () => {
  it("returns the parsed body on success and nothing on 204", async () => {
    respondWith(() => Response.json({ ok: true }));
    expect(await api("/api/ops/auth")).toEqual({ ok: true, data: { ok: true } });
    respondWith(() => new Response(null, { status: 204 }));
    expect(await api("/api/ops/session", { method: "DELETE" })).toEqual({ ok: true, data: undefined });
  });

  it("resolves with a network error when the request never gets an answer", async () => {
    respondWith(() => {
      throw new TypeError("Failed to fetch");
    });
    const expected = { ok: false, status: 0, code: "network", error: expect.stringMatching(/Could not reach the server/) };
    expect(await api("/api/ops/overview")).toEqual(expected);
    expect(await apiUpload("/api/ops/settings/icon", new FormData())).toEqual(expected);
  });

  it("treats a success status with a non-JSON body as an error", async () => {
    respondWith(() => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html" } }));
    const expected = { ok: false, status: 200, code: "bad_response", error: expect.any(String) };
    expect(await api("/api/ops/overview")).toEqual(expected);
    expect(await apiUpload("/api/ops/settings/icon", new FormData())).toEqual(expected);
  });

  it("keeps the server's message and code for an error status, with a fallback when the body is not JSON", async () => {
    respondWith(() => Response.json({ error: "Add a public incident title.", code: "title" }, { status: 400 }));
    expect(await api("/api/ops/incidents", { method: "POST", body: "{}" })).toEqual({
      ok: false,
      status: 400,
      error: "Add a public incident title.",
      code: "title",
    });
    respondWith(() => new Response("bad gateway", { status: 502 }));
    expect(await api("/api/ops/overview")).toEqual({ ok: false, status: 502, error: "Something went wrong. Try again.", code: undefined });
  });
});
