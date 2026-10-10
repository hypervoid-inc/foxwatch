import { describe, expect, it } from "vitest";
import {
  PUBLIC_ORIGIN_KEY,
  FOXWATCH_AVATAR_URL,
  FOXWATCH_GITHUB,
  alertOrigin,
  discordExecuteUrl,
  discordPayload,
  discordTimestamp,
  discordUsername,
  discordWebhookResourceUrl,
  formatDuration,
  isPublicOrigin,
  pngAvatarDataUri,
  rememberPublicOrigin,
  regionLine,
  type AlertBody,
  type DiscordPayloadContext,
} from "./alerts.ts";
import { opsErrorBody } from "./ops-error.ts";

const CTX: DiscordPayloadContext = {
  siteName: "Acme",
  origin: "https://status.acme.test",
  iconUrl: "/icon?v=9",
};

function base(over: Partial<AlertBody> = {}): AlertBody {
  return {
    eventId: "evt1234567890",
    event: "fail",
    componentId: "api",
    title: "api fail",
    occurredAt: Date.parse("2026-09-07T10:00:00.000Z"),
    source: "monitor",
    componentName: "Checkout API",
    componentIds: ["api"],
    checkType: "http",
    consecutiveFails: 3,
    regions: [
      { region: "wnam", outcome: "fail", latencyMs: 80, statusCode: 503, colo: "SFO", errorClass: "status" },
      { region: "weur", outcome: "fail", latencyMs: 10_000, colo: "AMS", errorClass: "timeout" },
      { region: "apac", outcome: "pass", latencyMs: 41, colo: "NRT" },
    ],
    ...over,
  };
}

function fields(body: AlertBody, ctx: DiscordPayloadContext = CTX) {
  return discordPayload(body, ctx).embeds[0]!.fields;
}

function field(body: AlertBody, name: string, ctx: DiscordPayloadContext = CTX) {
  return fields(body, ctx).find((item) => item.name === name);
}

describe("discordPayload", () => {
  it("builds a fail card with color, local timestamp, and a 3-field header", () => {
    const payload = discordPayload(base(), CTX);
    const embed = payload.embeds[0]!;
    expect(payload.content).toBeNull();
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.username).toBe("Foxwatch");
    expect(payload.avatar_url).toBe(FOXWATCH_AVATAR_URL);
    expect(payload.embeds[0]!.author).toEqual({
      name: "Acme",
      url: "https://status.acme.test",
      icon_url: "https://status.acme.test/icon?v=9",
    });
    expect(embed.title).toBe("Checkout API is down");
    expect(embed.color).toBe(0xc75c6e);
    expect(embed.timestamp).toBeUndefined();
    expect(embed.footer).toBeUndefined();
    expect(embed.fields.at(-1)).toEqual({
      name: "\u200b",
      value: "evt12345 · <t:1788775200:f> · <t:1788775200:R>",
      inline: false,
    });
    expect(embed.url).toBe("https://status.acme.test");
    expect(embed.description).toBe("Confirmed after 3 failing checks.");
    const inline = embed.fields.filter((item) => item.inline);
    expect(inline.map((item) => item.name)).toEqual(["Status", "Component", "Source"]);
    expect(inline.map((item) => item.value)).toEqual(["Outage", "Checkout API", "HTTP"]);
  });

  it("uses degrade and recover colors and titles", () => {
    expect(discordPayload(base({ event: "degrade" }), CTX).embeds[0]!.color).toBe(0xd4a04a);
    expect(discordPayload(base({ event: "degrade" }), CTX).embeds[0]!.title).toBe("Checkout API is degraded");
    const recovered = discordPayload(base({ event: "recover", durationMs: 12 * 60_000 }), CTX);
    expect(recovered.embeds[0]!.color).toBe(0x5eb89a);
    expect(recovered.embeds[0]!.title).toBe("Checkout API recovered");
    expect(recovered.embeds[0]!.description).toBe("Checks recovered.");
    expect(field(base({ event: "recover", durationMs: 12 * 60_000 }), "Duration")?.value).toBe("12m");
  });

  it("keeps Regions full-width with colo and HTTP status", () => {
    const regions = field(base(), "Regions")!;
    expect(regions.inline).toBe(false);
    expect(regions.value).toBe([
      "West NA (SFO) · HTTP 503",
      "West EU (AMS) · timeout",
      "APAC (NRT) · 41ms",
    ].join("\n"));
  });

  it("omits empty fields for test and heartbeat", () => {
    const testFields = fields(base({
      source: "test",
      title: "Test alert, delivery is configured",
      componentId: "test",
      componentName: "Test",
      componentIds: undefined,
      regions: undefined,
      checkType: undefined,
      consecutiveFails: undefined,
    }));
    expect(testFields.map((item) => item.name)).toEqual(["Status", "Component", "Source", "\u200b"]);
    expect(testFields.map((item) => item.value).slice(0, 3)).toEqual(["Outage", "Test", "Test"]);
    expect(discordPayload(base({
      source: "test",
      title: "Test alert, delivery is configured",
    }), CTX).embeds[0]!.title).toBe("Test alert, delivery is configured");

    const heartbeat = fields(base({
      checkType: "heartbeat",
      consecutiveFails: undefined,
      regions: [{ region: "global", outcome: "fail", errorClass: "heartbeat" }],
    }));
    expect(heartbeat.find((item) => item.name === "Duration")).toBeUndefined();
    expect(heartbeat.find((item) => item.name === "Source")?.value).toBe("Heartbeat");
    expect(heartbeat.find((item) => item.name === "Regions")?.value).toBe("Global · missed ping");
    expect(discordPayload(base({
      checkType: "heartbeat",
      regions: [{ region: "global", outcome: "fail", errorClass: "heartbeat" }],
    }), CTX).embeds[0]!.description).toBe("Missed heartbeat.");
  });

  it("keeps missing_secret generic and redacts snippets", () => {
    expect(regionLine({ region: "wnam", outcome: "fail", errorClass: "missing_secret", errorSnippet: "Authorization: Bearer secret-token" }))
      .toBe("West NA · failing");
    const payload = discordPayload(base({
      regions: [{
        region: "wnam",
        outcome: "fail",
        errorClass: "timeout",
        errorSnippet: "Authorization: Bearer secret-token failed",
      }],
    }), CTX);
    expect(payload.embeds[0]!.description).toContain("```");
    expect(payload.embeds[0]!.description).toContain("[redacted]");
    expect(payload.embeds[0]!.description).not.toContain("Bearer secret-token");
  });

  it("truncates oversized titles and field values", () => {
    const long = "A".repeat(400);
    const payload = discordPayload(base({ componentName: long, componentIds: ["api"] }), CTX);
    expect(payload.embeds[0]!.title.length).toBe(256);
    expect(payload.embeds[0]!.title.endsWith("…")).toBe(true);
    const bulky = field(base({
      regions: Array.from({ length: 80 }, (_, i) => ({
        region: "wnam",
        outcome: "fail" as const,
        colo: `COLO${String(i).padStart(3, "0")}`,
        errorClass: "timeout",
      })),
    }), "Regions")!;
    expect(bulky.value.length).toBe(1024);
    expect(bulky.value.endsWith("…")).toBe(true);
  });

  it("uses the incident title, update body, and incident URL", () => {
    const payload = discordPayload(base({
      source: "incident",
      title: "Payments delayed",
      updateBody: "Queues are backing up in EU.",
      incidentId: "inc99",
      componentIds: ["api", "web"],
      componentNames: ["Checkout API", "Website"],
      componentName: "Checkout API",
      regions: undefined,
      checkType: undefined,
    }), CTX);
    expect(payload.embeds[0]!.title).toBe("Payments delayed");
    expect(payload.embeds[0]!.description).toBe("Queues are backing up in EU.");
    expect(payload.embeds[0]!.url).toBe("https://status.acme.test/incidents/inc99");
    expect(payload.components).toEqual([{
      type: 1,
      components: [
        { type: 2, style: 5, label: "Open incident", url: "https://status.acme.test/incidents/inc99" },
        { type: 2, style: 5, label: "What is Foxwatch", url: FOXWATCH_GITHUB },
      ],
    }]);
    expect(field(base({
      source: "incident",
      title: "Payments delayed",
      componentIds: ["api", "web"],
      componentNames: ["Checkout API", "Website"],
      regions: undefined,
    }), "Component")?.value).toBe("Checkout API +1");
    expect(field(base({
      source: "incident",
      title: "Payments delayed",
      componentIds: ["api", "web"],
      componentNames: ["Checkout API", "Website"],
      regions: undefined,
    }), "Components")?.value).toBe("Checkout API\nWebsite");
  });

  it("still renders a valid card from a legacy 4-field body", () => {
    const payload = discordPayload({
      eventId: "legacy01abcdef",
      event: "fail",
      componentId: "api",
      title: "api fail",
    }, { siteName: "Acme" });
    expect(payload.content).toBeNull();
    expect(payload.allowed_mentions.parse).toEqual([]);
    expect(payload.embeds[0]!.title).toBe("api is down");
    expect(payload.embeds[0]!.fields.filter((item) => item.inline)).toHaveLength(3);
    expect(payload.embeds[0]!.fields.find((item) => item.name === "Regions")).toBeUndefined();
    expect(payload.embeds[0]!.url).toBeUndefined();
    expect(payload.components).toEqual([{
      type: 1,
      components: [{ type: 2, style: 5, label: "What is Foxwatch", url: FOXWATCH_GITHUB }],
    }]);
    expect(payload.avatar_url).toBe(FOXWATCH_AVATAR_URL);
    expect(payload.username).toBe("Foxwatch");
    expect(payload.embeds[0]!.author).toEqual({ name: "Acme" });
  });

  it("always uses the public fox avatar Discord can fetch", () => {
    const local = discordPayload(base(), { siteName: "Acme", origin: "http://127.0.0.1:8787" });
    expect(local.embeds[0]!.url).toBe("http://127.0.0.1:8787");
    expect(local.components?.[0]?.components.map((button) => button.label)).toEqual([
      "Open status page",
      "What is Foxwatch",
    ]);
    expect(local.avatar_url).toBe(FOXWATCH_AVATAR_URL);
    expect(discordPayload(base(), CTX).avatar_url).toBe(FOXWATCH_AVATAR_URL);
  });

  it("falls back when the site name contains discord", () => {
    expect(discordUsername("Discord Status")).toBe("Foxwatch");
    expect(discordUsername("")).toBe("Foxwatch");
    expect(discordPayload(base(), { siteName: "Clyde Bot", origin: "https://status.acme.test" }).username).toBe("Foxwatch");
    expect(discordPayload(base(), { siteName: "Clyde Bot", origin: "https://status.acme.test" }).embeds[0]!.author).toBeUndefined();
  });
});

describe("discord helpers", () => {
  it("forces wait=true on the webhook URL", () => {
    const url = discordExecuteUrl("https://discord.com/api/webhooks/1/token?wait=false", false);
    expect(new URL(url).searchParams.get("wait")).toBe("true");
    expect(new URL(url).searchParams.has("with_components")).toBe(false);
    const withButtons = discordExecuteUrl("https://discord.com/api/webhooks/1/token", true);
    expect(new URL(withButtons).searchParams.get("with_components")).toBe("true");
    expect(discordWebhookResourceUrl("https://discord.com/api/webhooks/1/token?wait=true")).toBe(
      "https://discord.com/api/webhooks/1/token",
    );
  });

  it("formats Discord unix timestamps", () => {
    expect(discordTimestamp(Date.parse("2026-09-07T10:00:00.000Z"), "R")).toBe("<t:1788775200:R>");
    expect(discordTimestamp(Date.parse("2026-09-07T10:00:00.000Z"), "f")).toBe("<t:1788775200:f>");
  });

  it("encodes the shipped fox PNG as Discord image data", async () => {
    const { readFileSync } = await import("node:fs");
    const bytes = new Uint8Array(readFileSync(new URL("../../../../public/fox.png", import.meta.url)));
    const uri = pngAvatarDataUri(bytes);
    expect(uri?.startsWith("data:image/png;base64,")).toBe(true);
    expect((uri?.length ?? 0) > 64).toBe(true);
    expect(pngAvatarDataUri(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("formats durations", () => {
    expect(formatDuration(1_500)).toBe("2s");
    expect(formatDuration(12 * 60_000)).toBe("12m");
    expect(formatDuration(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(formatDuration(2 * 86_400_000)).toBe("2d");
  });

  it("accepts http(s) origins only", () => {
    expect(isPublicOrigin("https://status.acme.test")).toBe(true);
    expect(isPublicOrigin("javascript:alert(1)")).toBe(false);
  });

  it("writes origin:public when it changes", async () => {
    const store = new Map<string, string>();
    const env = {
      STATUS: {
        get: async (key: string) => store.get(key) ?? null,
        put: async (key: string, value: string) => { store.set(key, value); },
      },
    } as never;
    await rememberPublicOrigin(env, "https://status.acme.test");
    expect(store.get(PUBLIC_ORIGIN_KEY)).toBe("https://status.acme.test");
    await rememberPublicOrigin(env, "https://status.acme.test");
    await rememberPublicOrigin(env, "not-a-url");
    expect(store.get(PUBLIC_ORIGIN_KEY)).toBe("https://status.acme.test");
  });
});

describe("alert link origin", () => {
  function kv(initial?: string) {
    const store = new Map<string, string>(initial ? [[PUBLIC_ORIGIN_KEY, initial]] : []);
    const calls = { get: 0, put: 0 };
    const env = {
      STATUS: {
        get: async (key: string) => { calls.get++; return store.get(key) ?? null; },
        put: async (key: string, value: string) => { calls.put++; store.set(key, value); },
      },
    } as never;
    return { env, store, calls };
  }

  it("prefers the configured public URL, then the admin request, then the remembered origin", async () => {
    const { env } = kv("https://foxwatch.acct.workers.dev");
    expect(await alertOrigin(env, "https://status.acme.test", "https://foxwatch.acct.workers.dev")).toBe("https://status.acme.test");
    expect(await alertOrigin(env, null, "https://admin.acme.test")).toBe("https://admin.acme.test");
    expect(await alertOrigin(env, null)).toBe("https://foxwatch.acct.workers.dev");
    expect(await alertOrigin(kv().env, null)).toBeNull();
    expect(await alertOrigin(kv().env, "javascript:alert(1)", "not-a-url")).toBeNull();
  });

  it("links a card to the origin the caller resolved, over the one in the event", () => {
    const card = discordPayload(base({ publicOrigin: "https://foxwatch.acct.workers.dev" }), CTX);
    expect(card.embeds[0]!.url).toBe("https://status.acme.test");
    const fallback = discordPayload(base({ publicOrigin: "https://foxwatch.acct.workers.dev" }), { siteName: "Acme" });
    expect(fallback.embeds[0]!.url).toBe("https://foxwatch.acct.workers.dev");
  });

  it("reads KV once per isolate while the origin stays the same", async () => {
    const { env, store, calls } = kv();
    await rememberPublicOrigin(env, "https://status.acme.test");
    await rememberPublicOrigin(env, "https://status.acme.test");
    await rememberPublicOrigin(env, "https://status.acme.test");
    expect(calls).toEqual({ get: 1, put: 1 });
    await rememberPublicOrigin(env, "https://other.acme.test");
    expect(store.get(PUBLIC_ORIGIN_KEY)).toBe("https://other.acme.test");
    expect(calls).toEqual({ get: 2, put: 2 });
  });
});

describe("delivery_failed copy", () => {
  it("does not blame the queue for a direct delivery failure", () => {
    expect(opsErrorBody("delivery_failed")).toEqual({
      error: "The alert could not be delivered. Check the webhook URL secret and try again.",
      code: "delivery_failed",
    });
    expect(opsErrorBody("delivery").error).toMatch(/queue is not available/);
  });
});
