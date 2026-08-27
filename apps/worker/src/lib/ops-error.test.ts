import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { fail, failFromUnknown, opsErrorBody } from "./ops-error.ts";

describe("opsErrorBody", () => {
  it("returns a sentence for known codes", () => {
    expect(opsErrorBody("invalid_password")).toEqual({
      error: "Password must be 12–128 characters.",
      code: "invalid_password",
    });
  });

  it("passes engine sentences through", () => {
    expect(opsErrorBody("check api interval must be >= 15000ms")).toEqual({
      error: "check api interval must be >= 15000ms",
      code: "invalid",
    });
  });

  it("does not leak unknown snake_case codes as the UI string", () => {
    expect(opsErrorBody("nope").error).toMatch(/went wrong/i);
    expect(opsErrorBody("nope").code).toBe("nope");
  });
});

describe("fail", () => {
  it("writes error and code as JSON", async () => {
    const app = new Hono();
    app.get("/", (c) => fail(c, 400, "invalid_email"));
    const res = await app.request("/");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Use a valid email address.",
      code: "invalid_email",
    });
  });

  it("maps thrown codes and human Error messages", async () => {
    const app = new Hono();
    app.get("/code", (c) => failFromUnknown(c, new Error("https_required")));
    app.get("/msg", (c) => failFromUnknown(c, new Error("site.name is required")));
    expect(await (await app.request("/code")).json()).toEqual({
      error: "Use HTTPS. Plain HTTP is only enabled for localhost in local development.",
      code: "https_required",
    });
    expect(await (await app.request("/msg")).json()).toEqual({
      error: "site.name is required",
      code: "invalid",
    });
  });
});
