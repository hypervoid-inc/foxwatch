import { describe, expect, it } from "vitest";
import { http, isReservedSecretName, secret, type Check } from "@foxwatch/config";
import { envSecret, type Env } from "../env.ts";
import { isResolvableSecret, secretNamesFromCheck, secretRefError } from "./secret-policy.ts";

const ref = (name: string) => ({ __foxwatch_secret__: name });

function check(id: string, url: string, headers: Record<string, unknown>, allowedHosts?: string[]): Check {
  return http(id, { url, allowedHosts, headers: headers as Record<string, string> });
}

describe("reserved secret names", () => {
  it("covers Foxwatch's own Worker bindings only", () => {
    for (const name of ["ALLOW_HTTP_LOCAL", "FOXWATCH_CF_API_TOKEN", "FOXWATCH_CF_ACCOUNT_ID", "FOXWATCH_CF_SCRIPT_NAME", "FOXWATCH_SETUP_TOKEN"]) {
      expect(isReservedSecretName(name)).toBe(true);
    }
    expect(isReservedSecretName("API_TOKEN")).toBe(false);
    expect(isReservedSecretName("FOXWATCH_DISCORD_WEBHOOK_URL")).toBe(false);
    expect(() => secret("FOXWATCH_CF_API_TOKEN")).toThrow(/reserved/);
  });

  it("never reads a reserved or malformed binding", () => {
    const env = { FOXWATCH_CF_API_TOKEN: "cf-token", ALLOW_HTTP_LOCAL: "true", API_TOKEN: "abc", DB: "not-a-secret" } as unknown as Env;
    expect(envSecret(env, "API_TOKEN")).toBe("abc");
    expect(envSecret(env, "FOXWATCH_CF_API_TOKEN")).toBeUndefined();
    expect(envSecret(env, "ALLOW_HTTP_LOCAL")).toBeUndefined();
    expect(envSecret(env, "constructor")).toBeUndefined();
    expect(envSecret(env, "MISSING")).toBeUndefined();
  });
});

describe("isResolvableSecret", () => {
  it("resolves only registered, well-formed, non-reserved names", () => {
    expect(isResolvableSecret("API_TOKEN", ["API_TOKEN"])).toBe(true);
    expect(isResolvableSecret("SLACK_WEBHOOK_URL", ["API_TOKEN"])).toBe(false);
    expect(isResolvableSecret("FOXWATCH_CF_API_TOKEN", ["FOXWATCH_CF_API_TOKEN"])).toBe(false);
    expect(isResolvableSecret("api_token", ["api_token"])).toBe(false);
  });
});

describe("secretRefError", () => {
  const existing = [
    check("api", "https://api.example.com/health", { Authorization: ref("API_TOKEN") }, ["api.example.com", "auth.example.com"]),
    check("plain", "https://attacker.example/", {}),
  ];
  const registered = ["API_TOKEN", "SLACK_WEBHOOK_URL"];

  it("lists each referenced name once", () => {
    expect(secretNamesFromCheck(check("a", "https://api.example.com", { A: ref("API_TOKEN"), B: ref("API_TOKEN"), C: "x" }))).toEqual(["API_TOKEN"]);
  });

  it("lets an admin keep or copy a request that already carries the secret", () => {
    const same = check("api-2", "https://api.example.com/health", { authorization: ref("API_TOKEN") }, ["auth.example.com", "API.example.com"]);
    expect(secretRefError(same, { role: "admin", registered, existing })).toBeNull();
    // Everything that is not part of the request stays editable.
    const retimed = { ...existing[0]!, id: "api", name: "Renamed", intervalMs: 300_000, retries: 0, critical: true } as Check;
    expect(secretRefError(retimed, { role: "admin", registered, existing })).toBeNull();
    expect(secretRefError(check("none", "https://attacker.example/", { Accept: "text/html" }), { role: "admin", registered, existing })).toBeNull();
  });

  it("stops an admin sending a secret to a new host", () => {
    const direct = check("leak", "https://attacker.example/x", { "X-A": ref("API_TOKEN") });
    expect(secretRefError(direct, { role: "admin", registered, existing })).toBe("secret_request");
    const widened = check("leak", "https://api.example.com/health", { Authorization: ref("API_TOKEN") }, ["api.example.com", "auth.example.com", "attacker.example"]);
    expect(secretRefError(widened, { role: "admin", registered, existing })).toBe("secret_request");
    // Registered for alerts, never used in a check: no request vouches for it.
    const webhook = check("leak", "https://api.example.com/health", { Authorization: ref("SLACK_WEBHOOK_URL") }, ["api.example.com", "auth.example.com"]);
    expect(secretRefError(webhook, { role: "admin", registered, existing })).toBe("secret_request");
  });

  it("stops an admin spending a secret on another request to a trusted host", () => {
    const hosts = ["api.example.com", "auth.example.com"];
    const base = existing[0] as Extract<Check, { type: "http" }>;
    const denied = (next: Check) => expect(secretRefError(next, { role: "admin", registered, existing })).toBe("secret_request");
    denied(check("leak", "https://api.example.com/repos/org/private/contents/.env", { Authorization: ref("API_TOKEN") }, hosts));
    denied(check("leak", "https://api.example.com/health?all=1", { Authorization: ref("API_TOKEN") }, hosts));
    denied(check("leak", "https://auth.example.com/health", { Authorization: ref("API_TOKEN") }, hosts));
    denied({ ...base, method: "POST" });
    denied({ ...base, body: "{\"delete\":true}" });
    denied(check("leak", "https://api.example.com/health", { "X-Other": ref("API_TOKEN") }, hosts));
    denied(check("leak", "https://api.example.com/health", { Authorization: ref("API_TOKEN"), "X-HTTP-Method-Override": "DELETE" }, hosts));
  });

  it("stops an admin naming a secret nobody registered", () => {
    const next = check("leak", "https://api.example.com/", { "X-A": ref("OTHER_WORKER_SECRET") });
    expect(secretRefError(next, { role: "admin", registered, existing })).toBe("secret_unknown");
  });

  it("leaves superadmins free to introduce a secret or a host", () => {
    const next = check("new", "https://new.example.com/", { "X-A": ref("NEW_TOKEN") });
    expect(secretRefError(next, { role: "superadmin", registered, existing })).toBeNull();
  });
});
