import { describe, expect, it } from "vitest";
import { ID_RE, MAX_MONITORS, MIN_INTERVAL_MS } from "@foxwatch/config";
import { sampleMonitors } from "./samples.ts";

describe("sample monitors", () => {
  it("covers operational, slow, and failing httpbingo targets with stable ids", () => {
    const samples = sampleMonitors();
    const ids = samples.map((sample) => sample.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(samples.length).toBeGreaterThanOrEqual(6);
    expect(samples.length).toBeLessThan(MAX_MONITORS);

    for (const sample of samples) {
      expect(sample.id).toMatch(ID_RE);
      expect(sample.id.startsWith("sample-")).toBe(true);
      expect(sample.groupId).toMatch(ID_RE);
      expect(sample.componentId).toMatch(ID_RE);
      expect(sample.check.id).toBe(sample.id);
      expect(sample.check.type).toBe("http");
      if (sample.check.type !== "http") continue;
      expect(sample.check.url.startsWith("https://httpbingo.org/")).toBe(true);
      expect(sample.check.allowedHosts).toEqual(["httpbingo.org"]);
      expect(sample.check.regions).toEqual(["wnam", "enam", "weur", "apac"]);
      expect(sample.check.intervalMs).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
      expect(sample.check.retries).toBe(0);
      expect(sample.check.confirmFails).toBe(1);
    }

    const urls = new Set(samples.map((sample) => (sample.check.type === "http" ? sample.check.url : "")));
    expect(urls.has("https://httpbingo.org/status/200")).toBe(true);
    expect(urls.has("https://httpbingo.org/status/503")).toBe(true);
    expect(urls.has("https://httpbingo.org/status/401")).toBe(true);
    expect(urls.has("https://httpbingo.org/delay/3")).toBe(true);
    expect(urls.has("https://httpbingo.org/delay/8")).toBe(true);
    expect(urls.has("https://httpbingo.org/post")).toBe(true);

    const inference = samples.find((sample) => sample.id === "sample-inference");
    expect(inference?.check.type === "http" && inference.check.degradedIf?.latencyMs).toBe(200);
    const search = samples.find((sample) => sample.id === "sample-search");
    expect(search?.check.type === "http" && search.check.timeoutMs).toBe(2000);
    expect(samples.some((sample) => sample.critical)).toBe(true);
    expect(samples.filter((sample) => sample.groupId === "sample-api").length).toBeGreaterThan(1);
  });
});
