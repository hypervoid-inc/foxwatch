import { describe, expect, it, vi } from "vitest";
import { heartbeat, http } from "@foxwatch/config";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const { overdueDelayMs, overdueMonitors } = await import("./scheduler.ts");

describe("overdueMonitors", () => {
  const now = Date.parse("2026-03-01T00:00:00Z");
  const minute = JSON.stringify(http("api", { url: "https://example.com/", interval: "1m" }));
  const daily = JSON.stringify(heartbeat("backup", { interval: "24h" }));

  it("wakes only checks that have no result within their interval", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const overdue = overdueMonitors([
      { id: "on-time", config_json: minute, last_checked: now - 90_000 },
      { id: "late", config_json: minute, last_checked: now - 121_000 },
      { id: "never-ran", config_json: minute, last_checked: null },
      { id: "daily-on-time", config_json: daily, last_checked: now - 23 * 3_600_000 },
      { id: "daily-late", config_json: daily, last_checked: now - 25 * 3_600_000 },
      { id: "broken", config_json: "{", last_checked: null },
    ], now);
    expect(overdue).toEqual([
      { id: "late", intervalMs: 60_000 },
      { id: "never-ran", intervalMs: 60_000 },
      { id: "daily-late", intervalMs: 86_400_000 },
      { id: "broken", intervalMs: 60_000 },
    ]);
    vi.restoreAllMocks();
  });

  it("runs an overdue check within a minute, however long its interval", () => {
    expect(overdueDelayMs(86_400_000, 1)).toBe(60_000);
    expect(overdueDelayMs(86_400_000, 0.5)).toBe(30_000);
    expect(overdueDelayMs(86_400_000, 0)).toBe(1);
    expect(overdueDelayMs(15_000, 1)).toBe(15_000);
  });
});
