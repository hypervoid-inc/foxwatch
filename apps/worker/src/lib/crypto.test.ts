import { describe, expect, it } from "vitest";
import { tokenEquals, sha256Hex } from "./crypto.ts";
import { publicSnapshot } from "@foxwatch/engine";

describe("ops token compare", () => {
  it("rejects missing and mismatched tokens", async () => {
    expect(await tokenEquals("a", "")).toBe(false);
    expect(await tokenEquals("guess", "expected_secret")).toBe(false);
    expect(await tokenEquals("same", "same")).toBe(true);
  });

  it("hashes heartbeat tokens", async () => {
    const hex = await sha256Hex("token");
    expect(hex).toHaveLength(64);
    expect(hex).not.toContain("token");
  });
});

describe("public snapshot shape", () => {
  it("does not include check urls, headers, or error bodies", () => {
    const snap = publicSnapshot({
      siteName: "Acme",
      homepageUrl: null,
      iconUrl: null,
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [
        {
          id: "g",
          name: "G",
          uptime90: 1,
          components: [
            {
              id: "c",
              name: "C",
              groupId: "g",
              groupName: "G",
              status: "operational",
              uptime90: 1,
              days: [],
            },
          ],
        },
      ],
      incidents: [],
    });
    const json = JSON.stringify(snap);
    expect(JSON.stringify(snap.groups)).not.toMatch(/https?:\/\//);
    expect(json.toLowerCase()).not.toContain("authorization");
    expect(json).not.toContain("errorSnippet");
    expect(snap.groups[0]?.components[0]).not.toHaveProperty("url");
  });

  it("keeps a public homepage url on the snapshot", () => {
    const snap = publicSnapshot({
      siteName: "Acme",
      homepageUrl: "https://construct.com/",
      iconUrl: "/icon?v=1",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
    });
    expect(snap.homepageUrl).toBe("https://construct.com/");
    expect(snap.iconUrl).toBe("/icon?v=1");
  });
});

describe("public html", () => {
  it("renders the operational banner and system card without a subscribe CTA", async () => {
    const { renderPublicHtml } = await import("./public-html.ts");
    const days = Array.from({ length: 3 }, (_, i) => ({
      date: `2026-08-${String(i + 10).padStart(2, "0")}`,
      uptime: 1,
      incident: false,
      checks: null,
      latencyMs: null,
      latencyMinMs: null,
      latencyMaxMs: null,
    }));
    const html = renderPublicHtml({
      siteName: "Acme",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [
        {
          id: "website",
          name: "Website",
          uptime90: 1,
          components: [
            {
              id: "homepage",
              name: "Homepage",
              groupId: "website",
              groupName: "Website",
              status: "operational",
              uptime90: 1,
              days,
            },
          ],
        },
      ],
      incidents: [],
    });
    expect(html).toContain("We&#39;re fully operational.");
    expect(html).toContain("System status");
    expect(html).not.toContain("Subscribe");
    expect(html).not.toContain('href="/feed.xml"');
    expect(html).toContain("No incidents");
    expect(html).toContain('id="live-banner"');
    expect(html).toContain('id="live-systems"');
    expect(html).toContain('id="live-history"');
    expect(html).toContain('new WebSocket');
    expect(html).toContain("/live");
    expect(html).not.toMatch(/https?:\/\/example\.com/);
  });

  it("varies tick height by latency and keeps empty days short", async () => {
    const { renderPublicHtml, tickHeightPct, latencyAxisX } = await import("./public-html.ts");
    expect(tickHeightPct(null, 200)).toBe(22);
    expect(tickHeightPct(200, 200, true)).toBe(100);
    expect(tickHeightPct(50, 200, true)).toBe(52);
    expect(tickHeightPct(null, 200, true)).toBe(36);
    expect(latencyAxisX(0, 100)).toBe(8);
    expect(latencyAxisX(100, 100)).toBe(92);
    expect(latencyAxisX(50, 100)).toBe(50);

    const html = renderPublicHtml({
      siteName: "Acme",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [
        {
          id: "api",
          name: "API",
          uptime90: 1,
          components: [
            {
              id: "edge",
              name: "API",
              groupId: "api",
              groupName: "API",
              status: "operational",
              uptime90: 1,
              days: [
                {
                  date: "2026-08-10",
                  uptime: null,
                  incident: false,
                  checks: null,
                  latencyMs: null,
                  latencyMinMs: null,
                  latencyMaxMs: null,
                },
                {
                  date: "2026-08-11",
                  uptime: 1,
                  incident: false,
                  checks: 4,
                  latencyMs: 50,
                  latencyMinMs: 40,
                  latencyMaxMs: 80,
                },
                {
                  date: "2026-08-12",
                  uptime: 1,
                  incident: false,
                  checks: 12,
                  latencyMs: 200,
                  latencyMinMs: 90,
                  latencyMaxMs: 890,
                },
              ],
            },
          ],
        },
      ],
      incidents: [],
    });
    expect(html).toContain('style="--h:22%"');
    expect(html).toContain('style="--h:52%"');
    expect(html).toContain('style="--h:100%"');
    expect(html).toContain("<b>4</b> checks");
    expect(html).toContain("<b>12</b> checks");
    expect(html).toContain('class="tip-lat"');
    expect(html).toContain("min 40ms, avg 50ms, max 80ms");
    expect(html).toContain("min 90ms, avg 200ms, max 890ms");
    expect(html).toContain('class="tip-lat-mark min"');
    expect(html).toContain('class="tip-lat-mark avg"');
    expect(html).toContain('class="tip-lat-mark max"');
    expect(html).toContain('class="tick"');
    expect(html).not.toContain("50ms avg");
  });

  it("uses details for multi-component groups and keeps maintenance distinct from degraded", async () => {
    const { renderPublicHtml } = await import("./public-html.ts");
    const days = [
      {
        date: "2026-08-10",
        uptime: 1,
        incident: false,
        checks: null,
        latencyMs: null,
        latencyMinMs: null,
        latencyMaxMs: null,
      },
    ];
    const html = renderPublicHtml({
      siteName: "Acme",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [
        {
          id: "api",
          name: "API",
          uptime90: 1,
          components: [
            {
              id: "edge",
              name: "Edge",
              groupId: "api",
              groupName: "API",
              status: "maintenance",
              uptime90: 1,
              days,
            },
            {
              id: "core",
              name: "Core",
              groupId: "api",
              groupName: "API",
              status: "operational",
              uptime90: 1,
              days,
            },
          ],
        },
      ],
      incidents: [],
    });
    expect(html).toContain("<details>");
    expect(html).toContain("<summary");
    expect(html).toContain('class="chev"');
    expect(html).toContain("2 components");
    expect(html).toMatch(/<span class="count">2 components<\/span><svg class="chev"/);
    expect(html).toContain("group-bar");
    expect(html).toContain("details[open] ~ .group-bar { display: none; }");
    expect(html.match(/class="bar/g)?.length).toBe(3);
    expect(html).not.toContain('class="svc-toggle"');
    expect(html).toContain("Under maintenance");
    expect(html).toContain("Scheduled maintenance is in progress on some systems.");
    expect(html).toContain("We&#39;re fully operational.");
  });

  it("keeps a stable live etag when only generatedAt changes", async () => {
    const { snapshotEtag, renderLivePayload } = await import("./public-html.ts");
    const base = {
      siteName: "Acme",
      banner: "fully_operational" as const,
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [
        {
          id: "api",
          name: "API",
          uptime90: 1,
          components: [
            {
              id: "edge",
              name: "API",
              groupId: "api",
              groupName: "API",
              status: "operational" as const,
              uptime90: 1,
              days: [
                {
                  date: "2026-08-10",
                  uptime: 1,
                  incident: false,
                  checks: 3,
                  latencyMs: 40,
                  latencyMinMs: 20,
                  latencyMaxMs: 80,
                },
              ],
            },
          ],
        },
      ],
      incidents: [],
    };
    const a = snapshotEtag(base);
    const b = snapshotEtag({ ...base, generatedAt: 99 });
    const c = snapshotEtag({ ...base, banner: "degraded" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const live = renderLivePayload(base);
    expect(live.etag).toBe(a);
    expect(live.banner).toContain("id=\"live-banner\"");
    expect(live.systems).toContain("data-group=\"api\"");
  });
});

describe("worker path routing", () => {
  it("keeps public and admin routes on the worker and sends Vite modules to assets", async () => {
    const { isWorkerPath } = await import("./routes.ts");
    expect(isWorkerPath("/")).toBe(true);
    expect(isWorkerPath("/admin")).toBe(true);
    expect(isWorkerPath("/admin/incidents")).toBe(true);
    expect(isWorkerPath("/ops")).toBe(true);
    expect(isWorkerPath("/ops/monitors")).toBe(true);
    expect(isWorkerPath("/api/ops/overview")).toBe(true);
    expect(isWorkerPath("/api/status.json")).toBe(true);
    expect(isWorkerPath("/badge.svg")).toBe(true);
    expect(isWorkerPath("/feed.xml")).toBe(true);
    expect(isWorkerPath("/icon")).toBe(true);
    expect(isWorkerPath("/live")).toBe(true);
    expect(isWorkerPath("/apps/web/src/main.tsx")).toBe(false);
    expect(isWorkerPath("/@vite/client")).toBe(false);
    expect(isWorkerPath("/@react-refresh")).toBe(false);
    expect(isWorkerPath("/assets/index.js")).toBe(false);
  });
});

describe("public brand", () => {
  it("defaults the header to the status page and the fox mark", async () => {
    const { renderPublicHtml } = await import("./public-html.ts");
    const html = renderPublicHtml({
      siteName: "Acme",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
    });
    expect(html).toContain('class="brand" href="/"');
    expect(html).toContain('class="brand-name"');
    expect(html).toContain('class="fox" src="/fox.png"');
    expect(html).toContain('rel="icon" href="/fox.png"');
    expect(html).toContain('class="foot-fox" src="/fox.png"');
    expect(html).toContain("Powered by Foxwatch");
    expect(html).toContain("fileDrag");
    expect(html).toContain("foxwatch-theme");
    expect(html).toContain('class="theme-toggle"');
    expect(html).toContain("theme-icon-moon");
    expect(html).toContain("theme-icon-sun");
    expect(html).toContain("theme-ready");
    expect(html).not.toContain(">Dark</button>");
    expect(html).not.toContain("b.textContent=");
    expect(html).toContain("nth-child(-n+24)");
    expect(html).toContain(".nested-inner { min-height: 0; }");
    expect(html).not.toContain("grid-template-rows");
    expect(html).toContain("::details-content");
    expect(html).toContain("interpolate-size: allow-keywords");
    expect(html).toContain("--duration-panel: 200ms");
    expect(html).toContain("is-restoring");
    expect(html).toContain('<header class="top">');
    expect(html).toContain('id="live-brand"');
    expect(html).toContain('data-banner="fully_operational"');
    expect(html).toContain("setStatusFavicon");
    expect(html).toContain("clipSquircle");
    expect(html).toContain("icon=50");
    expect(html).toContain("#0f9d7a");
    expect(html).not.toContain('class="site-icon"');
    const { renderLivePayload } = await import("./public-html.ts");
    const live = renderLivePayload({
      siteName: "Acme",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
    });
    expect(live.brand).toContain('id="live-brand"');
    expect(live.brand).not.toContain("theme-toggle");
    expect(live.status).toBe("fully_operational");
    expect(live.icon).toBe("/fox.png");
  });

  it("points the header at the homepage and uses the uploaded icon", async () => {
    const { renderPublicHtml, renderLivePayload } = await import("./public-html.ts");
    const snap = {
      siteName: "Acme",
      homepageUrl: "https://construct.com/",
      iconUrl: "/icon?v=9",
      banner: "fully_operational" as const,
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
    };
    const html = renderPublicHtml(snap);
    expect(html).toContain('href="https://construct.com/"');
    expect(html).toContain('src="/icon?v=9"');
    expect(html).toContain('rel="icon" href="/icon?v=9"');
    expect(html).toContain('class="foot-fox" src="/fox.png"');
    expect(html).toContain("Powered by Foxwatch");
    expect(html).not.toContain('class="fox"');
    const live = renderLivePayload(snap);
    expect(live.icon).toBe("/icon?v=9");
    expect(live.status).toBe("fully_operational");
    expect(live.brand).toContain('href="https://construct.com/"');
  });

  it("paints the tab icon from the current banner", async () => {
    const { renderPublicHtml, renderLivePayload } = await import("./public-html.ts");
    const snap = {
      siteName: "Acme",
      banner: "failing" as const,
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
    };
    const html = renderPublicHtml(snap);
    expect(html).toContain('data-banner="failing"');
    expect(html).toContain("#e11d48");
    expect(html).toContain("#d97706");
    expect(renderLivePayload(snap).status).toBe("failing");
  });
});

describe("site settings helpers", () => {
  it("accepts http(s) homepages and rejects other schemes", async () => {
    const { parseHomepageUrl } = await import("@foxwatch/engine");
    expect(parseHomepageUrl("")).toBe(null);
    expect(parseHomepageUrl("  ")).toBe(null);
    expect(parseHomepageUrl("https://construct.com/app")).toBe("https://construct.com/app");
    expect(() => parseHomepageUrl("javascript:alert(1)")).toThrow();
    expect(() => parseHomepageUrl("https://user:pass@evil.example/")).toThrow();
  });

  it("sniffs icon bytes by magic, not the filename", async () => {
    const { sniffIconMime } = await import("./crypto.ts");
    expect(sniffIconMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffIconMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffIconMime(new Uint8Array([0x00, 0x00, 0x01, 0x00]))).toBe("image/x-icon");
    expect(sniffIconMime(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe(null);
  });
});

describe("audit log pages", () => {
  it("defaults limit to 100 and clamps to 1–100", async () => {
    const { parseAuditLimit } = await import("./audit-page.ts");
    expect(parseAuditLimit(undefined)).toBe(100);
    expect(parseAuditLimit("")).toBe(100);
    expect(parseAuditLimit("nope")).toBe(100);
    expect(parseAuditLimit("50")).toBe(50);
    expect(parseAuditLimit("1")).toBe(1);
    expect(parseAuditLimit("0")).toBe(100);
    expect(parseAuditLimit("500")).toBe(100);
  });

  it("round-trips a createdAt+id cursor and rejects junk", async () => {
    const { encodeAuditCursor, parseAuditCursor } = await import("./audit-page.ts");
    const cursor = encodeAuditCursor({ createdAt: 1_700_000_000_123, id: "abc_-0123456789XYZ" });
    expect(parseAuditCursor(cursor)).toEqual({ createdAt: 1_700_000_000_123, id: "abc_-0123456789XYZ" });
    expect(parseAuditCursor(undefined)).toBe(null);
    expect(parseAuditCursor("")).toBe(null);
    expect(parseAuditCursor("not-a-cursor")).toBe("invalid");
    expect(parseAuditCursor("12:")).toBe("invalid");
  });

  it("returns a next cursor only when a fuller page exists, then older rows", async () => {
    const { auditPageFromRows, olderThanAuditCursor, parseAuditCursor } = await import("./audit-page.ts");
    const rows = [
      { id: "c", createdAt: 30 },
      { id: "b", createdAt: 20 },
      { id: "a", createdAt: 10 },
    ];
    const first = auditPageFromRows(rows.slice(0, 3), 2);
    expect(first.entries.map((e) => e.id)).toEqual(["c", "b"]);
    expect(first.nextCursor).toBeTruthy();
    const cursor = parseAuditCursor(first.nextCursor ?? undefined);
    expect(cursor).not.toBe("invalid");
    expect(cursor).not.toBe(null);
    if (cursor === "invalid" || cursor === null) return;
    const rest = rows.filter((row) => olderThanAuditCursor(row, cursor));
    expect(rest.map((e) => e.id)).toEqual(["a"]);
    const second = auditPageFromRows(rest, 2);
    expect(second.entries.map((e) => e.id)).toEqual(["a"]);
    expect(second.nextCursor).toBeNull();
  });
});
