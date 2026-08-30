import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  defineConfig,
  dumpConfig,
  flattenConfig,
  heartbeat,
  http,
  planApply,
  secret,
  configFromYamlLike,
  monitorFromFlat,
  MAX_REGIONS,
  REGIONS,
} from "./index.ts";

const base = () =>
  defineConfig({
    site: { name: "Acme" },
    secrets: ["API_HEALTH_TOKEN"],
    regions: ["wnam", "weur"],
    groups: [
      {
        id: "api",
        name: "API",
        components: [
          {
            id: "health",
            name: "Health",
            checks: [
              http("api-health", {
                url: "https://api.example.com/health",
                headers: { Authorization: secret("API_HEALTH_TOKEN") },
                expect: { status: 200 },
              }),
              heartbeat("api-cron", { interval: "10m" }),
            ],
          },
        ],
      },
    ],
  });

describe("defineConfig", () => {
  it("allows every Cloudflare probe region", () => {
    expect(MAX_REGIONS).toBe(REGIONS.length);
    const cfg = defineConfig({
      site: { name: "Acme" },
      regions: [...REGIONS],
      groups: [
        {
          id: "g",
          name: "G",
          components: [
            {
              id: "c",
              name: "C",
              checks: [http("all-regions", { url: "https://example.com", regions: [...REGIONS] })],
            },
          ],
        },
      ],
    });
    const check = cfg.groups[0]!.components[0]!.checks[0]!;
    expect(check.type).toBe("http");
    if (check.type === "http") expect(check.regions).toEqual([...REGIONS]);
  });

  it("fills defaults and flattens checks", () => {
    const cfg = base();
    const flat = flattenConfig(cfg);
    expect(flat).toHaveLength(2);
    expect(flat[0]!.check.type).toBe("http");
    if (flat[0]!.check.type === "http") {
      expect(flat[0]!.check.allowedHosts).toEqual(["api.example.com"]);
      expect(flat[0]!.check.intervalMs).toBe(60_000);
    }
  });

  it("accepts 4h intervals and 60s timeouts", () => {
    const cfg = defineConfig({
      site: { name: "Acme" },
      groups: [
        {
          id: "g",
          name: "G",
          components: [
            {
              id: "c",
              name: "C",
              checks: [http("slow", { url: "https://example.com", interval: "4h", timeout: "60s" })],
            },
          ],
        },
      ],
    });
    const check = cfg.groups[0]!.components[0]!.checks[0]!;
    expect(check.type).toBe("http");
    if (check.type === "http") {
      expect(check.intervalMs).toBe(14_400_000);
      expect(check.timeoutMs).toBe(60_000);
    }
  });

  it("rejects secrets not on the allowlist", () => {
    expect(() =>
      defineConfig({
        site: { name: "x" },
        secrets: [],
        groups: [
          {
            id: "g",
            name: "G",
            components: [
              {
                id: "c",
                name: "C",
                checks: [
                  http("a", {
                    url: "https://example.com",
                    headers: { Authorization: secret("MISSING") },
                  }),
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/not in config.secrets/);
  });

  it("rejects literal sensitive headers and unsafe retry settings", () => {
    expect(() =>
      defineConfig({
        site: { name: "x" },
        groups: [{ id: "g", name: "G", components: [{ id: "c", name: "C", checks: [http("a", { url: "https://example.com", headers: { Authorization: "Bearer plaintext" } })] }] }],
      }),
    ).toThrow(/must use secret/);
    expect(() =>
      defineConfig({ site: { name: "x" }, defaults: { retries: 8 }, groups: [] }),
    ).toThrow(/retries/);
    expect(() =>
      defineConfig({ site: { name: "x" }, defaults: { timeout: "5s", degradedIf: { latencyMs: 5000 } }, groups: [] }),
    ).toThrow(/degrade-above must be below timeout/);
    expect(() =>
      defineConfig({
        site: { name: "x" },
        groups: [
          {
            id: "g",
            name: "G",
            components: [
              {
                id: "c",
                name: "C",
                checks: [http("a", { url: "https://example.com", timeout: "5s", degradedIf: { latencyMs: 8000 } })],
              },
            ],
          },
        ],
      }),
    ).toThrow(/degrade-above must be below timeout/);
  });

  it("dumps fractional-second timeouts as milliseconds", () => {
    const cfg = defineConfig({
      site: { name: "x" },
      groups: [
        {
          id: "g",
          name: "G",
          components: [{ id: "c", name: "C", checks: [http("a", { url: "https://example.com", timeout: 8500 })] }],
        },
      ],
    });
    const dumped = dumpConfig(cfg) as { groups: Array<{ components: Array<{ checks: Array<{ timeout: string }> }> }> };
    expect(dumped.groups[0]?.components[0]?.checks[0]?.timeout).toBe("8500ms");
  });

  it("defaults the public globe on and can turn it off", () => {
    expect(base().site.globe).toBe(true);
    const off = defineConfig({ site: { name: "Acme", globe: false }, groups: [] });
    expect(off.site.globe).toBe(false);
    const dumped = dumpConfig(off) as { site: { globe: boolean } };
    expect(dumped.site.globe).toBe(false);
    expect(
      configFromYamlLike({ site: { name: "Acme", globe: false }, groups: [] }).site.globe,
    ).toBe(false);
    expect(() => configFromYamlLike({ site: { name: "x", globe: "no" }, groups: [] })).toThrow(/site.globe/);
  });

  it("parses YAML-like secret:NAME headers", () => {
    const cfg = configFromYamlLike({
      site: { name: "Acme" },
      secrets: ["API_HEALTH_TOKEN"],
      groups: [
        {
          id: "api",
          name: "API",
          components: [
            {
              id: "health",
              name: "Health",
              checks: [
                {
                  id: "api-health",
                  type: "http",
                  url: "https://api.example.com/health",
                  headers: { Authorization: "secret:API_HEALTH_TOKEN" },
                },
              ],
            },
          ],
        },
      ],
    });
    const httpCheck = cfg.groups[0]!.components[0]!.checks[0]!;
    expect(httpCheck.type).toBe("http");
  });

  it("parses YAML-like secret:NAME headers from an inline fixture", () => {
    const raw = parse(`
site:
  name: Acme
secrets: [API_HEALTH_TOKEN]
groups:
  - id: api
    name: API
    components:
      - id: health
        name: Health
        checks:
          - id: api-health
            type: http
            url: https://api.example.com/health
            headers:
              Authorization: secret:API_HEALTH_TOKEN
`);
    const cfg = configFromYamlLike(raw);
    expect(cfg.site.name).toBe("Acme");
    expect(flattenConfig(cfg).some((m) => m.id === "api-health")).toBe(true);
  });
});

describe("planApply", () => {
  it("upserts git monitors and leaves ui monitors alone", () => {
    const cfg = base();
    const desired = flattenConfig(cfg).map(monitorFromFlat);
    const current = [
      ...desired,
      {
        id: "ui-only",
        origin: "ui" as const,
        drifted: false,
        type: "http" as const,
        name: "UI",
        groupId: "api",
        groupName: "API",
        componentId: "health",
        componentName: "Health",
        critical: false,
        configJson: "{}",
      },
    ];
    const nextDesired = desired.filter((m) => m.id !== "api-cron");
    const plan = planApply(current, nextDesired);
    expect(plan.remove).toEqual(["api-cron"]);
    expect(current.find((m) => m.id === "ui-only")).toBeTruthy();
    expect(plan.upsert.map((m) => m.id)).toEqual(["api-health"]);
  });

  it("keeps drifted git monitors when asked", () => {
    const desired = flattenConfig(base()).map(monitorFromFlat);
    const current = [{ ...desired[0]!, drifted: true }];
    const plan = planApply(current, [desired[0]!], { keepDrift: true });
    expect(plan.unchanged).toEqual(["api-health"]);
    expect(plan.upsert).toHaveLength(0);
  });
});
