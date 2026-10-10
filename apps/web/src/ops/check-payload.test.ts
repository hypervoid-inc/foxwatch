import { describe, expect, it } from "vitest";
import {
  assertionValueText,
  buildCheckPayload,
  buildHttpRequest,
  clampAssertionThreshold,
  emptyForm,
  formFromMonitor,
  parseAssertionValue,
  resolvePlacement,
  type CheckFormState,
  type Monitor,
  type PlacedMonitor,
} from "./check-payload.ts";

function form(over: Partial<CheckFormState> = {}): CheckFormState {
  return { ...emptyForm(), name: "Checkout", url: "https://api.example.com/health", ...over };
}

function monitor(over: Partial<Monitor> = {}): Monitor {
  return {
    id: "checkout",
    origin: "ui",
    drifted: false,
    type: "http",
    name: "Checkout",
    groupId: "api",
    groupName: "API",
    componentId: "checkout",
    componentName: "Checkout",
    critical: false,
    mutedUntil: null,
    config: { type: "http", url: "https://api.example.com/health", method: "GET", intervalMs: 60_000, timeoutMs: 10_000, regions: ["wnam"] },
    ...over,
  };
}

function payloadOf(built: ReturnType<typeof buildCheckPayload> | ReturnType<typeof buildHttpRequest>): Record<string, any> {
  if (!built.ok) throw new Error(built.error);
  return built.payload;
}

function errorOf(built: ReturnType<typeof buildCheckPayload> | ReturnType<typeof buildHttpRequest>): string {
  if (built.ok) throw new Error("expected a validation error");
  return built.error;
}

describe("clearing optional fields", () => {
  it("sends null for a cleared degrade threshold and body so a PATCH merge cannot keep the old ones", () => {
    const editing = monitor({
      config: { type: "http", url: "https://api.example.com/health", method: "POST", body: '{"a":1}', degradedIf: { latencyMs: 2000 }, intervalMs: 60_000, timeoutMs: 10_000 },
    });
    const loaded = formFromMonitor(editing);
    expect(loaded.latencyThreshold).toBe("2");
    const wire = JSON.parse(JSON.stringify(payloadOf(buildCheckPayload({ ...loaded, latencyThreshold: "", body: "" }, editing, [editing]))));
    expect(wire).toHaveProperty("degradedIf", null);
    expect(wire).toHaveProperty("body", null);
    // Switching away from POST clears the body too.
    const get = JSON.parse(JSON.stringify(payloadOf(buildCheckPayload({ ...loaded, method: "GET" }, editing, [editing]))));
    expect(get).toHaveProperty("body", null);
    expect(get.degradedIf).toEqual({ latencyMs: 2000 });
  });
});

describe("group and component placement", () => {
  const a: PlacedMonitor = { id: "a", groupId: "api", groupName: "API", componentId: "a", componentName: "A" };
  const b: PlacedMonitor = { id: "b", groupId: "api", groupName: "API", componentId: "b", componentName: "B" };
  const w: PlacedMonitor = { id: "w", groupId: "site", groupName: "Web", componentId: "front", componentName: "Storefront" };

  it("keeps ids when the names were not edited", () => {
    expect(resolvePlacement({ groupName: "API", componentName: "A" }, a, [a, b, w])).toEqual({ groupId: "api", groupName: "API", componentId: "a", componentName: "A" });
  });

  it("moves a check into the existing group that has the typed name, under that group's id and spelling", () => {
    expect(resolvePlacement({ groupName: "web", componentName: "A" }, a, [a, b, w])).toEqual({ groupId: "site", groupName: "Web", componentId: "a", componentName: "A" });
  });

  it("joins an existing component of the same group by name", () => {
    expect(resolvePlacement({ groupName: "API", componentName: "b" }, a, [a, b, w])).toMatchObject({ groupId: "api", componentId: "b", componentName: "B" });
    // A component of another group with that name is a different component.
    expect(resolvePlacement({ groupName: "API", componentName: "Storefront" }, a, [a, b, w])).toMatchObject({ groupId: "api", componentId: "a", componentName: "Storefront" });
  });

  it("renames in place when the check is the only member, keeping history under the id", () => {
    expect(resolvePlacement({ groupName: "Website", componentName: "Shop" }, w, [a, b, w])).toEqual({ groupId: "site", groupName: "Website", componentId: "front", componentName: "Shop" });
  });

  it("splits a check off a shared group or component under an id nothing else uses", () => {
    expect(resolvePlacement({ groupName: "Backend", componentName: "A" }, a, [a, b, w])).toMatchObject({ groupId: "backend", groupName: "Backend", componentId: "a" });
    expect(resolvePlacement({ groupName: "Site", componentName: "A" }, a, [a, b, w])).toMatchObject({ groupId: "site-2", groupName: "Site" });
    const shared: PlacedMonitor = { ...b, componentId: "a", componentName: "A" };
    expect(resolvePlacement({ groupName: "API", componentName: "Front" }, a, [a, shared, w])).toMatchObject({ groupId: "api", componentId: "front-2", componentName: "Front" });
    // Leaving the group leaves the shared component behind as well.
    expect(resolvePlacement({ groupName: "Web", componentName: "A" }, a, [a, shared, w])).toMatchObject({ groupId: "site", componentId: "a-2", componentName: "A" });
  });

  it("places a new check by name too", () => {
    expect(resolvePlacement({ groupName: "Web", componentName: "storefront" }, null, [a, b, w])).toEqual({ groupId: "site", groupName: "Web", componentId: "front", componentName: "Storefront" });
    expect(resolvePlacement({ groupName: "Jobs", componentName: "Nightly" }, null, [a, b, w])).toEqual({ groupId: "jobs", groupName: "Jobs", componentId: "nightly", componentName: "Nightly" });
  });

  it("carries the placement into the saved payload", () => {
    const editing = monitor();
    const other = monitor({ id: "site", name: "Site", groupId: "web", groupName: "Web", componentId: "site", componentName: "Site" });
    const sibling = monitor({ id: "cart", name: "Cart", componentId: "cart", componentName: "Cart" });
    const payload = payloadOf(buildCheckPayload({ ...formFromMonitor(editing), groupName: "Web" }, editing, [editing, other, sibling]));
    expect(payload).toMatchObject({ id: "checkout", groupId: "web", groupName: "Web", componentId: "checkout", componentName: "Checkout" });
  });
});

describe("http interval", () => {
  it("holds the amount and unit apart, so 60 sec stays 60 sec", () => {
    expect(payloadOf(buildCheckPayload(form({ intervalValue: "60", intervalUnit: "s" }), null, [])).interval).toBe("60s");
    expect(formFromMonitor(monitor({ config: { intervalMs: 14_400_000 } }))).toMatchObject({ intervalValue: "4", intervalUnit: "h" });
    expect(formFromMonitor(monitor({ config: { intervalMs: 45_000 } }))).toMatchObject({ intervalValue: "45", intervalUnit: "s" });
    expect(formFromMonitor(monitor({ config: { intervalMs: 30_500 } }))).toMatchObject({ intervalValue: "31", intervalUnit: "s" });
  });

  it("rejects an empty or out-of-range interval on save instead of rewriting it", () => {
    const message = "Interval must be from 30 seconds to 24 hours.";
    expect(errorOf(buildCheckPayload(form({ intervalValue: "" }), null, []))).toBe(message);
    expect(errorOf(buildCheckPayload(form({ intervalValue: "4", intervalUnit: "s" }), null, []))).toBe(message);
    expect(errorOf(buildCheckPayload(form({ intervalValue: "25", intervalUnit: "h" }), null, []))).toBe(message);
  });

  it("keeps the heartbeat interval token separate", () => {
    const hb = monitor({ type: "heartbeat", config: { type: "heartbeat", intervalMs: 300_000, graceMs: 60_000 } });
    expect(formFromMonitor(hb)).toMatchObject({ checkType: "heartbeat", interval: "5m", grace: "1m" });
    expect(payloadOf(buildCheckPayload(formFromMonitor(hb), hb, [hb]))).toMatchObject({ type: "heartbeat", interval: "5m", grace: "1m" });
  });
});

describe("assertion values", () => {
  it("types the value by operator", () => {
    expect(parseAssertionValue("contains", "2")).toBe("2");
    expect(parseAssertionValue("matches", "true")).toBe("true");
    expect(parseAssertionValue("gt", "2.5")).toBe(2.5);
    expect(parseAssertionValue("lte", "fast")).toBeUndefined();
    expect(parseAssertionValue("gte", "")).toBeUndefined();
    expect(parseAssertionValue("equals", "200")).toBe(200);
    expect(parseAssertionValue("equals", '"200"')).toBe("200");
    expect(parseAssertionValue("not_equals", "true")).toBe(true);
    expect(parseAssertionValue("equals", '"true"')).toBe("true");
    expect(parseAssertionValue("equals", "null")).toBeNull();
    expect(parseAssertionValue("equals", "ok")).toBe("ok");
    expect(parseAssertionValue("equals", '"say \\"hi\\""')).toBe('say "hi"');
    expect(parseAssertionValue("equals", '"a\\b"x"')).toBe('a\\b"x');
  });

  it("shows a stored value as text that saves back to the same value", () => {
    const stored: Array<[Parameters<typeof parseAssertionValue>[0], string | number | boolean | null]> = [
      ["equals", "200"],
      ["equals", 200],
      ["equals", "true"],
      ["equals", false],
      ["equals", null],
      ["equals", "null"],
      ["equals", "ok"],
      ["equals", '"quoted"'],
      ["equals", ""],
      ["not_equals", " padded "],
      ["contains", "2"],
      ["gt", 3],
    ];
    for (const [op, value] of stored) {
      expect(parseAssertionValue(op, assertionValueText(op, value))).toBe(value);
    }
    expect(assertionValueText("equals", "200")).toBe('"200"');
    expect(assertionValueText("equals", "ok")).toBe("ok");
    expect(assertionValueText("exists", undefined)).toBe("");
  });

  it("builds assertions the server accepts and names the row it cannot", () => {
    const expectOf = (assertions: CheckFormState["assertions"]) => payloadOf(buildHttpRequest(form({ assertions }))).expect;
    expect(expectOf([
      { path: "$.version", op: "contains", value: "2" },
      { path: "$.code", op: "equals", value: '"200"' },
      { path: " $.count ", op: "gte", value: "3" },
      { path: "$.ok", op: "exists", value: "ignored" },
      { path: "", op: "equals", value: "skipped" },
    ]).assertions).toEqual([
      { path: "$.version", op: "contains", value: "2" },
      { path: "$.code", op: "equals", value: "200" },
      { path: "$.count", op: "gte", value: 3 },
      { path: "$.ok", op: "exists" },
    ]);
    expect(errorOf(buildHttpRequest(form({ assertions: [{ path: "$.count", op: "gt", value: "many" }] })))).toBe("Assertion $.count needs a number to compare against.");
    expect(errorOf(buildHttpRequest(form({ assertions: [{ path: "data.status", op: "exists", value: "" }] })))).toMatch(/^JSON path data\.status is not valid/);
    expect(errorOf(buildHttpRequest(form({ assertions: [{ path: "$.a", op: "contains", value: "x".repeat(257) }] })))).toMatch(/limited to 256 characters/);
  });

  it("never sends a fail threshold above the assertions that are sent", () => {
    const three = [
      { path: "$.a", op: "exists" as const, value: "" },
      { path: "$.b", op: "exists" as const, value: "" },
      { path: "", op: "exists" as const, value: "" },
    ];
    expect(payloadOf(buildHttpRequest(form({ assertions: three, assertionFailThreshold: 3 }))).expect.assertionFailThreshold).toBe(2);
    expect(payloadOf(buildHttpRequest(form({ assertions: three.slice(1), assertionFailThreshold: 3 }))).expect.assertionFailThreshold).toBeUndefined();
    expect(clampAssertionThreshold(3, 2)).toBe(2);
    expect(clampAssertionThreshold(0, 2)).toBe(1);
    expect(clampAssertionThreshold(2, 0)).toBe(1);
    expect(clampAssertionThreshold(Number.NaN, 4)).toBe(1);
  });
});

describe("test request", () => {
  it("is the request and expectations a save stores", () => {
    const state = form({
      method: "POST",
      body: '{ "ping": true }',
      expectStatus: "200, 204",
      bodyIncludes: "ok",
      followRedirects: false,
      allowedHosts: "cdn.example.com",
      latencyThreshold: "2",
      latencyUnit: "s",
      assertions: [{ path: "$.status", op: "equals", value: "up" }],
    });
    const request = payloadOf(buildHttpRequest(state));
    expect(request).toEqual({
      url: "https://api.example.com/health",
      method: "POST",
      body: '{"ping":true}',
      headers: { "Content-Type": "application/json" },
      allowedHosts: ["api.example.com", "cdn.example.com"],
      timeout: 10_000,
      followRedirects: false,
      degradedIf: { latencyMs: 2000 },
      expect: { status: [200, 204], bodyIncludes: "ok", assertions: [{ path: "$.status", op: "equals", value: "up" }], assertionFailThreshold: undefined },
    });
    expect(payloadOf(buildCheckPayload(state, null, []))).toMatchObject(request);
  });

  it("keeps a typed Content-Type and reports the same validation errors as a save", () => {
    const typed = form({ method: "POST", body: "{}", headers: [{ key: "content-type", kind: "text", value: "application/vnd.api+json" }] });
    expect(payloadOf(buildHttpRequest(typed)).headers).toEqual({ "content-type": "application/vnd.api+json" });
    expect(errorOf(buildHttpRequest(form({ method: "POST", body: "{nope" })))).toBe("Request JSON is not valid.");
    expect(errorOf(buildHttpRequest(form({ url: "http://example.com" })))).toMatch(/^Use HTTPS/);
    expect(errorOf(buildHttpRequest(form({ expectStatus: "200, 99" })))).toMatch(/^Expected statuses/);
    // A test does not need the fields only a save uses.
    expect(buildHttpRequest(form({ name: "", intervalValue: "" })).ok).toBe(true);
    expect(errorOf(buildCheckPayload(form({ name: " " }), null, []))).toBe("Name is required.");
  });
});
