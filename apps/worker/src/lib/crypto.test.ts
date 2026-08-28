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
    expect(snap.globe).toBe(true);
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
    expect(snap.globe).toBe(true);
  });

  it("keeps globe off when the snapshot asks", () => {
    const snap = publicSnapshot({
      siteName: "Acme",
      homepageUrl: null,
      iconUrl: null,
      globe: false,
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
    });
    expect(snap.globe).toBe(false);
  });

  it("copies region impact onto the public snapshot", () => {
    const snap = publicSnapshot({
      siteName: "Acme",
      homepageUrl: null,
      iconUrl: null,
      banner: "degraded",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [
        {
          id: "g",
          name: "Inference Gateway",
          uptime90: 1,
          impact: {
            all: false,
            items: [
              { region: "apac", label: "APAC", detail: "12082ms", outcome: "degraded" },
              { region: "enam", label: "East NA", detail: "11920ms", outcome: "degraded" },
            ],
          },
          components: [
            {
              id: "c",
              name: "Inference Gateway",
              groupId: "g",
              groupName: "Inference Gateway",
              status: "degraded",
              uptime90: 1,
              days: [],
              impact: {
                all: false,
                items: [{ region: "apac", label: "APAC", detail: "12082ms", outcome: "degraded" }],
              },
            },
          ],
        },
      ],
      incidents: [],
    });
    expect(snap.groups[0]?.impact?.all).toBe(false);
    expect(snap.groups[0]?.impact?.items).toEqual([
      { region: "apac", label: "APAC", detail: "12082ms", outcome: "degraded" },
      { region: "enam", label: "East NA", detail: "11920ms", outcome: "degraded" },
    ]);
    expect(snap.groups[0]?.components[0]?.impact?.items[0]?.detail).toBe("12082ms");
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
    expect(html).toContain('id="live-mesh"');
    expect(html).toContain('id="live-history"');
    expect(html).toContain('new WebSocket');
    expect(html).toContain("/live");
    expect(html).toContain("/api/here.json");
    expect(html).toContain('id="globe-stage"');
    expect(html).toContain('id="globe-land"');
    expect(html).toContain("__fwGlobe");
    expect(html).toContain("overflow-x: hidden");
    expect(html).toMatch(/status-globe\/main\.ts|\/assets\/globe\.js/);
    expect(html).toContain('type="module"');
    expect(html).not.toMatch(/jsdelivr|unpkg|cdnjs|cdn\./i);
    expect(html).not.toContain("From the edge");
    expect(html).not.toMatch(/https?:\/\/example\.com/);
  });

  it("omits globe assets when the snapshot disables the globe", async () => {
    const { renderPublicHtml } = await import("./public-html.ts");
    const html = renderPublicHtml({
      siteName: "Acme",
      globe: false,
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
      observers: [
        {
          region: "weur",
          label: "West EU",
          title: "West Europe",
          colo: "LHR",
          outcome: "pass",
          latencyMs: 80,
          checkedAt: 1,
        },
      ],
    });
    expect(html).toContain("From the edge");
    expect(html).toContain('id="live-mesh"');
    expect(html).not.toContain('id="globe-stage"');
    expect(html).not.toContain('id="globe-land"');
    expect(html).not.toContain("envelope=1.16");
    expect(html).not.toContain("status-globe");
    expect(html).not.toContain("/assets/globe.js");
    expect(html).not.toContain("fw-globe-gpu");
    expect(html).toMatch(/body:has\(#globe-stage\) #live-mesh\.mesh \{ display: none; \}/);
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
    expect(live.mesh).toContain('id="live-mesh"');
    const withObs = snapshotEtag({
      ...base,
      observers: [
        {
          region: "wnam",
          label: "West NA",
          title: "West North America",
          colo: "SJC",
          outcome: "pass",
          latencyMs: 40,
          checkedAt: 1,
        },
      ],
    });
    expect(withObs).not.toBe(a);
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
    expect(isWorkerPath("/api/here.json")).toBe(true);
    expect(isWorkerPath("/badge.svg")).toBe(true);
    expect(isWorkerPath("/feed.xml")).toBe(true);
    expect(isWorkerPath("/icon")).toBe(true);
    expect(isWorkerPath("/live")).toBe(true);
    expect(isWorkerPath("/apps/web/src/main.tsx")).toBe(false);
    expect(isWorkerPath("/@vite/client")).toBe(false);
    expect(isWorkerPath("/@react-refresh")).toBe(false);
    expect(isWorkerPath("/assets/index.js")).toBe(false);
    expect(isWorkerPath("/apps/web/src/status-globe/main.ts")).toBe(false);
    expect(isWorkerPath("/assets/globe.js")).toBe(false);
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

describe("region impact html", () => {
  it("renders pills for impacted regions and All when every region is down", async () => {
    const { renderPublicHtml } = await import("./public-html.ts");
    const days = [
      {
        date: "2026-08-10",
        uptime: 1,
        incident: false,
        checks: 1,
        latencyMs: 100,
        latencyMinMs: 100,
        latencyMaxMs: 100,
      },
    ];
    const partial = renderPublicHtml({
      siteName: "Acme",
      banner: "degraded",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [
        {
          id: "gw",
          name: "Inference Gateway",
          uptime90: 1,
          impact: {
            all: false,
            items: [
              { region: "apac", label: "APAC", detail: "12082ms", outcome: "degraded" },
              { region: "enam", label: "East NA", detail: "11920ms", outcome: "degraded" },
            ],
          },
          components: [
            {
              id: "gw",
              name: "Inference Gateway",
              groupId: "gw",
              groupName: "Inference Gateway",
              status: "degraded",
              uptime90: 1,
              days,
              impact: {
                all: false,
                items: [
                  { region: "apac", label: "APAC", detail: "12082ms", outcome: "degraded" },
                  { region: "enam", label: "East NA", detail: "11920ms", outcome: "degraded" },
                ],
              },
            },
          ],
        },
      ],
      incidents: [],
    });
    expect(partial).toContain('class="impact"');
    expect(partial).toContain('data-region="apac"');
    expect(partial).toContain("APAC");
    expect(partial).toContain("12082ms");
    expect(partial).toContain("East NA");
    expect(partial).toContain("11920ms");
    expect(partial).toContain("Degraded in APAC 12082ms, East NA 11920ms");
    expect(partial).not.toContain(">All<");

    const all = renderPublicHtml({
      siteName: "Acme",
      banner: "degraded",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [
        {
          id: "gw",
          name: "Inference Gateway",
          uptime90: 1,
          impact: {
            all: true,
            items: [
              { region: "wnam", label: "West NA", detail: "9000ms", outcome: "degraded" },
              { region: "weur", label: "West EU", detail: "timeout", outcome: "fail" },
            ],
          },
          components: [
            {
              id: "gw",
              name: "Inference Gateway",
              groupId: "gw",
              groupName: "Inference Gateway",
              status: "failing",
              uptime90: 1,
              days,
              impact: {
                all: true,
                items: [
                  { region: "wnam", label: "West NA", detail: "9000ms", outcome: "degraded" },
                  { region: "weur", label: "West EU", detail: "timeout", outcome: "fail" },
                ],
              },
            },
          ],
        },
      ],
      incidents: [],
    });
    expect(all).toContain(">All<");
    expect(all).toContain("Failing in all regions");
    expect(all).toContain('title="West NA 9000ms · West EU timeout"');
    expect(all).not.toMatch(/class="impact-pill[^"]*">West NA/);
  });
});

describe("edge mesh html", () => {
  it("draws observer nodes and hides the card when there are none", async () => {
    const { renderPublicHtml, renderLivePayload } = await import("./public-html.ts");
    const withObs = renderPublicHtml({
      siteName: "Acme",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
      observers: [
        {
          region: "wnam",
          label: "West NA",
          title: "West North America",
          colo: "SJC",
          outcome: "pass",
          latencyMs: 42,
          checkedAt: 1,
        },
        {
          region: "apac",
          label: "APAC",
          title: "Asia Pacific",
          colo: "SIN",
          outcome: "degraded",
          latencyMs: 900,
          checkedAt: 1,
        },
      ],
    });
    expect(withObs).toContain("From the edge");
    expect(withObs).toContain('class="mesh-plot"');
    expect(withObs).toContain('class="mesh-ocean"');
    expect(withObs).toContain("color-mix(in srgb, var(--empty) 72%, var(--line) 28%)");
    expect(withObs).toContain(".mesh-ocean { fill: var(--card); }");
    expect(withObs).toContain("#live-mesh.mesh { display: none; }");
    expect(withObs).toContain("--globe-left");
    expect(withObs).toContain("overflow-y: scroll");
    expect(withObs).toContain("scrollbar-gutter: stable");
    expect(withObs).toContain("envelope=1.16");
    expect(withObs).toContain("--globe-cx");
    expect(withObs).toContain("--globe-cy");
    expect(withObs).toContain("globe-focus");
    expect(withObs).toContain("globe-settle");
    expect(withObs).toContain("blur(12px)");
    expect(withObs).toContain("scale(0.97)");
    expect(withObs).toContain("--duration-enter: 700ms");
    expect(withObs).toContain("globe-focus var(--duration-enter) linear both");
    expect(withObs).toContain("__fwRevealGlobe");
    expect(withObs).toContain("is-ready");
    expect(withObs).toContain("calc((100% - var(--max)) / 2)");
    expect(withObs).toContain('class="mesh-node ok has-ring"');
    expect(withObs).toContain('class="mesh-node warn has-ring"');
    expect(withObs).toContain('data-region="wnam"');
    expect(withObs).toContain("West North America · SJC · 42ms");
    expect(withObs).toContain("1 region degraded");
    expect(withObs).toContain('class="mesh-arc"');
    expect(withObs).toContain('class="mesh-you"');
    expect(withObs).toContain("bindMesh");
    expect(withObs).toContain('id="globe-stage"');
    expect(withObs).toContain("canvas.globe-labels");
    expect(withObs).toContain("z-index: 20");
    expect(withObs).toContain("inset: 0");
    expect(withObs).toContain("nearGlobe");
    expect(withObs).toContain("drawFacets");
    expect(withObs).toContain("drawTag");
    expect(withObs).toContain("spinning");
    expect(withObs).toContain("IDLE_MS=1000");
    expect(withObs).toContain("SPIN_IN_MS=1200");
    expect(withObs).toContain("SPIN_OUT_MS=420");
    expect(withObs).toContain("spinT");
    expect(withObs).toContain("spinEase");
    expect(withObs).toContain("strokeHop");
    expect(withObs).toContain("HOP_STEPS");
    expect(withObs).toContain('id="globe-land"');
    expect(withObs).toContain('class="mesh-sr"');
    expect(withObs).toContain("__fwGlobe");
    expect(withObs).toContain("__fwPickRegion");
    expect(withObs).toContain("__fwGpuGlobe");
    expect(withObs).toContain("fw-globe-gpu");
    expect(withObs).toContain("fw-globe-fallback");
    expect(withObs).toMatch(/status-globe\/main\.ts|\/assets\/globe\.js/);
    expect(withObs).toContain('script type="module"');
    expect(withObs).not.toMatch(/jsdelivr|unpkg|cdnjs|cdn\./i);
    expect(withObs).toMatch(/<script type="application\/json" id="globe-land">\[\[/);
    expect(JSON.parse(withObs.slice(
      withObs.indexOf(">", withObs.indexOf('id="globe-land"')) + 1,
      withObs.indexOf("</script>", withObs.indexOf('id="globe-land"')),
    ))).toEqual(expect.any(Array));
    expect(renderLivePayload({
      siteName: "Acme",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
      observers: [
        {
          region: "weur",
          label: "West EU",
          title: "West Europe",
          colo: "LHR",
          outcome: "pass",
          latencyMs: 80,
          checkedAt: 1,
        },
      ],
    }).mesh).toContain("From the edge");
    const { renderHistoryPage } = await import("./public-html.ts");
    const history = renderHistoryPage({
      siteName: "Acme",
      banner: "fully_operational",
      stale: false,
      lastTick: 1,
      generatedAt: 1,
      groups: [],
      incidents: [],
    });
    expect(history).not.toContain('id="globe-stage"');
    expect(history).not.toContain("envelope=1.16");
    expect(history).not.toContain("status-globe");
    expect(history).not.toContain("/assets/globe.js");
  });
});

describe("public csp", () => {
  it("allows same-origin globe modules without a CDN or wasm eval", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const match = src.match(/export const PUBLIC_HEADERS = \{[\s\S]*?"content-security-policy":\s*\n\s*"([^"]+)"/);
    const csp = match?.[1] ?? "";
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("wasm-unsafe-eval");
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).not.toMatch(/cdn|unpkg|jsdelivr/i);
  });
});

describe("visitor here", () => {
  it("reads colo, city, and coords from cf and CF-Ray", async () => {
    const { visitorFromRequest } = await import("./visitor.ts");
    const fromHeaders = new Request("https://status.example/", {
      headers: {
        "CF-Ray": "8f1a2b3c4d5e6f7a-BOM",
        "CF-IPCity": "Mumbai",
        "CF-IPLatitude": "19.076",
        "CF-IPLongitude": "72.877",
      },
    });
    expect(visitorFromRequest(fromHeaders)).toEqual({
      colo: "BOM",
      city: "Mumbai",
      lat: 19.076,
      lng: 72.877,
    });

    const req = new Request("https://status.example/");
    Object.defineProperty(req, "cf", {
      value: { colo: "sjc", city: "San Jose", latitude: "37.336", longitude: "-121.89" },
    });
    expect(visitorFromRequest(req)).toEqual({
      colo: "SJC",
      city: "San Jose",
      lat: 37.336,
      lng: -121.89,
    });

    const junk = new Request("https://status.example/", {
      headers: { "CF-Ray": "not-a-ray", "CF-IPLatitude": "999", "CF-IPLongitude": "1" },
    });
    expect(visitorFromRequest(junk)).toEqual({ colo: null, city: null, lat: null, lng: 1 });
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
