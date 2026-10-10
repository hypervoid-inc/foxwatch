import { describe, expect, it } from "vitest";
import type { PublicSnapshot } from "@foxwatch/engine";
import {
  BADGE_FILL,
  DAY_TIP_SCRIPT,
  LOCAL_TIME_SCRIPT,
  LIVE_BLOCKS,
  LIVE_CLIENT_SCRIPT,
  LIVE_NOTICE_BUDGET,
  PAGE_CLIENT_SCRIPT,
  blockRev,
  liveNotice,
  publicInlineScripts,
  renderLegacyLivePayload,
  renderBadge,
  renderFeed,
  renderHistoryPage,
  renderIncidentPage,
  renderLivePayload,
  renderPublicHtml,
  renderSystemsBlock,
  snapshotEtag,
  snapshotStableKey,
} from "./public-html.ts";

type Day = PublicSnapshot["groups"][number]["components"][number]["days"][number];

function day(date: string, over: Partial<Day> = {}): Day {
  return { date, uptime: 1, incident: false, checks: 1440, latencyMs: 120, latencyMinMs: 40, latencyMaxMs: 900, ...over };
}

function ninetyDays(over: (i: number) => Partial<Day> = () => ({})): Day[] {
  return Array.from({ length: 90 }, (_, i) => day(new Date(Date.UTC(2026, 6, 13 + i)).toISOString().slice(0, 10), over(i)));
}

function snapshot(groups: number, perGroup: number, over: Partial<PublicSnapshot> = {}): PublicSnapshot {
  return {
    siteName: "Acme",
    banner: "fully_operational",
    stale: false,
    lastTick: 1_000,
    generatedAt: 2_000,
    incidents: [],
    maintenance: [],
    observers: [
      { region: "wnam", label: "West NA", title: "West North America", colo: "SJC", outcome: "pass", latencyMs: 40, checkedAt: 1_000 },
    ],
    groups: Array.from({ length: groups }, (_, g) => ({
      id: `g${g}`,
      name: `Group ${g}`,
      uptime90: 0.9998,
      components: Array.from({ length: perGroup }, (_, c) => ({
        id: `c${g}-${c}`,
        name: `Component ${g}.${c}`,
        groupId: `g${g}`,
        groupName: `Group ${g}`,
        status: "operational" as const,
        uptime90: 0.9998,
        days: ninetyDays(),
      })),
    })),
    ...over,
  };
}

/** The tooltip builder exactly as the page runs it. */
function tipClient() {
  return new Function(`${DAY_TIP_SCRIPT}; return { tipHtml: tipHtml, tipText: tipText, parseLatency: parseLatency };`)() as {
    tipHtml: (kind: string, iso: string, checks: number, lat: number[] | null) => string;
    tipText: (kind: string, iso: string, checks: number, lat: number[] | null) => string;
    parseLatency: (raw: string | null) => number[] | null;
  };
}

describe("status bars", () => {
  it("renders a day as one empty element with its figures in attributes", () => {
    const snap = snapshot(1, 1);
    snap.groups[0]!.components[0]!.days = [
      day("2026-08-10", { uptime: null, checks: null, latencyMs: null, latencyMinMs: null, latencyMaxMs: null }),
      day("2026-08-11", { checks: 4, latencyMs: 50, latencyMinMs: 40, latencyMaxMs: 80 }),
      day("2026-08-12", { uptime: 0.9, checks: 12, latencyMs: 200, latencyMinMs: null, latencyMaxMs: null }),
      day("2026-08-13", { uptime: 0.99, checks: 7 }),
    ];
    const html = renderSystemsBlock(snap);
    expect(html).toContain('<span class="day empty" style="--h:22%"></span>');
    expect(html).toContain('<span class="day ok" style="--h:52%" data-c="4" data-l="50,40,80"></span>');
    // Without a recorded range the average stands in for both ends, as the tooltip always drew it.
    expect(html).toContain('<span class="day bad" style="--h:100%" data-c="12" data-l="200,200,200"></span>');
    expect(html).toContain('data-from="2026-08-10"');
    expect(html).not.toContain("data-d=");
    expect(html).not.toContain("tip");
    // The label is all a reader without the tooltips gets, so it counts the bad days.
    expect(html).toContain('role="img" aria-label="Group 0 90-day history, 99.98% uptime, 1 day with an outage, 1 day degraded" tabindex="0"');
  });

  it("dates each day itself only when the run of dates has a gap", () => {
    const snap = snapshot(1, 1);
    snap.groups[0]!.components[0]!.days = [day("2026-08-10"), day("2026-08-12")];
    const html = renderSystemsBlock(snap);
    expect(html).toContain('data-d="2026-08-10"');
    expect(html).toContain('data-d="2026-08-12"');
  });

  it("keeps a large page small: every bar is there, no tooltip is", () => {
    const snap = snapshot(5, 4);
    const html = renderPublicHtml(snap);
    // 20 component bars and 5 group bars, 90 days each. This page was 2.9 MB.
    expect(html.match(/<span class="day /g)).toHaveLength(25 * 90);
    expect(html.length).toBeLessThan(400_000);
    expect(JSON.stringify(renderLivePayload(snap)).length).toBeLessThan(400_000);
    expect(JSON.stringify(renderLivePayload(snapshot(10, 10))).length).toBeLessThan(1_200_000);
  });
});

describe("day tooltip built in the browser", () => {
  // The markup the server used to repeat inside every day, captured before it moved to the client.
  const WAS = {
    full: "<span class=\"tip-date\">Mon, Aug 10, 2026</span><span class=\"tip-row\"><svg class=\"mark ok\" viewBox=\"0 0 20 20\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"10\" r=\"10\"/><path d=\"M6 10.4 8.6 13 14.2 7.4\" fill=\"none\" stroke=\"var(--on-accent)\" stroke-width=\"1.85\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg><span>No incidents</span></span><span class=\"tip-checks\"><b>4</b> checks</span><span class=\"tip-lat\" role=\"img\" aria-label=\"min 40ms, avg 50ms, max 80ms\"><span class=\"tip-lat-avg\" style=\"left:60.5%;transform:translateX(-50%)\">50ms<span class=\"k\"> avg</span></span><span class=\"tip-lat-track\"><span class=\"tip-lat-range\" style=\"left:50%;width:42%\"></span><span class=\"tip-lat-mark min\" style=\"left:50%\"></span><span class=\"tip-lat-mark avg\" style=\"left:60.5%\"></span><span class=\"tip-lat-mark max\" style=\"left:92%\"></span></span><span class=\"tip-lat-end min\" style=\"left:50%;transform:translateX(-50%)\">40ms</span><span class=\"tip-lat-end max\" style=\"left:92%;transform:translateX(-100%)\">80ms</span></span>",
    empty: "<span class=\"tip-date\">Tue, Aug 11, 2026</span><span class=\"tip-row\"><svg class=\"mark empty\" viewBox=\"0 0 20 20\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"10\" r=\"9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"/></svg><span>No data</span></span>",
    outage: "<span class=\"tip-date\">Wed, Aug 12, 2026</span><span class=\"tip-row\"><svg class=\"mark bad\" viewBox=\"0 0 20 20\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"10\" r=\"10\"/><path d=\"M7 7l6 6M13 7l-6 6\" fill=\"none\" stroke=\"var(--on-accent)\" stroke-width=\"1.85\" stroke-linecap=\"round\"/></svg><span>Outage</span></span><span class=\"tip-checks\"><b>12</b> checks</span><span class=\"tip-lat\" role=\"img\" aria-label=\"min 90ms, avg 200ms, max 890ms\"><span class=\"tip-lat-avg\" style=\"left:26.88%;transform:translateX(-50%)\">200ms<span class=\"k\"> avg</span></span><span class=\"tip-lat-track\"><span class=\"tip-lat-range\" style=\"left:16.49%;width:75.51%\"></span><span class=\"tip-lat-mark min\" style=\"left:16.49%\"></span><span class=\"tip-lat-mark avg\" style=\"left:26.88%\"></span><span class=\"tip-lat-mark max\" style=\"left:92%\"></span></span><span class=\"tip-lat-end min\" style=\"left:16.49%;transform:translateX(-50%)\">90ms</span><span class=\"tip-lat-end max\" style=\"left:92%;transform:translateX(-100%)\">890ms</span></span>",
    tight: "<span class=\"tip-date\">Thu, Aug 13, 2026</span><span class=\"tip-row\"><svg class=\"mark warn\" viewBox=\"0 0 20 20\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"10\" r=\"10\"/><path d=\"M10 6v5.2M10 14.2h.01\" fill=\"none\" stroke=\"var(--on-accent)\" stroke-width=\"1.85\" stroke-linecap=\"round\"/></svg><span>Degraded performance</span></span><span class=\"tip-checks\"><b>3</b> checks</span><span class=\"tip-lat\" role=\"img\" aria-label=\"min 40ms, avg 40ms, max 41ms\"><span class=\"tip-lat-avg\" style=\"left:89.95%;transform:translateX(-100%)\">40ms<span class=\"k\"> avg</span></span><span class=\"tip-lat-track\"><span class=\"tip-lat-mark avg\" style=\"left:89.95%\"></span></span></span>",
    averageOnly: "<span class=\"tip-date\">Fri, Aug 14, 2026</span><span class=\"tip-row\"><svg class=\"mark ok\" viewBox=\"0 0 20 20\" aria-hidden=\"true\"><circle cx=\"10\" cy=\"10\" r=\"10\"/><path d=\"M6 10.4 8.6 13 14.2 7.4\" fill=\"none\" stroke=\"var(--on-accent)\" stroke-width=\"1.85\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg><span>No incidents</span></span><span class=\"tip-lat\" role=\"img\" aria-label=\"min 120ms, avg 120ms, max 120ms\"><span class=\"tip-lat-avg\" style=\"left:92%;transform:translateX(-100%)\">120ms<span class=\"k\"> avg</span></span><span class=\"tip-lat-track\"><span class=\"tip-lat-mark avg\" style=\"left:92%\"></span></span></span>",
  };

  it("produces the markup the server used to render", () => {
    const { tipHtml, parseLatency } = tipClient();
    expect(tipHtml("ok", "2026-08-10", 4, parseLatency("50,40,80"))).toBe(WAS.full);
    expect(tipHtml("empty", "2026-08-11", 0, parseLatency(null))).toBe(WAS.empty);
    expect(tipHtml("bad", "2026-08-12", 12, parseLatency("200,90,890"))).toBe(WAS.outage);
    expect(tipHtml("warn", "2026-08-13", 3, parseLatency("40,40,41"))).toBe(WAS.tight);
    expect(tipHtml("ok", "2026-08-14", 0, parseLatency("120,120,120"))).toBe(WAS.averageOnly);
  });

  it("reads a day out in words for the keyboard path", () => {
    const { tipText, parseLatency } = tipClient();
    expect(tipText("bad", "2026-08-12", 12, parseLatency("200,90,890"))).toBe(
      "Wed, Aug 12, 2026. Outage. 12 checks. Latency min 90ms, avg 200ms, max 890ms.",
    );
    expect(tipText("empty", "2026-08-11", 0, null)).toBe("Tue, Aug 11, 2026. No data.");
  });

  it("never lets an attribute value into the markup as anything but a number or a date", () => {
    const { tipHtml, parseLatency } = tipClient();
    expect(parseLatency('1,2,"><img src=x>')).toBeNull();
    expect(parseLatency("1,2")).toBeNull();
    expect(parseLatency("0,0,0")).toBeNull();
    expect(tipHtml("<b>", "<script>", 0, null)).not.toMatch(/<b>|<script>/);
  });
});

describe("live blocks", () => {
  it("stamps each block with a hash of its markup and reports the same hash in the payload", () => {
    const live = renderLivePayload(snapshot(2, 2));
    for (const block of LIVE_BLOCKS) {
      expect(live.revs[block]).toMatch(/^[0-9a-f]+$/);
      expect(blockRev(live[block])).toBe(live.revs[block]);
    }
    expect(live.banner).toMatch(/^<div data-rev="[0-9a-f]+" id="live-banner">/);
    expect(live.generatedAt).toBe(2_000);
  });

  it("changes only the stamps of the blocks a probe run touched", () => {
    const before = renderLivePayload(snapshot(2, 2));
    const next = snapshot(2, 2, { generatedAt: 3_000, lastTick: 2_500 });
    next.groups[0]!.components[0]!.days[89]!.checks = 1441;
    const after = renderLivePayload(next);
    expect(after.etag).not.toBe(before.etag);
    expect(after.revs.systems).not.toBe(before.revs.systems);
    for (const block of ["banner", "brand", "history", "maintenance", "mesh"] as const) {
      expect(after.revs[block]).toBe(before.revs[block]);
    }
  });

  it("puts the snapshot's etag and time on the page so a replayed notice cannot overwrite it", () => {
    const snap = snapshot(1, 1);
    const html = renderPublicHtml(snap);
    expect(html).toContain(`<html lang="en" data-banner="fully_operational" data-etag="${snapshotEtag(snap)}" data-at="2000">`);
    expect(html).toContain('<p class="stale" id="live-conn" role="status" hidden></p>');
  });
});

describe("snapshotStableKey", () => {
  it("ignores the figures that move on every probe run", () => {
    const base = snapshot(2, 2);
    const moved = snapshot(2, 2, { generatedAt: 9_000, lastTick: 8_000 });
    const today = moved.groups[1]!.components[1]!.days[89]!;
    today.checks = 1500;
    today.latencyMs = 180;
    today.latencyMaxMs = 2_000;
    today.uptime = 0.9999;
    moved.observers[0]!.latencyMs = 95;
    moved.observers[0]!.checkedAt = 8_000;
    expect(snapshotEtag(moved)).not.toBe(snapshotEtag(base));
    expect(snapshotStableKey(moved)).toBe(snapshotStableKey(base));
  });

  it("changes with anything a visitor would notice", () => {
    const base = snapshotStableKey(snapshot(2, 2));
    const changed: Array<(s: PublicSnapshot) => void> = [
      (s) => { s.banner = "degraded"; },
      (s) => { s.groups[0]!.components[0]!.status = "failing"; },
      (s) => { s.groups[0]!.components[0]!.days[89]!.uptime = 0.5; },
      (s) => { s.groups[0]!.components[0]!.uptime90 = 0.99; },
      (s) => { s.observers[0]!.outcome = "fail"; },
      (s) => { s.stale = true; },
      (s) => { s.incidents = [{ id: "incident-1", componentIds: [], title: "Down", status: "investigating", impact: "failing", startedAt: 1, resolvedAt: null, updates: [] }]; },
      (s) => { s.maintenance = [{ id: "m", componentId: "c0-0", componentName: "Component 0.0", startAt: 1, endAt: 5_000, note: "" }]; },
    ];
    for (const change of changed) {
      const snap = snapshot(2, 2);
      change(snap);
      expect(snapshotStableKey(snap)).not.toBe(base);
    }
  });
});

describe("pages rendered before the bars changed shape", () => {
  it("are sent every block but the one their stylesheet cannot draw, and told to reload", () => {
    const snap = snapshot(2, 2, { banner: "failing" });
    const live = renderLivePayload(snap);
    const legacy = renderLegacyLivePayload(snap);
    // The old client swaps in any block it is handed, so the bars must not be there at all.
    expect(legacy).not.toHaveProperty("systems");
    expect(JSON.stringify(legacy)).not.toContain('class="day ');
    expect(legacy).toMatchObject({ etag: live.etag, status: "failing", title: live.title, mesh: live.mesh, history: live.history, maintenance: live.maintenance, brand: live.brand });
    expect(legacy.banner).toContain("experiencing an outage");
    expect(legacy.banner).toMatch(/<p class="stale" role="status">This page is out of date\. Reload it[^<]*<\/p><\/div>$/);
    expect(live.banner).not.toContain("out of date");
  });
});

describe("liveNotice", () => {
  it("carries every block of a small page", () => {
    const live = renderLivePayload(snapshot(1, 1, { observers: [] }));
    expect(liveNotice(live)).toEqual(live);
  });

  it("stays within its budget however large the page is, and keeps the banner", () => {
    for (const [groups, perGroup] of [[3, 3], [5, 4], [10, 10]] as const) {
      const live = renderLivePayload(snapshot(groups, perGroup, { banner: "failing" }));
      const notice = liveNotice(live);
      expect(notice.banner).toBe(live.banner);
      expect(notice.systems).toBeUndefined();
      expect(notice).toMatchObject({ etag: live.etag, stable: live.stable, generatedAt: live.generatedAt, status: "failing", revs: live.revs });
      const blocks = LIVE_BLOCKS.reduce((sum, block) => sum + JSON.stringify(notice[block] ?? "").length, 0);
      expect(blocks).toBeLessThanOrEqual(LIVE_NOTICE_BUDGET);
      expect(JSON.stringify(notice).length).toBeLessThan(LIVE_NOTICE_BUDGET + 2_048);
    }
  });

  it("skips a block that does not fit without giving up on the smaller ones after it", () => {
    const live = renderLivePayload(snapshot(1, 1));
    const notice = liveNotice(live, JSON.stringify(live.banner).length + JSON.stringify(live.brand).length + JSON.stringify(live.history).length + JSON.stringify(live.maintenance).length);
    expect(notice.banner).toBe(live.banner);
    expect(notice.history).toBe(live.history);
    expect(notice.maintenance).toBe(live.maintenance);
    expect(notice.systems).toBeUndefined();
    expect(notice.mesh).toBeUndefined();
    expect(liveNotice(live, 0)).not.toHaveProperty("banner");
  });
});

describe("page client", () => {
  it("is valid script", () => {
    expect(() => new Function(LIVE_CLIENT_SCRIPT)).not.toThrow();
  });

  it("listens only where the current block shape is served", () => {
    expect(LIVE_CLIENT_SCRIPT).toContain('fetch("/api/status/live.v2.json"');
    expect(LIVE_CLIENT_SCRIPT).toContain('location.host+"/live?v=2"');
    expect(LIVE_CLIENT_SCRIPT).not.toContain("/api/status/live.json");
  });

  it("starts from the page's own etag, checks the socket is alive, and does not reconnect on a fixed beat", () => {
    expect(LIVE_CLIENT_SCRIPT).toContain('doc.getAttribute("data-etag")');
    expect(LIVE_CLIENT_SCRIPT).toContain("if (msg.generatedAt<at) return;");
    expect(LIVE_CLIENT_SCRIPT).toContain("Date.now()-seen>QUIET_MS");
    expect(LIVE_CLIENT_SCRIPT).toContain('document.addEventListener("visibilitychange", wake)');
    expect(LIVE_CLIENT_SCRIPT).toContain("jitter(delay)");
    expect(LIVE_CLIENT_SCRIPT).not.toContain("setTimeout(connect, delay)");
  });
});

/** Just enough of a browser to run PAGE_CLIENT_SCRIPT and press the appearance button. */
type FakeTime = { getAttribute: (k: string) => string | null; closest: (sel: string) => unknown; textContent: string; title: string };

function fakeTime(at: number, inStatus = false): FakeTime {
  const iso = new Date(at).toISOString();
  return {
    getAttribute: (k) => (k === "datetime" ? iso : null),
    closest: (sel) => (inStatus && sel === '[role="status"]' ? {} : null),
    textContent: new Date(at).toUTCString(),
    title: "",
  };
}

function pageDom(theme: "light" | "dark", times: FakeTime[] = []) {
  const attrs = (init: Record<string, string>) => {
    const map = new Map(Object.entries(init));
    return {
      getAttribute: (k: string) => map.get(k) ?? null,
      setAttribute: (k: string, v: string) => void map.set(k, v),
    };
  };
  const root = { ...attrs({ "data-theme": theme }), style: {} as Record<string, string> };
  const button = { ...attrs({ "aria-label": "Use dark appearance" }), closest: (sel: string) => (sel === ".theme-toggle" ? button : null) };
  const meta = attrs({ content: "#efece6" });
  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const listen = (type: string, fn: (e: unknown) => void) => void (listeners[type] ??= []).push(fn);
  const stored = new Map<string, string>();
  const document = {
    documentElement: root,
    querySelector: (sel: string) => (sel === ".theme-toggle" ? button : sel === 'meta[name="theme-color"]' ? meta : null),
    querySelectorAll: (sel: string) => (sel === "time[datetime]" ? times : []),
    addEventListener: listen,
  };
  const window = { addEventListener: listen };
  const localStorage = { setItem: (k: string, v: string) => void stored.set(k, v) };
  const timers: Array<[() => void, number]> = [];
  const setInterval = (fn: () => void, ms: number) => void timers.push([fn, ms]);
  new Function("document", "window", "localStorage", "setInterval", PAGE_CLIENT_SCRIPT)(document, window, localStorage, setInterval);
  return {
    timers,
    root,
    button,
    meta,
    stored,
    fire: (type: string, event: unknown) => (listeners[type] ?? []).forEach((fn) => fn(event)),
  };
}

describe("appearance toggle", () => {
  const snap = () => snapshot(1, 1);
  const pages = (): Array<[string, string]> => [
    ["status", renderPublicHtml(snap())],
    ["history", renderHistoryPage(snap())],
    ["incident", renderIncidentPage(snap(), null)],
  ];

  it("has its click handler on every page that draws the button", () => {
    for (const [name, html] of pages()) {
      expect(html, name).toContain('class="theme-toggle"');
      expect(html, name).toContain('el.closest(".theme-toggle")');
    }
  });

  it("switches the theme, remembers it, and names what the next press does", () => {
    const dom = pageDom("dark");
    // The button is rendered for a light page; the script corrects it on load.
    expect(dom.button.getAttribute("aria-label")).toBe("Use light appearance");
    dom.fire("click", { target: dom.button });
    expect(dom.root.getAttribute("data-theme")).toBe("light");
    expect(dom.root.style.colorScheme).toBe("light");
    expect(dom.stored.get("foxwatch-theme")).toBe("light");
    expect(dom.meta.getAttribute("content")).toBe("#efece6");
    expect(dom.button.getAttribute("aria-label")).toBe("Use dark appearance");
    dom.fire("click", { target: { closest: () => null } });
    expect(dom.root.getAttribute("data-theme")).toBe("light");
    // Another tab changed it.
    dom.fire("storage", { key: "foxwatch-theme", newValue: "dark" });
    expect(dom.root.getAttribute("data-theme")).toBe("dark");
    expect(dom.meta.getAttribute("content")).toBe("#2c2b28");
  });
});

describe("region map beside the globe", () => {
  const html = renderPublicHtml(snapshot(1, 1));
  const desktop = html.slice(html.indexOf("@media (min-width: 1100px) and (hover: hover) and (pointer: fine) {"));

  it("is put aside only once a script has said a globe is coming", () => {
    // Nothing keyed on the stage alone may hide the map or move the page: the stage is in the markup with scripting off too.
    expect(html).not.toMatch(/(^|[^n]) body:has\(#globe-stage\) (#live-mesh|\.wrap \{)/m);
    expect(desktop).toContain("html.globe-on body:has(#globe-stage) #live-mesh.mesh {");
    expect(desktop).toContain("html.globe-on body:has(#globe-stage) .wrap {");
    expect(html).toContain('<script>(function(){try{document.documentElement.classList.add("globe-on");');
    expect(html).toContain('<noscript><meta http-equiv="refresh" content="60"/></noscript>');
  });

  it("stays readable to a screen reader while the globe is shown", () => {
    const rule = /html\.globe-on body:has\(#globe-stage\) #live-mesh\.mesh \{([^}]*)\}/.exec(desktop)?.[1] ?? "";
    expect(rule).toContain("clip: rect(0,0,0,0)");
    expect(rule).not.toContain("display");
    expect(rule).not.toContain("visibility");
    // The region buttons would be tab stops nobody can see; the list beside them says the same thing.
    expect(desktop).toContain("html.globe-on body:has(#globe-stage) #live-mesh .mesh-plot { display: none; }");
    const mesh = renderLivePayload(snapshot(1, 1)).mesh;
    // The list is a sibling of the plot, not inside it.
    expect(mesh).toMatch(/<span class="mesh-you" hidden><\/span>\s*<\/div>\s*<ul class="mesh-sr"><li>[^<]+<\/li><\/ul>/);
  });

  it("comes back when neither globe renderer could load", () => {
    expect(html).toContain('function noGlobe(){ document.documentElement.classList.remove("globe-on"); }');
    expect(html).toContain('if (!flat) window.addEventListener("fw-globe-fallback", noGlobe);');
  });
});

describe("page head", () => {
  const incident: PublicSnapshot["incidents"][number] = {
    id: "inc99abcdefghijklmnop",
    componentIds: ["api"],
    componentNames: ["Checkout API"],
    title: "Checkout <API> is failing",
    status: "identified",
    impact: "failing",
    startedAt: Date.UTC(2026, 9, 10, 14, 5),
    resolvedAt: null,
    updates: [
      { status: "investigating", body: "Looking into it.", at: Date.UTC(2026, 9, 10, 14, 5) },
      { status: "identified", body: `A bad deploy & a "stuck" queue.\n${"x".repeat(400)}`, at: Date.UTC(2026, 9, 10, 14, 20) },
    ],
  };
  const snap = () => snapshot(1, 1, { siteName: "Acme & Co", iconUrl: "/icon?v=7", incidents: [incident] });
  const origin = "https://status.acme.test";

  it("gives link previews a site name, title, description, address and image on every page", () => {
    const pages: Array<[string, string]> = [
      [renderPublicHtml(snap(), origin), "/"],
      [renderHistoryPage(snap(), origin), "/history"],
      [renderIncidentPage(snap(), incident, origin), "/incidents/inc99abcdefghijklmnop"],
    ];
    for (const [html, path] of pages) {
      expect(html).toContain('<meta property="og:site_name" content="Acme &amp; Co"/>');
      expect(html).toContain(`<meta property="og:url" content="${origin}${path}"/>`);
      expect(html).toContain(`<link rel="canonical" href="${origin}${path}"/>`);
      expect(html).toContain(`<meta property="og:image" content="${origin}/icon?v=7"/>`);
      expect(html).toContain('<meta name="twitter:card" content="summary"/>');
      expect(html).toContain('<link rel="alternate" type="application/rss+xml" title="Acme &amp; Co incidents" href="/feed.xml"/>');
      expect(html).toMatch(/<meta property="og:title" content="[^"]+"\/>/);
      expect(html).not.toContain('name="robots"');
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    }
    expect(pages[0]![0]).toContain('<meta property="og:title" content="Acme &amp; Co status"/>');
    expect(pages[0]![0]).toContain('<meta property="og:description" content="We&#39;re fully operational."/>');
  });

  it("previews an incident with where it stands and the latest update, cut to length and escaped", () => {
    const html = renderIncidentPage(snap(), incident, origin);
    expect(html).toContain('<meta property="og:type" content="article"/>');
    expect(html).toContain('<meta property="og:title" content="Checkout &lt;API&gt; is failing - Acme &amp; Co"/>');
    const description = /<meta property="og:description" content="([^"]*)"\/>/.exec(html)?.[1] ?? "";
    expect(description.startsWith("Identified - Outage. A bad deploy &amp; a &quot;stuck&quot; queue. xxx")).toBe(true);
    expect(description.endsWith("…")).toBe(true);
    expect(description.length).toBeLessThan(260);
    expect(html).toContain(`<meta name="description" content="${description}"/>`);
    expect(html).toContain('<h1 id="incident-title">Checkout &lt;API&gt; is failing</h1>');
  });

  it("keeps a missing incident out of search results and gives it no address", () => {
    const html = renderIncidentPage(snap(), null, origin);
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain("og:url");
  });

  it("leaves absolute addresses out when the origin is not known", () => {
    const html = renderPublicHtml(snap());
    expect(html).not.toContain("og:url");
    expect(html).not.toContain("og:image");
    expect(html).not.toContain('rel="canonical"');
    expect(html).toContain('<meta property="og:title"');
  });
});

describe("incident feed", () => {
  const at = (minute: number) => Date.UTC(2026, 9, 10, 14, minute);
  const incidents: PublicSnapshot["incidents"] = [
    {
      id: "inc99abcdefghijklmnop",
      componentIds: ["api"],
      componentNames: ["Checkout API"],
      title: "Checkout <API> outage",
      status: "resolved",
      impact: "failing",
      startedAt: at(5),
      resolvedAt: at(40),
      updates: [
        { status: "investigating", body: "Looking into it.", at: at(5) },
        { status: "identified", body: "A bad deploy & a stuck queue.", at: at(20) },
        { status: "resolved", body: "", at: at(40) },
      ],
    },
    {
      id: "incquietabcdefghijkl",
      componentIds: [],
      componentNames: [],
      title: "Slow dashboards",
      status: "monitoring",
      impact: "degraded",
      startedAt: at(30),
      resolvedAt: null,
      updates: [],
    },
  ];
  const origin = "https://status.acme.test";
  const feed = () => renderFeed(snapshot(1, 1, { incidents }), origin);
  const items = (xml: string) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
  const tag = (item: string, name: string) => new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item)?.[1] ?? "";

  it("has an item for every update, newest first, each with its own guid and date", () => {
    const list = items(feed());
    expect(list.map((i) => tag(i, "title"))).toEqual([
      "[Resolved] Checkout &lt;API&gt; outage",
      "[Monitoring] Slow dashboards",
      "[Identified] Checkout &lt;API&gt; outage",
      "[Investigating] Checkout &lt;API&gt; outage",
    ]);
    const guids = list.map((i) => tag(i, "guid"));
    expect(new Set(guids).size).toBe(4);
    expect(guids[0]).toBe(`${origin}/incidents/inc99abcdefghijklmnop#${at(40)}`);
    expect(list[0]).toContain('<guid isPermaLink="false">');
    expect(tag(list[0]!, "pubDate")).toBe("Sat, 10 Oct 2026 14:40:00 GMT");
    expect(tag(list[0]!, "link")).toBe(`${origin}/incidents/inc99abcdefghijklmnop`);
  });

  it("carries the update text, escaped, and says where things stand when there is none", () => {
    const list = items(feed());
    expect(tag(list[2]!, "description")).toBe("A bad deploy &amp; a stuck queue.");
    expect(tag(list[0]!, "description")).toBe("Resolved - Outage");
    expect(tag(list[1]!, "description")).toBe("Monitoring - Degraded");
  });

  it("an update that is posted later adds an item and leaves the earlier guids alone", () => {
    const before = items(feed()).map((i) => tag(i, "guid"));
    const later = structuredClone(incidents);
    later[1]!.updates.push({ status: "resolved", body: "Back to normal.", at: at(55) });
    const after = items(renderFeed(snapshot(1, 1, { incidents: later }), origin)).map((i) => tag(i, "guid"));
    expect(after[0]).toBe(`${origin}/incidents/incquietabcdefghijkl#${at(55)}`);
    expect(after).toHaveLength(4);
    // The incident that had no updates is now described by its update, not by a second copy of itself.
    expect(before.filter((g) => !after.includes(g))).toEqual([`${origin}/incidents/incquietabcdefghijkl#${at(30)}`]);
  });

  it("tells readers where it lives, when it last changed, and how often to look", () => {
    const xml = feed();
    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(`<atom:link href="${origin}/feed.xml" rel="self" type="application/rss+xml"/>`);
    expect(xml).toContain("<lastBuildDate>Sat, 10 Oct 2026 14:40:00 GMT</lastBuildDate>");
    expect(xml).toContain("<ttl>5</ttl>");
    const empty = renderFeed(snapshot(1, 1, { generatedAt: at(0) }), origin);
    expect(items(empty)).toHaveLength(0);
    expect(empty).toContain("<lastBuildDate>Sat, 10 Oct 2026 14:00:00 GMT</lastBuildDate>");
  });

  it("is bounded however many updates the incidents carry", () => {
    const busy = structuredClone(incidents);
    busy[0]!.updates = Array.from({ length: 250 }, (_, n) => ({ status: "monitoring", body: `Note ${n}`, at: at(45) + n }));
    const list = items(renderFeed(snapshot(1, 1, { incidents: busy }), origin));
    expect(list).toHaveLength(100);
    expect(tag(list[0]!, "description")).toBe("Note 249");
  });
});

describe("status badge", () => {
  const attr = (svg: string, name: string) => Number(new RegExp(`<svg [^>]*${name}="(\\d+)"`).exec(svg)?.[1]);
  const text = (svg: string) => /<text [^>]*>([^<]*)<\/text>/.exec(svg)?.[1] ?? "";

  it("is as wide as the text reads, not as it is escaped", () => {
    const plain = renderBadge(snapshot(1, 1, { siteName: "Acme" }));
    // "Acme: We're fully operational" is 29 characters; the apostrophe is one of them, not the five of &#39;.
    expect(text(plain)).toBe("Acme: We&#39;re fully operational");
    expect(attr(plain, "width")).toBe(24 + 29 * 7);
    const amp = renderBadge(snapshot(1, 1, { siteName: "A&B<" }));
    expect(text(amp)).toBe("A&amp;B&lt;: We&#39;re fully operational");
    expect(attr(amp, "width")).toBe(attr(plain, "width"));
  });

  it("cuts a long site name short so the status is never clipped", () => {
    const siteName = "Acme Payments & Billing Platform - Production EU West and Central";
    const svg = renderBadge(snapshot(1, 1, { siteName, banner: "degraded" }));
    expect(attr(svg, "width")).toBeLessThanOrEqual(480);
    expect(text(svg)).toMatch(/^Acme Payments &amp; Bill[^:]*…: We&#39;re experiencing degraded performance$/);
    expect(svg).toContain(`<rect width="${attr(svg, "width")}"`);
    // The whole name is still there for a screen reader and on hover.
    expect(svg).toContain('aria-label="Acme Payments &amp; Billing Platform - Production EU West and Central: We&#39;re experiencing degraded performance"');
    expect(svg).toContain("<title>Acme Payments &amp; Billing Platform - Production EU West and Central: We&#39;re experiencing degraded performance</title>");
    const longest = renderBadge(snapshot(1, 1, { siteName: "W".repeat(80), banner: "degraded" }));
    expect(attr(longest, "width")).toBeLessThanOrEqual(480);
    expect(text(longest)).toContain("…: We&#39;re experiencing degraded performance");
  });

  it("puts white text on a fill it can be read against in every state", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    for (const banner of ["unknown", "fully_operational", "degraded", "failing"] as const) {
      const svg = renderBadge(snapshot(1, 1, { banner }));
      expect(svg).toContain(`fill="${BADGE_FILL[banner]}"`);
      expect(svg).toContain('fill="#ffffff"');
      expect(1.05 / (luminance(BADGE_FILL[banner]) + 0.05), banner).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("local times", () => {
  const client = new Function(`${LOCAL_TIME_SCRIPT}; return { timeAgo: timeAgo, localTime: localTime };`)() as {
    timeAgo: (at: number, now: number) => string;
    localTime: (at: number, zone?: string) => string;
  };
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it("says how long ago or how far off a time within a day is, and nothing beyond that", () => {
    const now = Date.UTC(2026, 9, 10, 14, 0);
    expect(client.timeAgo(now - 20_000, now)).toBe("just now");
    expect(client.timeAgo(now + 20_000, now)).toBe("just now");
    expect(client.timeAgo(now - 50_000, now)).toBe("1 min ago");
    expect(client.timeAgo(now - 12 * MIN, now)).toBe("12 min ago");
    expect(client.timeAgo(now - 59.9 * MIN, now)).toBe("59 min ago");
    expect(client.timeAgo(now - 60 * MIN, now)).toBe("1 hr ago");
    expect(client.timeAgo(now - 23.9 * HOUR, now)).toBe("23 hr ago");
    expect(client.timeAgo(now + 3 * HOUR, now)).toBe("in 3 hr");
    expect(client.timeAgo(now + 30 * MIN, now)).toBe("in 30 min");
    expect(client.timeAgo(now - 24 * HOUR, now)).toBe("");
    expect(client.timeAgo(now + 3 * 24 * HOUR, now)).toBe("");
    expect(client.timeAgo(NaN, now)).toBe("");
  });

  it("writes a time in the reader's zone and names the zone", () => {
    const at = Date.UTC(2026, 9, 10, 2, 0);
    const tokyo = client.localTime(at, "Asia/Tokyo");
    const sf = client.localTime(at, "America/Los_Angeles");
    expect(tokyo).toMatch(/\b11\b/);
    expect(tokyo).toMatch(/10\b/);
    expect(sf).toMatch(/\b7\b/);
    expect(sf).toMatch(/\b9\b/);
    expect(tokyo).not.toBe(sf);
    expect(client.localTime(at)).not.toBe("");
  });

  it("marks every time on the page up for it, and still writes UTC for readers without scripting", () => {
    const at = Date.UTC(2026, 9, 10, 14, 5);
    const incident: PublicSnapshot["incidents"][number] = {
      id: "inc99abcdefghijklmnop", componentIds: [], componentNames: [], title: "Outage", status: "investigating", impact: "failing",
      startedAt: at, resolvedAt: null, updates: [{ status: "investigating", body: "Looking.", at }],
    };
    const snap = snapshot(1, 1, {
      stale: true,
      lastTick: at,
      incidents: [incident],
      maintenance: [{ id: "m1", componentId: "c0-0", componentName: "Component 0.0", startAt: at, endAt: at + HOUR, note: "" }],
    });
    const time = '<time datetime="2026-10-10T14:05:00.000Z">Sat, 10 Oct 2026 14:05:00 GMT</time>';
    const home = renderPublicHtml(snap);
    expect(home).toContain(`Last observer tick: ${time}.`);
    expect(home).toContain(`Scheduled · ${time} – <time datetime="2026-10-10T15:05:00.000Z">Sat, 10 Oct 2026 15:05:00 GMT</time>`);
    for (const html of [home, renderHistoryPage(snap), renderIncidentPage(snap, incident)]) {
      expect(html).toContain(`Investigating · ${time}`);
      expect(html).toContain('document.querySelectorAll("time[datetime]")');
      expect(html).toContain("setInterval(localTimes, 60000);");
    }
    // A live update brings new markup, and with it new UTC text.
    expect(LIVE_CLIENT_SCRIPT).toMatch(/refocus\(focus\);\s*localTimes\(\);/);
  });

  it("rewrites the text once, keeps UTC on hover, and leaves a spoken notice without a running clock", () => {
    const recent = fakeTime(Date.now() - 12 * MIN - 5_000);
    const old = fakeTime(Date.UTC(2026, 0, 2, 3, 4));
    const notice = fakeTime(Date.now() - 12 * MIN - 5_000, true);
    const utc = recent.textContent;
    const dom = pageDom("light", [recent, old, notice]);
    expect(recent.title).toBe(utc);
    expect(recent.textContent).toBe(`${client.localTime(Date.parse(recent.getAttribute("datetime")!))} (12 min ago)`);
    expect(old.title).toBe("Fri, 02 Jan 2026 03:04:00 GMT");
    expect(old.textContent).toBe(client.localTime(Date.UTC(2026, 0, 2, 3, 4)));
    expect(notice.textContent).toBe(client.localTime(Date.parse(notice.getAttribute("datetime")!)));
    // The page keeps "ago" honest while it stays open, without losing the tooltip.
    expect(dom.timers).toHaveLength(1);
    expect(dom.timers[0]![1]).toBe(60_000);
    dom.timers[0]![0]();
    expect(recent.title).toBe(utc);
    expect(recent.textContent).toContain("(12 min ago)");
  });
});

describe("inline scripts", () => {
  /** Script elements a browser would run: anything but a data block such as application/json. */
  const scripts = (html: string) =>
    [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({ attrs: m[1]!, body: m[2]! }));
  const hostile = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
  const incident = (text: string): PublicSnapshot["incidents"][number] => ({
    id: "inc99abcdefghijklmnop",
    componentIds: ["c0-0"],
    componentNames: [text],
    title: text,
    status: "investigating",
    impact: "failing",
    startedAt: 1_000,
    resolvedAt: null,
    updates: [{ status: "investigating", body: text, at: 1_000 }],
  });
  const pages = (text: string, over: Partial<PublicSnapshot> = {}) => {
    const snap = snapshot(2, 2, {
      siteName: text,
      homepageUrl: `https://example.com/?q=${text}`,
      iconUrl: `/icon?v=${text}`,
      stale: true,
      incidents: [incident(text)],
      maintenance: [{ id: "m1", componentId: "c0-0", componentName: text, startAt: 1, endAt: 5_000, note: text }],
      ...over,
    });
    for (const group of snap.groups) {
      group.name = text;
      for (const component of group.components) component.name = text;
    }
    snap.observers[0]!.label = text;
    snap.observers[0]!.title = text;
    return [
      renderPublicHtml(snap, "https://status.acme.test"),
      renderHistoryPage(snap, "https://status.acme.test"),
      renderIncidentPage(snap, snap.incidents[0]!, "https://status.acme.test"),
      renderIncidentPage(snap, null, "https://status.acme.test"),
    ];
  };

  it("are all on the list the Content-Security-Policy is built from, on every page", () => {
    const allowed = new Set(publicInlineScripts());
    const seen = new Set<string>();
    for (const html of [...pages("Acme"), ...pages("Acme", { globe: false })]) {
      const found = scripts(html);
      expect(found.length).toBeGreaterThan(1);
      for (const script of found) {
        expect(script.attrs).toBe("");
        expect(allowed.has(script.body), script.body.slice(0, 80)).toBe(true);
        seen.add(script.body);
      }
    }
    // And nothing is allowed that no page carries.
    expect([...allowed].filter((script) => !seen.has(script))).toEqual([]);
  });

  it("cannot be added to by text an operator typed", () => {
    const allowed = new Set(publicInlineScripts());
    for (const html of [...pages(hostile), ...pages(hostile, { globe: false })]) {
      for (const script of scripts(html)) expect(allowed.has(script.body), script.body.slice(0, 80)).toBe(true);
      expect(html).not.toContain("<img src=x");
      expect(html).toContain('<link rel="icon" href="/icon?v=&quot;&gt;&lt;script&gt;');
    }
    const live = renderLivePayload(snapshot(1, 1, { siteName: hostile, incidents: [incident(hostile)] }));
    for (const block of LIVE_BLOCKS) expect(live[block]).not.toContain("<script");
  });
});
