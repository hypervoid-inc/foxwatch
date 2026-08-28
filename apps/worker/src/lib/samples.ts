import { http, type Check, type Region } from "@foxwatch/config";

const HOST = "httpbingo.org";
const ORIGIN = `https://${HOST}`;
const REGIONS: Region[] = ["wnam", "enam", "weur", "apac"];

const HTTP = {
  allowedHosts: [HOST],
  regions: REGIONS,
  interval: "1m" as const,
  retries: 0,
  confirmFails: 1,
  followRedirects: true,
};

export type SampleMonitor = {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  componentId: string;
  componentName: string;
  critical: boolean;
  check: Check;
};

function httpSample(
  id: string,
  name: string,
  group: { id: string; name: string },
  component: { id: string; name: string },
  input: Parameters<typeof http>[1] & { critical?: boolean },
): SampleMonitor {
  const { critical = false, ...checkInput } = input;
  return {
    id,
    name,
    groupId: group.id,
    groupName: group.name,
    componentId: component.id,
    componentName: component.name,
    critical,
    check: http(id, { ...HTTP, timeout: "10s", ...checkInput }),
  };
}

/** Demo checks against httpbingo.org. Stable ids so populate is idempotent. */
export function sampleMonitors(): SampleMonitor[] {
  const website = { id: "sample-website", name: "Website" };
  const api = { id: "sample-api", name: "API" };
  const inference = { id: "sample-inference", name: "Inference Gateway" };
  const search = { id: "sample-search", name: "Search" };
  const auth = { id: "sample-auth", name: "Auth" };

  return [
    httpSample("sample-homepage", "Homepage", website, { id: "sample-homepage", name: "Homepage" }, {
      url: `${ORIGIN}/status/200`,
    }),
    httpSample("sample-api-edge", "Edge", api, { id: "sample-api-edge", name: "Edge" }, {
      url: `${ORIGIN}/status/200`,
    }),
    httpSample("sample-api-payments", "Payments", api, { id: "sample-api-payments", name: "Payments" }, {
      url: `${ORIGIN}/status/503`,
      critical: true,
    }),
    httpSample("sample-api-checkout", "Checkout", api, { id: "sample-api-checkout", name: "Checkout" }, {
      url: `${ORIGIN}/post`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"demo":true}',
    }),
    httpSample("sample-inference", "Inference Gateway", inference, { id: "sample-inference", name: "Inference Gateway" }, {
      url: `${ORIGIN}/delay/3`,
      degradedIf: { latencyMs: 200 },
    }),
    httpSample("sample-search", "Search", search, { id: "sample-search", name: "Search" }, {
      url: `${ORIGIN}/delay/8`,
      timeout: "2s",
    }),
    httpSample("sample-auth", "Login", auth, { id: "sample-auth", name: "Login" }, {
      url: `${ORIGIN}/status/401`,
    }),
  ];
}
